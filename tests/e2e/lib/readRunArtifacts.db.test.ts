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

function uniqueDbName(): string {
  return `tanren_e2e_artifacts_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    await adminPool.query(`CREATE DATABASE ${database}`);
    ownerPool = createDbPool(withDatabase(ADMIN_URL, database));
    await migrate(ownerPool);
    await seedMergedRun(ownerPool);
  }, 120_000);

  afterAll(async () => {
    await ownerPool?.end();
    await adminPool?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await adminPool?.end();
  });

  it("returns the seeded merged run, its cost_records, and a non-zero DORA count", async () => {
    const artifacts = await readRunArtifacts(ownerPool, RUN_ID);
    expect(artifacts.runId).toBe(RUN_ID);
    expect(artifacts.status).toBe("done");
    expect(artifacts.outcome).toBe("phase2_easy_complete");
    expect(artifacts.prUrl).toBe(PR_URL);
    expect(artifacts.costRecords).toEqual([{ taskKind: "write", basis: "provider_pricing", billingMode: "per_token" }]);
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
     VALUES ($1, $2, $3, $4, 'api', 'main', 'done', 'phase2_easy_complete', $5)`,
    [RUN_ID, SPEC_ID, PROJECT_ID, ORG_ID, PR_URL],
  );
  await owner.query(
    `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli)
     VALUES ($1, $2, $3, 'write', 'write', 'done', 'writer_codex', 'codex')`,
    [TASK_ID, RUN_ID, ORG_ID],
  );
  await owner.query(
    `INSERT INTO cost_records
       (task_id, run_id, project_id, org_id, cli, provider, model, billing_mode, cost_basis)
     VALUES ($1, $2, $3, $4, 'codex', 'openai', 'gpt-5', 'per_token', 'provider_pricing')`,
    [TASK_ID, RUN_ID, PROJECT_ID, ORG_ID],
  );
}
