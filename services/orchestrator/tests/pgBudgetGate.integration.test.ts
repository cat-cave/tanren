// §6.2 (docs/audits/2026-06-09-apex-pre-run.md) — the REAL `PgBudgetGate` against
// a REAL Postgres (no SQL mocks).
//
// The budget-pause PREDICATES (isBudgetExhausted / shouldPauseOnBudget) are unit-
// pinned in budgetGate.test.ts, and the loop/route resume is pinned in
// plannerLoopBudget.test.ts / budgetRoutes.test.ts — but those all feed a FAKE
// BudgetGate. This pins the OTHER half: the production `PgBudgetGate.resolveBudget`
// SQL — the org-scoped cost-sum + the project-over-org ceiling resolution + the
// fail-CLOSED unpriced/unparseable paths — actually returning the right state from
// a seeded Postgres. That is the $50-ceiling enforcement's observation surface; if
// the SQL reads wrong, the apex run over/under-spends silently.
//
// Gated behind TANREN_RLS_DB_TEST=1 + a migration-owner DATABASE_URL, exactly like
// the orchestrator's other pg-integration tests, so it is SKIPPED in
// `just fast-check` and runs against a seeded DB under `just smoke`.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@tanren/db";
import { PgBudgetGate } from "../src/engine/dag/budgetGate.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";

function dbName(): string {
  return `tanren_budget_gate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const ORG = "org_budget";
const PROJECT_LIMITED = "proj_budget_limited";
const PROJECT_UNLIMITED = "proj_budget_unlimited";
const PROJECT_UNPRICED = "proj_budget_unpriced";
const PROJECT_BAD_CONFIG = "proj_budget_bad_config";

describeDb("PgBudgetGate against a real Postgres (§6.2)", () => {
  const database = dbName();
  let ownerPool: Pool;
  let gate: PgBudgetGate;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    gate = new PgBudgetGate(ownerPool);

    // The org carries NO default budget; each project sets (or omits) its own.
    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [ORG],
    );

    // A LIMITED project: a $50 total ceiling. Seed two priced real-spend rows
    // summing to $30 (under the ceiling).
    await seedProject(ownerPool, PROJECT_LIMITED, { version: 1, budget: { ceilingUsd: 50, period: "total" } });
    await seedPricedSpend(ownerPool, PROJECT_LIMITED, "10.000000");
    await seedPricedSpend(ownerPool, PROJECT_LIMITED, "20.000000");

    // An UNLIMITED project: no budget configured (ceilingUsd resolves undefined).
    await seedProject(ownerPool, PROJECT_UNLIMITED, { version: 1 });
    await seedPricedSpend(ownerPool, PROJECT_UNLIMITED, "999.000000");

    // An UNPRICED project: a $50 ceiling + a NULL-cost per_token row → fail closed.
    await seedProject(ownerPool, PROJECT_UNPRICED, { version: 1, budget: { ceilingUsd: 50, period: "total" } });
    await seedUnpricedSpend(ownerPool, PROJECT_UNPRICED);

    // A BAD-CONFIG project: a present-but-unparseable budget (a string, not an
    // object) → the gate must fail CLOSED (never fall open to unlimited).
    await seedProject(ownerPool, PROJECT_BAD_CONFIG, { version: 1, budget: "fifty-dollars" });
  }, 60_000);

  afterAll(async () => {
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("resolves a configured ceiling + the org-scoped real-spend sum from cost_records", async () => {
    const state = await gate.resolveBudget(PROJECT_LIMITED);
    expect(state.ceilingUsd).toBe(50);
    expect(state.spentUsd).toBe(30);
    expect(state.failClosed).toBeUndefined();
    // Under the ceiling → the genuine gate does not trip.
    expect(state.spentUsd < (state.ceilingUsd ?? Infinity)).toBe(true);
  });

  it("resolves an unlimited project as ceilingUsd undefined (skips the sum)", async () => {
    const state = await gate.resolveBudget(PROJECT_UNLIMITED);
    expect(state.ceilingUsd).toBeUndefined();
    expect(state.failClosed).toBeUndefined();
  });

  it("FAILS CLOSED on an un-priced real-spend row (budget-safety C1b)", async () => {
    const state = await gate.resolveBudget(PROJECT_UNPRICED);
    expect(state.ceilingUsd).toBe(50);
    expect(state.failClosed).toBe("unpriced_spend");
  });

  it("FAILS CLOSED on a present-but-unparseable budget config (never falls open)", async () => {
    const state = await gate.resolveBudget(PROJECT_BAD_CONFIG);
    expect(state.failClosed).toBe("unparseable_config");
    // Fail-closed never reports a usable ceiling to gate on.
    expect(state.ceilingUsd).toBeUndefined();
  });

  it("FAILS CLOSED on an unresolvable project row (Codex critic #11 — never silent-unlimited)", async () => {
    // A missing project row must NOT silently degrade to "no budget configured"
    // (which would fall OPEN to unlimited spend past whatever ceiling the operator
    // intended). "Budget is the only run gate" — an ownership-corruption /
    // in-flight-migration read failure must fail CLOSED so the walker pauses.
    const state = await gate.resolveBudget("proj_does_not_exist");
    expect(state.failClosed).toBe("unresolvable_project_org");
    expect(state.ceilingUsd).toBeUndefined();
    expect(state.spentUsd).toBe(0);
  });

  it("FAILS CLOSED on a project row whose org_id is NULL (Codex critic #11)", async () => {
    // The same safety invariant as the missing-row case: a corrupt project row
    // with a NULL `org_id` is unreadable ownership, not "no budget configured".
    // The gate cannot resolve an org to sum the cost records under, so the true
    // spend is UNKNOWN — assume the ceiling is reached and fail CLOSED.
    const PROJECT_NULL_ORG = "proj_budget_null_org";
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id, config)
       VALUES ($1, 'p', 'https://example.com/r.git', NULL, $2::jsonb)`,
      [PROJECT_NULL_ORG, JSON.stringify({ version: 1, budget: { ceilingUsd: 50, period: "total" } })],
    );
    const state = await gate.resolveBudget(PROJECT_NULL_ORG);
    expect(state.failClosed).toBe("unresolvable_project_org");
    expect(state.ceilingUsd).toBeUndefined();
    expect(state.spentUsd).toBe(0);
  });
});

// Seed a project with a given config under the shared org.
async function seedProject(owner: Pool, projectId: string, config: unknown): Promise<void> {
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id, config)
     VALUES ($1, 'p', 'https://example.com/r.git', $2, $3::jsonb)`,
    [projectId, ORG, JSON.stringify(config)],
  );
}

// Seed one PRICED real-spend cost_records row (a provider_response per_token row
// carries a real cost_usd that the gate sums). Each row needs a run + a task FK.
async function seedPricedSpend(owner: Pool, projectId: string, costUsd: string): Promise<void> {
  const { runId, taskId } = await seedRunAndTask(owner, projectId);
  await owner.query(
    `INSERT INTO cost_records
       (task_id, run_id, project_id, org_id, cli, provider, model, cost_usd, billing_mode, cost_basis)
     VALUES ($1, $2, $3, $4, 'fake', 'openrouter', 'm', $5, 'per_token', 'provider_response')`,
    [taskId, runId, projectId, ORG, costUsd],
  );
}

// Seed one UN-PRICED real-spend row: a per_token row with NULL cost_usd — the
// budget-safety signal the gate fails closed on.
async function seedUnpricedSpend(owner: Pool, projectId: string): Promise<void> {
  const { runId, taskId } = await seedRunAndTask(owner, projectId);
  await owner.query(
    `INSERT INTO cost_records
       (task_id, run_id, project_id, org_id, cli, provider, model, cost_usd, billing_mode, cost_basis)
     VALUES ($1, $2, $3, $4, 'fake', 'anthropic', 'm', NULL, 'per_token', 'unknown')`,
    [taskId, runId, projectId, ORG],
  );
}

let seq = 0;

async function seedRunAndTask(owner: Pool, projectId: string): Promise<{ runId: string; taskId: string }> {
  seq += 1;
  const specId = `spec_${projectId}_${seq}`;
  const runId = `run_${projectId}_${seq}`;
  const taskId = `task_${projectId}_${seq}`;
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description)
     VALUES ($1, $2, $3, 't', 'd')`,
    [specId, projectId, ORG],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'main', 'running')`,
    [runId, specId, projectId, ORG],
  );
  await owner.query(
    `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, started_at, agent_kind, cli, model)
     VALUES ($1, $2, $3, 'write', 't', 'running', now(), 'writer', 'fake', NULL)`,
    [taskId, runId, ORG],
  );
  return { runId, taskId };
}
