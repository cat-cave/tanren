// The run/spec/task LIFECYCLE de-privilege CUTOVER proof,
// against a REAL Postgres (no SQL mocks). This is the security payoff of the
// wave: with remote-writes ON the data plane writes `runs`/`specs`/`tasks` ONLY
// through the control plane, so migration 0035 DROPS those write grants from the
// `tanren_dataplane` role the `worker` container connects as. A compromised
// runner connecting as that role can no longer force a run/spec/task transition —
// Postgres itself rejects the write.
//
// What this proves under the de-privileged `tanren_dataplane` role (the NEGATIVE
// test is the whole point):
//   (a) a direct, correctly-org-scoped UPDATE runs (the `running` transition) is
//       REJECTED with `permission denied for table runs` (42501) — the grant is
//       GONE, not merely RLS-filtered (RLS would yield a row-violation, NOT a
//       privilege error; we assert the privilege error specifically);
//   (b) a direct UPDATE specs (`in_flight`) is likewise REJECTED;
//   (c) a direct INSERT INTO tasks (the subtask/CI/review/merge lifecycle row) is
//       likewise REJECTED — and a direct UPDATE tasks too;
//   (d) the role STILL SELECTs all three tables (the worker reads runs/tasks to
//       drive the loop + load context, the dashboard reads them) — we dropped
//       only the writes, not the reads;
//   (e) for contrast, the write-capable control-plane role (`tanren_app`) CAN run
//       the SAME run/spec/task writes under the same scope — so the deny is
//       specific to the de-privileged data-plane role, NOT the table or the
//       policy. This is the write the control plane's `/internal/*` lifecycle
//       endpoints perform server-side, so the run lifecycle still works through
//       the control plane.
//
// APEX v34 — the FOUR worker write paths that hit `permission denied` on a live run
// because they wrote `runs`/`events`/`specs` DIRECTLY instead of routing through the
// control-plane remote-write seam (now fixed to route through the writer):
//   (f) the subtask-accounting `runs.auth_ref` stamp — DENIED direct; SUCCEEDS via
//       `applySetRunAuthRef` under the control-plane role (the `/internal/set-run-auth-ref`
//       endpoint runs this server-side);
//   (g) the jj-local-bootstrap `runs.ancestor_stack` head-sha write-back + the
//       speculative-retarget head-drop — DENIED direct; SUCCEED via the SAME
//       `setRunSpeculativeBase` UPDATE under the control-plane role;
//   (h) THE FATAL ONE — the durable merge-LAND finalize (`merge.completed` event +
//       the spec `merged` flip) — DENIED direct on BOTH `events` and `specs`; SUCCEEDS
//       atomically via `applyFinalizeLand` under the control-plane role (the
//       `/internal/finalize-land` endpoint), so a worker running as `tanren_dataplane`
//       can complete a tier-3 merge WITHOUT a `permission denied`.
//
// Gated behind TANREN_RLS_DB_TEST=1 + an owner/superuser DATABASE_URL (the
// migration role), exactly like the RLS cohort + P3a/P3b tests. Wired into
// `just smoke` via `just smoke-plane-split-p3c`.

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { applySetRunAuthRef } from "../src/engine/worker/runStateLifecycleSql.js";
import { applyFinalizeLand } from "../src/engine/merge/mergeAuthorityLandFinalizer.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const DATAPLANE_ROLE = "tanren_dataplane";
const DATAPLANE_PASSWORD = process.env["TANREN_DATAPLANE_DB_PASSWORD"] ?? "tanren_dataplane";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_p3c_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
function withRole(url: string, role: string, password: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = password;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const ORG = "org_p3c";
const PROJECT = `proj_${ORG}`;
const SPEC = `spec_${ORG}`;
const RUN = `run_${ORG}`;
const TASK = `task_${ORG}`;
// in-16: the authorizing decision the land finalize records its delivery-outbox row
// against. This test drives `applyFinalizeLand` directly (not the full authority
// protocol), so the FK'd decision row must be seeded; the id mirrors the finalizer's
// deterministic `decision-<subject.id>-<headSha>` convention.
const NODE = `node_${ORG}`;
const HEAD_SHA = "a".repeat(40);
const DECISION = `decision-${NODE}-${HEAD_SHA}`;

// Run `body` inside an org-scoped transaction on the given role's pool, mirroring
// the worker's `runWithOrgScope` (SET LOCAL app.current_org_id). So a rejected
// write below is rejected for the PRIVILEGE, not for a missing org scope — the
// scope is correct; the grant is what is gone.
async function inOrgScope<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [ORG]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

describeDb("plane-split P3c — the de-privileged run/spec/task lifecycle writes (real PG)", () => {
  const database = dbName();
  let ownerPool: Pool;
  let dataPlanePool: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    // The REAL migration set creates `tanren_dataplane` (0031) and drops its
    // run/spec/task WRITE grants (0035), on top of the RLS policies (0030).
    await migrate(ownerPool);

    dataPlanePool = new Pool({ connectionString: withRole(ADMIN_URL, DATAPLANE_ROLE, DATAPLANE_PASSWORD, database) });
    appPool = new Pool({ connectionString: withRole(ADMIN_URL, APP_ROLE, APP_PASSWORD, database) });

    // Seed one org's run/spec/task as the OWNER (bypasses RLS as table owner).
    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [ORG],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id)
       VALUES ($1, 'p', 'https://example.com/r.git', $2)`,
      [PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, 't', 'd', 'in_flight')`,
      [SPEC, PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'cli', 'main', 'queued')`,
      [RUN, SPEC, PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
       VALUES ($1, $2, $3, 'plan', 'plan', 'queued', 'answerer', 'fake', 'm')`,
      [TASK, RUN, ORG],
    );
    // in-16: seed the authority_decisions row the land's delivery-outbox row FK's to, so
    // the finalize in (h) commits (its INSERT INTO delivery_runs resolves the decision).
    await ownerPool.query(
      `INSERT INTO authority_decisions
         (org_id, project_id, id, integration_node_id, subject_kind, head_sha, expected_main_sha,
          artifact_digest, proof_root, member_set_hash, policy_version, decision)
       VALUES ($1, $2, $3, $4, 'integration_node', $5, $6, $7, $8, 'mk', 'pv', 'authorized')`,
      [ORG, PROJECT, DECISION, NODE, HEAD_SHA, "b".repeat(40), `sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`],
    );
  }, 60_000);

  afterAll(async () => {
    await dataPlanePool?.end();
    await appPool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  // (a) THE CORE NEGATIVE TEST: a direct, correctly-org-scoped `running`
  // transition by the data-plane role is rejected for lack of the privilege
  // (42501 / "permission denied for table runs") — the grant is actually gone.
  it("(a) REJECTS a direct UPDATE runs (the running transition) by the data-plane role", async () => {
    await expect(
      inOrgScope(dataPlanePool, (client) =>
        client.query("UPDATE runs SET status = 'running', started_at = now() WHERE run_id = $1", [RUN]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // And nothing moved (owner read bypasses RLS).
    const still = await ownerPool.query("SELECT status FROM runs WHERE run_id = $1", [RUN]);
    expect(still.rows[0]).toMatchObject({ status: "queued" });
  });

  // (a2) The AUTONOMY-LOOP create path: a direct `INSERT INTO runs` (the DagWalker /
  // merge-conflict-reexec / intake run-CREATE) by the data-plane role is rejected for
  // the privilege too — the grant is gone, so the loop MUST route createQueuedRun
  // through the control plane's `/internal/create-queued-run`.
  it("(a2) REJECTS a direct INSERT INTO runs (the autonomy-loop run-CREATE) by the data-plane role", async () => {
    await expect(
      inOrgScope(dataPlanePool, (client) =>
        client.query(
          `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
           VALUES ($1, $2, $3, $4, 'dag_walker', 'b', 'queued')`,
          [`${RUN}_walk`, SPEC, PROJECT, ORG],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  // (b) Same de-privilege on the spec status move (`in_flight`).
  it("(b) REJECTS a direct UPDATE specs (in_flight) by the data-plane role", async () => {
    await expect(
      inOrgScope(dataPlanePool, (client) =>
        client.query("UPDATE specs SET status = 'in_flight' WHERE spec_id = $1", [SPEC]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  // (c) Same de-privilege on the tasks INSERT (a new lifecycle row) AND UPDATE.
  it("(c) REJECTS a direct INSERT/UPDATE tasks by the data-plane role", async () => {
    await expect(
      inOrgScope(dataPlanePool, (client) =>
        client.query(
          `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
           VALUES ($1, $2, $3, 'write', 'w', 'running', 'writer', 'fake', NULL)`,
          [`${TASK}_child`, RUN, ORG],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      inOrgScope(dataPlanePool, (client) =>
        client.query("UPDATE tasks SET status = 'done', outcome = 'ok', ended_at = now() WHERE task_id = $1", [TASK]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  // (d) The role KEEPS the SELECT on all three (the worker reads runs/tasks to
  // drive the loop + load context; the dashboard reads them) — reads not dropped.
  it("(d) ALLOWS the data-plane role to SELECT runs + specs + tasks (reads kept)", async () => {
    await inOrgScope(dataPlanePool, async (client) => {
      await expect(client.query("SELECT count(*)::int AS n FROM runs WHERE run_id = $1", [RUN])).resolves.toMatchObject(
        {
          rows: [{ n: 1 }],
        },
      );
      await expect(
        client.query("SELECT count(*)::int AS n FROM specs WHERE spec_id = $1", [SPEC]),
      ).resolves.toMatchObject({ rows: [{ n: 1 }] });
      await expect(
        client.query("SELECT count(*)::int AS n FROM tasks WHERE task_id = $1", [TASK]),
      ).resolves.toMatchObject({ rows: [{ n: 1 }] });
    });
  });

  // (e) Contrast: the write-capable control-plane role (tanren_app) CAN run the
  // SAME run/spec/task writes under the same scope — so the denies above are the
  // data-plane role's dropped grants, NOT the tables or the policy. These are the
  // exact writes the control plane's `/internal/*` lifecycle endpoints perform
  // server-side, so the run lifecycle STILL works through the control plane.
  it("(e) the control-plane tanren_app role CAN run the same run/spec/task writes (contrast)", async () => {
    await inOrgScope(appPool, async (client) => {
      const run = await client.query("UPDATE runs SET status = 'running', started_at = now() WHERE run_id = $1", [RUN]);
      expect(run.rowCount).toBe(1);
      const spec = await client.query("UPDATE specs SET status = 'in_flight' WHERE spec_id = $1", [SPEC]);
      expect(spec.rowCount).toBe(1);
      const task = await client.query(
        `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
         VALUES ($1, $2, $3, 'write', 'w', 'running', 'writer', 'fake', NULL)`,
        [`${TASK}_app`, RUN, ORG],
      );
      expect(task.rowCount).toBe(1);
    });
    // The control-plane writes landed (owner read bypasses RLS).
    const moved = await ownerPool.query("SELECT status FROM runs WHERE run_id = $1", [RUN]);
    expect(moved.rows[0]).toMatchObject({ status: "running" });
  });

  // (f) APEX v34 — the subtask-accounting `runs.auth_ref` stamp. A direct UPDATE by the
  // data-plane role is REJECTED (the live "failed to stamp runs.auth_ref ... permission
  // denied for table runs"); the SAME stamp via `applySetRunAuthRef` under the
  // control-plane role SUCCEEDS — so it MUST route through the control plane.
  it("(f) REJECTS a direct runs.auth_ref stamp by the data-plane role; the control plane CAN", async () => {
    await expect(
      inOrgScope(dataPlanePool, (client) =>
        client.query("UPDATE runs SET auth_ref = $2 WHERE run_id = $1 AND auth_ref IS DISTINCT FROM $2", [
          RUN,
          "auth_creds_v1",
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // The control-plane applier (what `/internal/set-run-auth-ref` runs server-side) lands.
    await inOrgScope(appPool, (client) => applySetRunAuthRef(client, { runId: RUN, authRef: "auth_creds_v1" }));
    const stamped = await ownerPool.query("SELECT auth_ref FROM runs WHERE run_id = $1", [RUN]);
    expect(stamped.rows[0]).toMatchObject({ auth_ref: "auth_creds_v1" });
  });

  // (g) APEX v34 — the jj-local-bootstrap head-sha write-back + the speculative retarget
  // head-drop both `UPDATE runs SET ancestor_stack`. A direct write by the data-plane role
  // is REJECTED (the live "bootstrap ancestor_stack head-sha write-back failed ...
  // permission denied for table runs"); the SAME UPDATE under the control-plane role
  // SUCCEEDS — so both route through `setRunSpeculativeBase`.
  it("(g) REJECTS a direct runs.ancestor_stack write-back by the data-plane role; the control plane CAN", async () => {
    const stack = JSON.stringify([{ specId: "s_a", runId: "r_a", branch: "b_a", headSha: "f".repeat(40) }]);
    await expect(
      inOrgScope(dataPlanePool, (client) =>
        client.query("UPDATE runs SET ancestor_stack = $2::jsonb WHERE run_id = $1", [RUN, stack]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // The control-plane UPDATE (what `setRunSpeculativeBase` runs server-side) lands.
    await inOrgScope(appPool, (client) =>
      client.query("UPDATE runs SET ancestor_stack = $2::jsonb WHERE run_id = $1", [RUN, stack]),
    );
    const written = await ownerPool.query("SELECT ancestor_stack FROM runs WHERE run_id = $1", [RUN]);
    expect((written.rows[0] as { ancestor_stack: unknown[] }).ancestor_stack).toHaveLength(1);
  });

  // (h) APEX v34 — THE FATAL ONE: the durable merge-LAND finalize (`merge.completed`
  // event + the guarded spec `merged` flip). The data-plane role can write NEITHER
  // `events` nor `specs`, so a direct land transaction is REJECTED — the tier-3 merge
  // strands. The SAME transaction via `applyFinalizeLand` under the control-plane role
  // SUCCEEDS, landing BOTH writes atomically — so a worker as `tanren_dataplane` can
  // complete a tier-3 merge by routing the finalize through `/internal/finalize-land`.
  it("(h) REJECTS the direct merge-LAND finalize (events + specs) by the data-plane role; the control plane lands it", async () => {
    // The two component writes the land transaction performs, each rejected directly.
    await expect(
      inOrgScope(dataPlanePool, (client) =>
        client.query(
          `INSERT INTO events (run_id, spec_id, project_id, org_id, event_type, payload)
           VALUES ($1, $2, $3, $4, 'merge.completed', '{}'::jsonb)`,
          [RUN, SPEC, PROJECT, ORG],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      inOrgScope(dataPlanePool, (client) =>
        client.query("UPDATE specs SET status = 'merged' WHERE spec_id = $1 AND status <> 'merged'", [SPEC]),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    // The control-plane finalize (what `/internal/finalize-land` runs server-side) lands
    // `merge.completed` + the spec `merged` flip together — the tier-3 land completes. Use
    // the real `runWithOrgScope` (the endpoint's exact wrapper) so the PgEventStore append
    // resolves its ambient org-scoped client, then RLS admits the org's own rows.
    await runWithOrgScope(appPool, ORG, (client) =>
      applyFinalizeLand(client, {
        orgId: ORG,
        runId: RUN,
        specId: SPEC,
        projectId: PROJECT,
        taskId: TASK,
        prUrl: "https://example.com/r/pull/1",
        prNumber: 1,
        integration: "native_queue",
        mergeSha: "c".repeat(40),
        authorityDecisionId: DECISION,
        auditEnvelope: { policyVersion: 1 },
      }),
    );
    const landed = await ownerPool.query(
      `SELECT (SELECT status FROM specs WHERE spec_id = $1) AS spec_status,
              (SELECT count(*)::int FROM events WHERE run_id = $2 AND event_type = 'merge.completed') AS merge_events`,
      [SPEC, RUN],
    );
    expect(landed.rows[0]).toMatchObject({ spec_status: "merged", merge_events: 1 });
  });
});
