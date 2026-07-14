// Real-PG regression for the PR #724 follow-up atomicity fix + orphan-PR sweep
// (apex v67/v69 root cause #2).
//
// THE BUG PR #724 LEFT BEHIND: the early-path enqueue split the 3 post-PR-open writes
// (github.pr.created append, merge_queue INSERT, merge.scheduled append) across THREE
// independent transactions. A crash / pool blip / network glitch between any two
// reproduced the original orphan-PR bug: the durable PR event said "PR created" but the
// merge_queue row never landed, so the coordinator's startup discovery
// (LIST_PROJECTS_WITH_QUEUE_SQL) — which only enumerates projects that ALREADY have
// queue rows — never picked the orphan up. The autonomous loop never closed.
//
// THE FIX: the writer-seam now opens ONE runWithOrgScope and does all 3 writes inside
// it; the coordinator subscriber's boot path also runs a one-shot `discoverOrphanedPrs`
// sweep that catches any orphan that pre-existed the fix (or somehow escapes it).
//
// THIS TEST VERIFIES BOTH UNDER REAL POSTGRES:
//   1. Atomicity: a thrown error mid-block rolls back the github.pr.created event AND
//      leaves no merge_queue row (BOTH or NEITHER, never one without the other — the
//      exact split-brain PR #724 left open).
//   2. Sweep: a pre-seeded orphan (durable github.pr.created event + no merge_queue
//      row) gets a merge_queue row inserted + a merge.scheduled event appended.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, resetSystemPool, runWithOrgScope, setSystemPool } from "@tanren/db";
import { PgEventStore } from "../src/engine/eventStore.js";
import { applyRecordDraftPrCreated } from "../src/engine/merge/draftPrCreatedAtomic.js";
import { PgMergeQueueModel } from "../src/engine/merge/coordinatorPg.js";
import { discoverOrphanedPrs } from "../src/engine/merge/orphanedPrSweep.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const DATAPLANE_ROLE = "tanren_dataplane";
const DATAPLANE_PASSWORD = process.env["TANREN_DATAPLANE_DB_PASSWORD"] ?? "tanren_dataplane";
const SYSTEM_ROLE = "tanren_system";
const SYSTEM_PASSWORD = process.env["TANREN_SYSTEM_DB_PASSWORD"] ?? "tanren_system";

function dbName(): string {
  return `tanren_mq_atomic_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

const ORG = "org_mq_atomic";
const PROJECT = `project_${ORG}`;

describeDb("merge_queue 3-write atomicity + orphaned-PR sweep (real PG)", () => {
  const database = dbName();
  let ownerPool: Pool;
  let dataPlanePool: Pool;
  let systemPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);

    dataPlanePool = new Pool({ connectionString: withRole(ADMIN_URL, DATAPLANE_ROLE, DATAPLANE_PASSWORD, database) });
    systemPool = new Pool({ connectionString: withRole(ADMIN_URL, SYSTEM_ROLE, SYSTEM_PASSWORD, database) });
    setSystemPool(systemPool);

    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [ORG],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id, config)
       VALUES ($1, 'p', 'https://github.com/acme/native-queue-fixture.git', $2, $3::jsonb)`,
      [PROJECT, ORG, JSON.stringify({ mergeIntegration: "native_queue" })],
    );
  }, 60_000);

  afterAll(async () => {
    resetSystemPool();
    await dataPlanePool?.end();
    await systemPool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("ATOMICITY: a throw mid-block rolls BOTH the github.pr.created event AND the merge_queue INSERT", async () => {
    const spec = "spec_atomicity_rollback";
    const run = "run_atomicity_rollback";
    const prUrl = "https://github.com/cat-cave/repo/pull/1001";
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, 'atom', 'atomicity rollback', 'in_flight')`,
      [spec, PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'ci', 'main', 'completed')`,
      [run, spec, PROJECT, ORG],
    );

    const model = new PgMergeQueueModel(ownerPool);

    // Drive the SAME 3-write block the production seam runs, but THROW after step 2 (the
    // INSERT) — before merge.scheduled would append. The whole runWithOrgScope must roll
    // back: github.pr.created must NOT be visible, the merge_queue row must NOT exist,
    // and merge.scheduled must NOT be present.
    await expect(
      runWithOrgScope(ownerPool, ORG, async (client) => {
        const store = new PgEventStore(client);
        await store.append({
          runId: run,
          specId: spec,
          projectId: PROJECT,
          orgId: ORG,
          eventType: "github.pr.created",
          payload: {
            repoUrl: "https://github.com/acme/x.git",
            branch: "tanren/run_atomicity_rollback",
            targetBranch: "main",
            prUrl,
            prNumber: 1001,
          },
        });
        await model.enqueueOnClient(client, ORG, {
          projectId: PROJECT,
          runId: run,
          specId: spec,
          prUrl,
          prNumber: 1001,
        });
        // Simulate the crash/pool blip BETWEEN the merge_queue INSERT and the
        // merge.scheduled append — exactly the seam between PR #724's transactions #2 and #3.
        throw new Error("simulated mid-block failure");
      }),
    ).rejects.toThrow("simulated mid-block failure");

    // Everything rolled back.
    const events = await ownerPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM events WHERE run_id = $1 AND event_type IN ('github.pr.created','merge.scheduled')",
      [run],
    );
    expect(events.rows[0]?.count).toBe("0");
    const queue = await ownerPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM merge_queue WHERE run_id = $1",
      [run],
    );
    expect(queue.rows[0]?.count).toBe("0");
  });

  it("ATOMICITY: a successful 3-write block commits ALL THREE as one unit", async () => {
    const spec = "spec_atomicity_commit";
    const run = "run_atomicity_commit";
    const prUrl = "https://github.com/cat-cave/repo/pull/1002";
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, 'atom', 'atomicity commit', 'in_flight')`,
      [spec, PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'ci', 'main', 'completed')`,
      [run, spec, PROJECT, ORG],
    );

    // Drive the PRODUCTION applier (the same function Direct/Http + the control-plane
    // endpoint call) so this test pins the real path, not a re-implemented 3-write copy.
    const { created } = await runWithOrgScope(ownerPool, ORG, (client) =>
      applyRecordDraftPrCreated(client, {
        orgId: ORG,
        runId: run,
        specId: spec,
        projectId: PROJECT,
        repoUrl: "https://github.com/acme/x.git",
        branch: "tanren/run_atomicity_commit",
        baseBranch: "main",
        prUrl,
        prNumber: 1002,
      }),
    );
    expect(created).toBe(true);

    const events = await ownerPool.query<{ event_type: string }>(
      "SELECT event_type FROM events WHERE run_id = $1 ORDER BY ts, id",
      [run],
    );
    expect(events.rows.map((r) => r.event_type)).toEqual(["github.pr.created", "merge.scheduled"]);
    const queue = await ownerPool.query<{ status: string; pr_url: string; org_id: string }>(
      "SELECT status, pr_url, org_id FROM merge_queue WHERE run_id = $1",
      [run],
    );
    expect(queue.rows).toEqual([{ status: "queued", pr_url: prUrl, org_id: ORG }]);
  });

  it("SWEEP: pre-seeded orphan (event + no queue row) recovers — INSERTs merge_queue + appends merge.scheduled", async () => {
    const spec = "spec_orphan_recover";
    const run = "run_orphan_recover";
    const prUrl = "https://github.com/cat-cave/repo/pull/2001";
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, 'sweep', 'orphan sweep recover', 'in_flight')`,
      [spec, PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'ci', 'main', 'completed')`,
      [run, spec, PROJECT, ORG],
    );
    // Seed the durable github.pr.created event WITHOUT a merge_queue row — exactly the
    // post-PR #724 orphan state (event landed in txn #1 but the queue INSERT in txn #2
    // never reached COMMIT). The sweep is responsible for noticing + recovering.
    await runWithOrgScope(ownerPool, ORG, async (client) => {
      await new PgEventStore(client).append({
        runId: run,
        specId: spec,
        projectId: PROJECT,
        orgId: ORG,
        eventType: "github.pr.created",
        payload: {
          repoUrl: "https://github.com/acme/x.git",
          branch: "tanren/run_orphan_recover",
          targetBranch: "main",
          prUrl,
          prNumber: 2001,
        },
      });
    });
    // Pre-condition: orphan exists, no queue row.
    const preQueue = await ownerPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM merge_queue WHERE run_id = $1",
      [run],
    );
    expect(preQueue.rows[0]?.count).toBe("0");

    const result = await discoverOrphanedPrs(ownerPool);
    expect(result.discovered).toBeGreaterThanOrEqual(1);
    expect(result.recovered).toBeGreaterThanOrEqual(1);

    const queue = await ownerPool.query<{ status: string; pr_url: string; pr_number: string; org_id: string }>(
      "SELECT status, pr_url, pr_number, org_id FROM merge_queue WHERE run_id = $1",
      [run],
    );
    expect(queue.rows).toEqual([{ status: "queued", pr_url: prUrl, pr_number: "2001", org_id: ORG }]);

    const scheduled = await ownerPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM events WHERE run_id = $1 AND event_type = 'merge.scheduled'",
      [run],
    );
    expect(scheduled.rows[0]?.count).toBe("1");
  });

  it("SWEEP under the DATAPLANE role (apex v95 regression): recovery routes writes through the system scope, not the SELECT-only runtime pool", async () => {
    // apex v95 root cause: the coordinator subscriber runs in the worker, whose runtime
    // pool connects as the NARROW `tanren_dataplane` role — SELECT-only on `events`. The
    // OTHER sweep tests drive `discoverOrphanedPrs(ownerPool)` (superuser), which hid the
    // bug: recovery ran `runWithOrgScope(dataplanePool, …)`, the merge_queue INSERT
    // passed but the `events` append raised `permission denied for table events`, rolling
    // back the WHOLE recovery — so no dequeued/orphaned PR ever recovered in production.
    //
    // This test drives the sweep on the ACTUAL runtime pool (`dataPlanePool`). The fix
    // routes the per-orphan recovery through `runWithSystemScope` (the injected BYPASSRLS
    // `tanren_system` pool), so it lands despite the handed-in dataplane pool. Under the
    // pre-fix `runWithOrgScope(pool, …)` this asserts `recovered >= 1` would FAIL:
    // recovery would throw permission-denied and `recovered` would be 0.
    const spec = "spec_orphan_dataplane";
    const run = "run_orphan_dataplane";
    const prUrl = "https://github.com/cat-cave/repo/pull/2003";
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, 'sweep', 'orphan sweep dataplane', 'in_flight')`,
      [spec, PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'ci', 'main', 'completed')`,
      [run, spec, PROJECT, ORG],
    );
    await runWithOrgScope(ownerPool, ORG, async (client) => {
      await new PgEventStore(client).append({
        runId: run,
        specId: spec,
        projectId: PROJECT,
        orgId: ORG,
        eventType: "github.pr.created",
        payload: {
          repoUrl: "https://github.com/acme/x.git",
          branch: "tanren/run_orphan_dataplane",
          targetBranch: "main",
          prUrl,
          prNumber: 2003,
        },
      });
    });

    // Drive the sweep on the SELECT-only runtime pool — exactly what the worker hands it.
    const result = await discoverOrphanedPrs(dataPlanePool);
    expect(result.recovered).toBeGreaterThanOrEqual(1);

    const queue = await ownerPool.query<{ status: string; pr_url: string; pr_number: string; org_id: string }>(
      "SELECT status, pr_url, pr_number, org_id FROM merge_queue WHERE run_id = $1",
      [run],
    );
    expect(queue.rows).toEqual([{ status: "queued", pr_url: prUrl, pr_number: "2003", org_id: ORG }]);
    const scheduled = await ownerPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM events WHERE run_id = $1 AND event_type = 'merge.scheduled'",
      [run],
    );
    expect(scheduled.rows[0]?.count).toBe("1");
  });

  it("SWEEP: idempotent — a run that already has a queue row is left alone (no duplicate INSERT, no extra merge.scheduled)", async () => {
    const spec = "spec_orphan_idempotent";
    const run = "run_orphan_idempotent";
    const prUrl = "https://github.com/cat-cave/repo/pull/2002";
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, 'sweep', 'orphan sweep idempotent', 'in_flight')`,
      [spec, PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'ci', 'main', 'completed')`,
      [run, spec, PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO merge_queue (queue_id, run_id, spec_id, project_id, org_id, status, pr_url, pr_number)
       VALUES ($1, $2, $3, $4, $5, 'queued', $6, '2002')`,
      [`mq_${run}`, run, spec, PROJECT, ORG, prUrl],
    );
    await runWithOrgScope(ownerPool, ORG, async (client) => {
      await new PgEventStore(client).append({
        runId: run,
        specId: spec,
        projectId: PROJECT,
        orgId: ORG,
        eventType: "github.pr.created",
        payload: {
          repoUrl: "https://github.com/acme/x.git",
          branch: "tanren/run_orphan_idempotent",
          targetBranch: "main",
          prUrl,
          prNumber: 2002,
        },
      });
    });

    const before = await ownerPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM events WHERE run_id = $1 AND event_type = 'merge.scheduled'",
      [run],
    );
    await discoverOrphanedPrs(ownerPool);
    // No new merge_queue row, no merge.scheduled emitted.
    const queue = await ownerPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM merge_queue WHERE run_id = $1",
      [run],
    );
    expect(queue.rows[0]?.count).toBe("1");
    const after = await ownerPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM events WHERE run_id = $1 AND event_type = 'merge.scheduled'",
      [run],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
