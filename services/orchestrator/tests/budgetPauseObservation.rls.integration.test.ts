// GV-5 real-Postgres proof: the Budget HTTP projection reads the latest
// project-level `dag.budget.paused` event under the org-scoped runtime role.
//
// This is the GENUINE RLS proof (mirrors the R3b enforcement wave): with the
// policies from the baseline migration ENABLED and the runtime connecting as the
// restricted `tanren_app` role (NOBYPASSRLS), tenant isolation on `events` is
// enforced AT THE DATABASE — not by the reader's application predicate. We prove
// that end-to-end with RAW SELECTs that carry NO org predicate:
//   (a) deny-by-default: an UNSET GUC (raw pool, no SET LOCAL) sees ZERO pause
//       events on `events` — `org_id = NULL` is never true. This fails LOUD if
//       RLS is removed (the raw pool would then see BOTH orgs' rows).
//   (b) org-scoped raw SELECT (no org predicate): under org A's GUC a raw
//       `SELECT ... FROM events WHERE event_type = 'dag.budget.paused'` returns
//       ONLY org A's rows. This fails LOUD if RLS is removed (org B leaks in).
//   (c) the reader's latest walker proof is the in-org project-level event, and a
//       NEWER run-scoped (task-loop) pause never shadows it (real SQL filter).
//   (d) a cross-org reader call (org A scope, org B project) returns null.
//   (e) a spoofed cross-org event WRITE (org A scope, org B id) is rejected by the
//       `events` WITH CHECK — through the canonical single-event-writer (PgEventStore).
//
// Gated behind TANREN_RLS_DB_TEST=1 + an owner/superuser DATABASE_URL (the
// migration role), exactly like the R3b test. Wired into `just smoke`.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { PgBudgetPauseObservationReader } from "../src/engine/dag/budgetPauseObservation.js";
import { PgEventStore } from "../src/engine/eventStore.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_budget_pause_observation_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

const ORG_A = "org_budget_pause_a";
const ORG_B = "org_budget_pause_b";
const PROJECT_A = "project_budget_pause_a";
const PROJECT_B = "project_budget_pause_b";
const EVENT_TYPE = "dag.budget.paused";

describeDb("PgBudgetPauseObservationReader RLS (genuine DB-level isolation)", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    // The REAL migration ENABLES RLS + the policies AND creates the roles.
    await migrate(ownerPool);
    // The restricted runtime role (NOBYPASSRLS) — the one the reader runs under.
    appPool = new Pool({ connectionString: runtimeUrl(ADMIN_URL, database) });

    // Seed two tenants AS THE OWNER (RLS-exempt). Each org gets a project-level
    // walker pause proof; org A additionally gets a NEWER run-scoped (task-loop)
    // pause so the real SQL filter (run_id/task_id/spec_id IS NULL) is exercised.
    await seedTenant(ownerPool, ORG_A, PROJECT_A);
    await seedTenant(ownerPool, ORG_B, PROJECT_B);
    await appendWalkerPause(ownerPool, ORG_A, PROJECT_A, 1);
    await appendWalkerPause(ownerPool, ORG_A, PROJECT_A, 2);
    await appendWalkerPause(ownerPool, ORG_B, PROJECT_B, 99);
    // A run-scoped (task-loop) pause, NEWER than org A's walker proof — must never
    // shadow the project-level walker event (the reader's filter excludes it).
    await appendTaskLoopPause(ownerPool, ORG_A, PROJECT_A, 777);
  }, 60_000);

  afterAll(async () => {
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

  // (a) deny-by-default: the raw app pool (NO SET LOCAL) sees ZERO pause events on
  //     `events`. The GUC is NULL so `org_id = current_setting(...)` is never true.
  //     THIS IS THE RLS PROOF — it fails loud if RLS / the policy is removed (the
  //     raw pool would then see both orgs' rows).
  it("(a) an unset GUC returns ZERO pause events on the raw app pool (deny-by-default)", async () => {
    const unscoped = await appPool.query(`SELECT org_id FROM events WHERE event_type = '${EVENT_TYPE}'`);
    expect(unscoped.rowCount).toBe(0);
  });

  // (b) org-scoped RAW SELECT with NO org predicate: under org A's GUC the raw
  //     `events` read returns ONLY org A's rows. RLS — not an app filter — does the
  //     scoping. This fails loud if RLS is removed (org B's rows would leak in).
  it("(b) an org-A scope + raw SELECT (no org predicate) sees ONLY org A's pause events", async () => {
    await runWithOrgScope(appPool, ORG_A, async (client) => {
      const scoped = await client.query<{ org_id: string }>(
        `SELECT org_id FROM events WHERE event_type = '${EVENT_TYPE}'`,
      );
      expect(scoped.rowCount).toBeGreaterThan(0);
      // Every visible row is org A's; org B's row is invisible without any app predicate.
      expect(scoped.rows.every((r) => r.org_id === ORG_A)).toBe(true);
      expect(scoped.rows.some((r) => r.org_id === ORG_B)).toBe(false);
    });
  });

  // (c) + finding #2: the reader selects the latest PROJECT-LEVEL walker proof, and
  //     a NEWER run-scoped (task-loop) pause never shadows it. Exercises the REAL
  //     SQL filter (`run_id IS NULL AND task_id IS NULL AND spec_id IS NULL`).
  it("(c) returns the latest in-org walker proof; a newer task-loop pause never shadows it", async () => {
    const reader = new PgBudgetPauseObservationReader(appPool);

    const own = await reader.latest(ORG_A, PROJECT_A);
    expect(own).toMatchObject({ eventType: "dag.budget.paused", readyHeldBack: 2 });
    expect(Date.parse(own?.observedAt ?? "")).not.toBeNaN();
    // The newer run-scoped pause (readyHeldBack 777) is filtered out by the SQL.
    expect(own?.readyHeldBack).not.toBe(777);
  });

  // (d) cross-org reader: supplying org A's scope with org B's project id cannot
  //     reveal org B's project-level event — RLS + the app predicate both reject it.
  it("(d) a cross-org reader call (org A scope, org B project) returns null", async () => {
    const reader = new PgBudgetPauseObservationReader(appPool);
    await expect(reader.latest(ORG_A, PROJECT_B)).resolves.toBeNull();
  });

  // (e) spoofed/cross-org mutation negative: under org A's GUC, appending an event
  //     stamped org B is rejected by the `events` WITH CHECK. Written through the
  //     CANONICAL single-event-writer (PgEventStore) so the event boundary holds.
  it("(e) a spoofed cross-org event WRITE is rejected by the events WITH CHECK", async () => {
    await expect(
      runWithOrgScope(appPool, ORG_A, () =>
        new PgEventStore(appPool).append({
          projectId: PROJECT_A,
          orgId: ORG_B,
          eventType: EVENT_TYPE,
          payload: { ceilingUsd: 50, spentUsd: 55, period: "total", readyHeldBack: 1 },
        }),
      ),
    ).rejects.toThrow(/row-level security|policy/iu);

    // The spoofed write landed nothing (owner pool = RLS-exempt ground truth).
    const spoofed = await ownerPool.query(
      "SELECT 1 FROM events WHERE org_id = $1 AND project_id = $2 AND event_type = $3",
      [ORG_B, PROJECT_A, EVENT_TYPE],
    );
    expect(spoofed.rowCount).toBe(0);
  });
});

async function seedTenant(pool: Pool, orgId: string, projectId: string): Promise<void> {
  await pool.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await pool.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id, config)
     VALUES ($1, $1, $2, $3, '{"version":1}'::jsonb)`,
    [projectId, `https://example.com/${projectId}.git`, orgId],
  );
}

/** Append a PROJECT-LEVEL walker pause (null run/task/spec identity). */
async function appendWalkerPause(pool: Pool, orgId: string, projectId: string, readyHeldBack: number): Promise<void> {
  await runWithOrgScope(pool, orgId, () =>
    new PgEventStore(pool).append({
      projectId,
      orgId,
      eventType: "dag.budget.paused",
      payload: { ceilingUsd: 50, spentUsd: 55, period: "total", readyHeldBack },
    }),
  );
}

/** Append a RUN-SCOPED (task-loop) pause with non-null task/run/spec identity. */
async function appendTaskLoopPause(pool: Pool, orgId: string, projectId: string, readyHeldBack: number): Promise<void> {
  await runWithOrgScope(pool, orgId, () =>
    new PgEventStore(pool).append({
      projectId,
      orgId,
      runId: `run_loop_${projectId}`,
      taskId: `task_loop_${projectId}`,
      specId: `spec_loop_${projectId}`,
      eventType: "dag.budget.paused",
      payload: { ceilingUsd: 50, spentUsd: 55, period: "total", readyHeldBack },
    }),
  );
}
