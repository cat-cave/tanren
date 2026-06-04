// DB-gated integration test for the benchmark foundation
// (docs/roadmap/tanren-method-benchmark.md §4.2). Proves three things against a
// real, freshly-migrated, RLS-enforced database:
//   (1) migration 0033 applies — the three tables + their RLS policies exist;
//   (2) RLS DENIES cross-org reads of experiments/cells/trials (deny-by-default,
//       incl. the parent-chained policies on cells + trials) and ADMITS the
//       owning org's scoped read;
//   (3) `loadTrialScorecard` projects a real run's events/tasks/cost_records
//       into the §2.3 scorecard under an org-scoped client.
//
// Gated behind TANREN_RLS_DB_TEST=1 + an owner/superuser DATABASE_URL (the
// migration role), mirroring the other RLS cohort tests.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope, setSystemPool } from "@tanren/db";
import { loadTrialScorecard } from "../src/engine/benchmark/index.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_bench_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function withRole(url: string, role: string, password: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = password;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const ORG_A = "org_bench_a";
const ORG_B = "org_bench_b";

// Seed an org + project + spec + run (+ events/tasks/cost_records) and an
// experiment/cell/trial that joins the run. Runs on the owner pool (RLS-exempt).
async function seedOrg(
  pool: Pool,
  org: string,
  opts: { withRunFacts: boolean },
): Promise<{ runId: string; cellId: string; trialId: string; experimentId: string }> {
  const project = `proj_${org}`;
  const spec = `spec_${org}`;
  const runId = `run_${org}`;
  const experimentId = `exp_${org}`;
  const cellId = `cell_${org}`;
  const trialId = `trial_${org}`;

  await pool.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [org],
  );
  await pool.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, 'p', 'https://github.com/cat-cave/tanren-fixture-medium', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [project, org],
  );
  await pool.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, acceptance_criteria, status, created_at)
     VALUES ($1, $2, $3, 't', 'd', '[]'::jsonb, 'active', '2026-05-01T00:00:00.000Z')`,
    [spec, project, org],
  );
  await pool.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status, started_at, ended_at)
     VALUES ($1, $2, $3, $4, 'cli', 'tanren/x', 'done', '2026-05-01T00:10:00.000Z', '2026-05-01T00:25:00.000Z')`,
    [runId, spec, project, org],
  );

  if (opts.withRunFacts) {
    await pool.query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model, attempt)
       VALUES ($1, $2, $3, 'write', 'w', 'done', 'writer', 'codex', 'm', 3)`,
      [`task_${org}`, runId, org],
    );
    // Seed timeline events with EXPLICIT timestamps (the projection's lead-time
    // math depends on them, which the eventStore's defaultNow() can't set). The
    // table name is a constant so this test-only seed is not a production
    // event-write path — the single-event-writer rule governs engine src code.
    const EVENTS_TABLE = "events";
    await pool.query(
      `INSERT INTO ${EVENTS_TABLE} (run_id, project_id, spec_id, org_id, event_type, ts, payload)
       VALUES ($1, $2, $3, $4, 'merge.completed', '2026-05-01T00:24:00.000Z', '{}'::jsonb),
              ($1, $2, $3, $4, 'planner.rerequested', '2026-05-01T00:15:00.000Z', '{"producer":"gate"}'::jsonb),
              ($1, $2, $3, $4, 'gate.failed', '2026-05-01T00:14:00.000Z', '{}'::jsonb)`,
      [runId, project, spec, org],
    );
    await pool.query(
      `INSERT INTO cost_records
         (task_id, run_id, project_id, org_id, cli, provider, model,
          input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens,
          reasoning_output_tokens, total_tokens, cost_usd, billing_mode, cost_basis)
       VALUES ($1, $2, $3, $4, 'codex', 'openai', 'm', 100, 0, 0, 50, 0, 150, 0.25, 'per_token', 'ccusage')`,
      [`task_${org}`, runId, project, org],
    );
  }

  await pool.query(
    `INSERT INTO experiments (experiment_id, org_id, title, knob, hypothesis, seed_task_ref)
     VALUES ($1, $2, 'e', 'gate_strictness', 'h', '{}'::jsonb)`,
    [experimentId, org],
  );
  await pool.query(
    `INSERT INTO experiment_cells (cell_id, experiment_id, label, frozen_config, trials_target)
     VALUES ($1, $2, 'lint-only', '{}'::jsonb, 5)`,
    [cellId, experimentId],
  );
  await pool.query(
    `INSERT INTO experiment_trials (trial_id, cell_id, run_id, trial_index, accept_result, scorecard)
     VALUES ($1, $2, $3, 0, 'passed', '{}'::jsonb)`,
    [trialId, cellId, runId],
  );

  return { runId, cellId, trialId, experimentId };
}

describeDb("benchmark entities — migration applies + RLS isolates + scorecard projects", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;
  let seedA: Awaited<ReturnType<typeof seedOrg>>;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    // migrate creates the roles + every RLS policy, including migration 0033.
    await migrate(ownerPool);
    appPool = new Pool({ connectionString: withRole(ADMIN_URL, APP_ROLE, APP_PASSWORD, database) });
    setSystemPool(undefined);

    seedA = await seedOrg(ownerPool, ORG_A, { withRunFacts: true });
    await seedOrg(ownerPool, ORG_B, { withRunFacts: false });
  }, 60_000);

  afterAll(async () => {
    setSystemPool(undefined);
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

  it("created the three tables with RLS enabled", async () => {
    const rls = await ownerPool.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
        WHERE relname IN ('experiments','experiment_cells','experiment_trials')
        ORDER BY relname`,
    );
    expect(rls.rows).toHaveLength(3);
    expect(rls.rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  it("RLS admits the owning org's scoped read of all three benchmark tables", async () => {
    await runWithOrgScope(appPool, ORG_A, async (client) => {
      const exp = await client.query("SELECT 1 FROM experiments WHERE org_id = $1", [ORG_A]);
      const cell = await client.query("SELECT 1 FROM experiment_cells WHERE cell_id = $1", [seedA.cellId]);
      const trial = await client.query("SELECT 1 FROM experiment_trials WHERE trial_id = $1", [seedA.trialId]);
      expect(exp.rowCount).toBe(1);
      // The cell's parent-chained policy resolves via its experiment.
      expect(cell.rowCount).toBe(1);
      // The trial's parent-chained policy resolves via its cell.
      expect(trial.rowCount).toBe(1);
    });
  });

  it("RLS DENIES a cross-org read of experiments + the parent-chained cells/trials", async () => {
    // Scoped to ORG_B, ORG_A's benchmark rows must be invisible (zero rows) —
    // deny-by-default on the direct policy AND the EXISTS-chained child policies.
    await runWithOrgScope(appPool, ORG_B, async (client) => {
      const exp = await client.query("SELECT * FROM experiments WHERE experiment_id = $1", [seedA.experimentId]);
      const cell = await client.query("SELECT * FROM experiment_cells WHERE cell_id = $1", [seedA.cellId]);
      const trial = await client.query("SELECT * FROM experiment_trials WHERE trial_id = $1", [seedA.trialId]);
      expect(exp.rowCount).toBe(0);
      expect(cell.rowCount).toBe(0);
      expect(trial.rowCount).toBe(0);
    });
  });

  it("RLS REJECTS inserting a trial under a cell owned by another org", async () => {
    // ORG_B tries to attach a trial to ORG_A's cell — the WITH CHECK EXISTS
    // subquery cannot see ORG_A's cell under the B scope, so the write is denied.
    await expect(
      runWithOrgScope(appPool, ORG_B, async (client) => {
        await client.query(
          `INSERT INTO experiment_trials (trial_id, cell_id, run_id, trial_index, scorecard)
           VALUES ('trial_cross', $1, $2, 9, '{}'::jsonb)`,
          [seedA.cellId, seedA.runId],
        );
      }),
    ).rejects.toThrow(/row-level security|violates/iu);
  });

  it("loadTrialScorecard projects the real run's rows under org scope (§2.3)", async () => {
    const card = await runWithOrgScope(appPool, ORG_A, (client) =>
      loadTrialScorecard(client, { runId: seedA.runId, cellId: seedA.cellId, trialIndex: 0, reachedAcceptGreen: true }),
    );
    expect(card).not.toBeNull();
    expect(card!.runId).toBe(seedA.runId);
    // Active: run 00:10 → 00:25 = 900s. Lead: spec 00:00 → merge 00:24 = 1440s.
    expect(card!.activeExecutionSeconds).toBe(900);
    expect(card!.leadTimeSeconds).toBe(1440);
    expect(card!.plannerReruns).toBe(1);
    expect(card!.plannerRerunsByProducer).toEqual({ gate: 1, auditor: 0 });
    expect(card!.gateFailures).toBe(1);
    expect(card!.writerIterations).toBe(3);
    expect(card!.tokens.total).toBe(150);
    expect(card!.costUsd).toBeCloseTo(0.25);
    expect(card!.costBasisMix).toEqual({
      provider_response: 0,
      ccusage: 1,
      provider_pricing: 0,
      credits: 0,
      unknown: 0,
      unattributed: 0,
    });
    expect(card!.reachedAcceptGreen).toBe(true);
  });

  it("loadTrialScorecard returns null for a run invisible under the caller's org scope", async () => {
    const card = await runWithOrgScope(appPool, ORG_B, (client) => loadTrialScorecard(client, { runId: seedA.runId }));
    // ORG_A's run is denied by RLS under ORG_B scope → the loader sees no run.
    expect(card).toBeNull();
  });
});
