// RLS wave R3a — the RESIDUAL tenant-table sites flagged during cohort-4, now
// routed through R1's org-scoped client, proven against a REAL Postgres (no SQL
// mocks). These are the last conversion sites before R3b (policy enable + role
// flip).
//
// R3a converts the three cohort-4-flagged residuals:
//   (1) the forge READ-tool dispatcher (`tanrenReadSpec`/`tanrenReadRun`/
//       `tanrenReadEvents`/`tanrenReadCosts`/…) — its spec/run/events/cost reads
//       + the `assert*Access` gates now route through `resolveQueryClient`, so a
//       caller inside `runWithOrgScope` reads on the ambient org-scoped client;
//   (2) the forge WRITE-tool dispatcher (`tanrenRerunTask` lookup +
//       `tanrenCreateSpec` entity links) — routes through `resolveWritableClient`;
//   (3) `engine/recovery`'s `openInspectionThread` — used to write a
//       `forge_threads` row with NO org context; now runs the thread-create +
//       lineage-event append in ONE org-scoped txn, so `forge_threads.org_id`
//       carries the org;
//   plus the insights-cache read inside the forge narration generator, which now
//   runs on the scoped client (`loadInsightsForProject` reads runs/events/specs/
//   tasks/cost_records under org context and writes the workflow_insights cache).
//
// (Updated for R3b: the migration now ENABLES the policies — the scoped dispatch
// returns the org's rows while the SAME dispatch on the raw pool is denied, and
// case (d) is now the ENFORCEMENT proof that a cross-org read returns zero at the
// DB.) These tests prove end-to-end: the scoped dispatch returns the org's rows,
// the in-scope writes are visible inside the SAME transaction (proving the
// ambient client was used), `openInspectionThread` stamps `forge_threads.org_id`,
// and the cross-tenant read is now DENIED.
//
// Gated behind TANREN_RLS_DB_TEST=1 + a superuser DATABASE_URL (the migration
// owner), exactly like the R1 / R2 cohort tests. Wired into `just smoke` via
// `just smoke-rls-r3a`.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { PgEventStore } from "../src/engine/eventStore.js";
import { openInspectionThread, type HaltedRunContext } from "../src/engine/recovery/index.js";
import { tanrenReadCosts, tanrenReadEvents, tanrenReadRun, tanrenReadSpec } from "../src/engine/forge/tools/read.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_rls_r3a_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function runtimeUrl(adminUrl: string, database: string): string {
  const parsed = new URL(adminUrl);
  parsed.username = RUNTIME_ROLE;
  parsed.password = RUNTIME_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const ORG_A = "org_rls_a";
const ORG_B = "org_rls_b";
const PROJECT_A = `proj_${ORG_A}`;
const PROJECT_B = `proj_${ORG_B}`;
const SPEC_A = `spec_${ORG_A}`;
const RUN_A = "run_a";
const RUN_B = "run_b";

// A platform-admin actor so the forge-tool authz gates short-circuit without a
// project_members/users row — these tests prove the DAL seam, not authz.
const ACTOR = {
  userId: "user_a",
  orgId: null,
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
} as const;

describeDb("RLS R3a — residual forge-tool + recovery sites through the org-scoped client", () => {
  const database = dbName();
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);

    runtimePool = new Pool({ connectionString: runtimeUrl(ADMIN_URL, database) });

    await seedTenant(ownerPool, ORG_A, PROJECT_A, SPEC_A, RUN_A);
    await seedTenant(ownerPool, ORG_B, PROJECT_B, `spec_${ORG_B}`, RUN_B);
  }, 60_000);

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  // (a) the forge read-spec / read-run dispatchers, run inside an org scope,
  //     return the org's rows. Under R3b the SAME dispatch on the raw pool (no
  //     scope) is denied — its authz/read sees zero rows → "not found".
  it("(a) forge read_spec/read_run via the org scope return the org's rows; the raw pool is denied", async () => {
    const scopedSpec = await runWithOrgScope(runtimePool, ORG_A, () =>
      tanrenReadSpec({ pool: runtimePool }, { specId: SPEC_A }, ACTOR),
    );
    expect(scopedSpec.spec["spec_id"]).toBe(SPEC_A);
    // No ambient scope (empty GUC) → the dispatcher's reads see nothing.
    await expect(tanrenReadSpec({ pool: runtimePool }, { specId: SPEC_A }, ACTOR)).rejects.toThrow(/not found|denied/i);

    const scopedRun = await runWithOrgScope(runtimePool, ORG_A, () =>
      tanrenReadRun({ pool: runtimePool }, { runId: RUN_A }, ACTOR),
    );
    expect(scopedRun.run["run_id"]).toBe(RUN_A);
    await expect(tanrenReadRun({ pool: runtimePool }, { runId: RUN_A }, ACTOR)).rejects.toThrow(/not found|denied/i);
  });

  // (b) read_events / read_costs run on the ambient scoped client: a row WRITTEN
  //     inside the same scope's transaction is visible to the read (proving the
  //     dispatcher used the ambient client, not a fresh pool checkout).
  it("(b) read_events/read_costs see same-transaction writes via the ambient scope", async () => {
    const events = await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      // Write the event through the event store (single-event-writer invariant);
      // handed the scoped client it appends on the ambient org transaction.
      await new PgEventStore(client).append({
        runId: RUN_A,
        specId: SPEC_A,
        projectId: PROJECT_A,
        eventType: "run.started",
        payload: { status: "running" },
      });
      return tanrenReadEvents({ pool: runtimePool }, { runId: RUN_A }, ACTOR);
    });
    expect(events.events.length).toBeGreaterThan(0);
    expect(events.events.every((e) => e.runId === RUN_A)).toBe(true);

    // cost_records.task_id is a NOT NULL FK to tasks; seed a task first (owner).
    await ownerPool.query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
       VALUES ($1, $2, $3, 'plan', 'plan', 'queued', 'answerer', 'fake', 'm')`,
      [`task_${ORG_A}`, RUN_A, ORG_A],
    );
    const costs = await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      await client.query(
        `INSERT INTO cost_records
           (task_id, run_id, project_id, org_id, cli, provider, model,
            total_tokens, cost_usd, billing_mode, cost_basis)
         VALUES ($1, $2, $3, $4, 'fake', 'fake', 'm', 10, '0.10', 'per_token', 'provider_pricing')`,
        [`task_${ORG_A}`, RUN_A, PROJECT_A, ORG_A],
      );
      return tanrenReadCosts({ pool: runtimePool }, { runId: RUN_A }, ACTOR);
    });
    expect(Number(costs.totalUsd)).toBeGreaterThan(0);
  });

  // (c) the flagged residual: openInspectionThread writes a forge_threads row
  //     that carries org_id (it ran on the pool with no org context before R3a).
  it("(c) openInspectionThread stamps forge_threads.org_id", async () => {
    const ctx: HaltedRunContext = {
      runId: RUN_A,
      specId: SPEC_A,
      projectId: PROJECT_A,
      status: "halted",
      outcome: "halted",
      lastGoodCommit: null,
    };
    const result = await openInspectionThread(runtimePool, ctx, ORG_A, ACTOR);
    const row = await ownerPool.query<{ org_id: string; run_id: string }>(
      "SELECT org_id, run_id FROM forge_threads WHERE id = $1",
      [result.threadId],
    );
    expect(row.rows[0]?.org_id).toBe(ORG_A);
    expect(row.rows[0]?.run_id).toBe(RUN_A);
    // The lineage event was appended in the SAME org-scoped txn and carries org_id.
    const ev = await ownerPool.query<{ org_id: string }>(
      "SELECT org_id FROM events WHERE run_id = $1 AND event_type = 'recovery.inspection_opened'",
      [RUN_A],
    );
    expect(ev.rows[0]?.org_id).toBe(ORG_A);
  });

  // (d) ENFORCEMENT proof (R3b): with the policies now ENABLED, org A's scope
  //     reading org B's run returns ZERO rows AT THE DATABASE — the cross-tenant
  //     leak that was inert under R3a is now impossible. (Pre-R3b this asserted
  //     the cross-org read still succeeded; the enforcement flip ends that.)
  it("(d) is ENFORCED: org A's scope cannot read org B's run (cross-tenant denied)", async () => {
    await expect(
      runWithOrgScope(runtimePool, ORG_A, () => tanrenReadRun({ pool: runtimePool }, { runId: RUN_B }, ACTOR)),
    ).rejects.toThrow(/not found|denied/i);
  });
});

// Seed an org + project + spec + run for a tenant, as the owner pool. Mirrors the
// cohort tests' seeder; kept local so the waves stay independent.
async function seedTenant(owner: Pool, orgId: string, projectId: string, specId: string, runId: string): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name)
     VALUES ($1, 'oidc', $1, $1, $1)`,
    [orgId],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, 'p', 'https://example.com/r.git', $2)`,
    [projectId, orgId],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, 't', 'd', 'pending')`,
    [specId, projectId, orgId],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'main', 'halted')`,
    [runId, specId, projectId, orgId],
  );
}
