// P8b — `readRunArtifacts` against a REAL Postgres (autonomy-engine §8b).
//
// The harness unit tests (harness.test.ts) pin the gate's VERDICT logic over
// hand-built evidence objects. This test pins the gate's OBSERVATION SQL: the
// `readRunArtifacts` query that the credentialed run uses to read the real
// persisted run / cost_records / DORA rows must actually return them from a
// seeded Postgres — otherwise the gate's teeth read nothing.
//
// It is gated behind TANREN_RLS_DB_TEST=1 + a migration-owner DATABASE_URL,
// exactly like the orchestrator's other pg-integration tests, so it is SKIPPED
// in `just fast-check` and runs against a seeded DB under `just smoke`. It
// provisions an ephemeral database, migrates it, seeds a minimal merged run
// (outcome + pr_url) with a cost_records row, and asserts `readRunArtifacts`
// returns exactly that.
//
// Imports are e2e-no-mock clean: node builtins, the `@tanren/db` PUBLIC entry
// (createDbPool/migrate — the same Postgres `Pool` the gate reads through), and
// the e2e suite's own harness lib — no fixture/mock/internal seam (the
// `e2e-no-mock-imports` arch check enforces this on tests/e2e/**). We use
// `createDbPool` rather than importing `pg` directly so the file resolves from
// the repo-root e2e suite (pg is a workspace, not root, dependency).

import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool, type DbPool, migrate } from "@tanren/db";
import { readRunArtifacts } from "./harness.js";

const enabled = process.env.TANREN_RLS_DB_TEST === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://tanren:tanren@localhost:5432/tanren";

const ORG_ID = "org_e2e_artifacts";
const PROJECT_ID = "proj_e2e_artifacts";
const SPEC_ID = "spec_e2e_artifacts";
const RUN_ID = "run_e2e_artifacts";
const TASK_ID = "task_e2e_artifacts_write";
const PR_URL = "https://github.com/cat-cave/tanren-fixture-easy/pull/42";

// Per-RUN, per-PROCESS ephemeral DB name. The timestamp + PID + crypto-random
// suffix makes the name collision-proof across concurrently-scheduled runs
// (parallel worktrees / smoke recipes sharing one Postgres): a name collision is
// the only way one run's teardown could touch another's DB, and this rules it
// out. Well under Postgres's 63-char identifier limit.
function uniqueDbName(): string {
  return `tanren_e2e_artifacts_${Date.now()}_${process.pid}_${randomBytes(6).toString("hex")}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

describeDb("readRunArtifacts against a real Postgres", () => {
  const database = uniqueDbName();
  let adminPool: DbPool;
  let ownerPool: DbPool;

  beforeAll(async () => {
    adminPool = createDbPool(ADMIN_URL);
    // A `pg.Pool` re-emits a backend error that lands on an IDLE (checked-in)
    // client as an `'error'` EVENT; an EventEmitter `'error'` with no listener
    // becomes an uncaughtException that crashes the vitest worker (the whole
    // FILE fails). Under concurrent Postgres load an idle pooled connection can
    // be terminated (`57P01 terminating connection due to administrator
    // command`) during the teardown window — e.g. as the DB is dropped. Without
    // these listeners that benign teardown-race termination presented as the
    // intermittent `57P01` smoke failure (#1228). Attaching a no-op listener
    // makes an idle-client termination a no-op. This does NOT mask a real
    // read/write failure: those surface as a REJECTED `await pool.query(...)`
    // inside an `it` (an active-query error, not a pool `'error'` event), which
    // still fails the assertion below.
    adminPool.on("error", () => {});
    await adminPool.query(`CREATE DATABASE ${database}`);
    ownerPool = createDbPool(withDatabase(ADMIN_URL, database));
    ownerPool.on("error", () => {});
    await migrate(ownerPool);
    await seedMergedRun(ownerPool);
  }, 120_000);

  afterAll(async () => {
    // Deterministic teardown, matching the RLS-integration canonical pattern:
    // fully drain the owner pool FIRST, then explicitly terminate any straggler
    // backend still registered on THIS ephemeral DB (scoped by `datname = $1`,
    // never a foreign DB), then a plain `DROP DATABASE`. This replaces the lone
    // `DROP DATABASE ... WITH (FORCE)` outlier: the terminate is ordered before
    // the drop rather than folded into it, so there is no window where the drop
    // races an open connection.
    await ownerPool?.end();
    if (adminPool !== undefined) {
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [database],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
      await adminPool.end();
    }
  });

  it("returns the seeded merged run, its cost_records, and a non-zero DORA count", async () => {
    const artifacts = await readRunArtifacts(ownerPool, RUN_ID);
    expect(artifacts.runId).toBe(RUN_ID);
    expect(artifacts.status).toBe("completed");
    expect(artifacts.outcome).toBe("ok");
    expect(artifacts.prUrl).toBe(PR_URL);
    expect(artifacts.costRecords).toEqual([
      { taskKind: "write", basis: "provider_response", billingMode: "per_token" },
    ]);
    // The run is merged (outcome + pr_url set), so it counts toward the project's
    // DORA deployment projection — the same merge-derived COUNT the gate asserts.
    expect(artifacts.doraDeploymentCount).toBe(1);
  });

  it("throws when the run id is absent (the gate reads a real row, never a stub)", async () => {
    await expect(readRunArtifacts(ownerPool, "run_does_not_exist")).rejects.toThrow(/run not found/u);
  });
});

// seedMergedRun inserts the minimal merged-run chain `readRunArtifacts` reads:
// org → project → spec → run (status=done, outcome + pr_url set) → a write task
// → a cost_records row. As the migration owner, RLS is exempt, so the raw
// inserts (and the function's reads) need no org scope.
async function seedMergedRun(owner: DbPool): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [ORG_ID],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, 'e2e', 'https://github.com/cat-cave/tanren-fixture-easy', $2)`,
    [PROJECT_ID, ORG_ID],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description)
     VALUES ($1, $2, $3, 't', 'd')`,
    [SPEC_ID, PROJECT_ID, ORG_ID],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status, outcome, pr_url)
     VALUES ($1, $2, $3, $4, 'api', 'main', 'completed', 'ok', $5)`,
    [RUN_ID, SPEC_ID, PROJECT_ID, ORG_ID, PR_URL],
  );
  await owner.query(
    `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli)
     VALUES ($1, $2, $3, 'write', 'write', 'done', 'writer', 'codex')`,
    [TASK_ID, RUN_ID, ORG_ID],
  );
  await owner.query(
    `INSERT INTO cost_records
       (task_id, run_id, project_id, org_id, cli, provider, model, billing_mode, cost_basis)
     VALUES ($1, $2, $3, $4, 'codex', 'openai', 'gpt-5', 'per_token', 'provider_response')`,
    [TASK_ID, RUN_ID, PROJECT_ID, ORG_ID],
  );
}
