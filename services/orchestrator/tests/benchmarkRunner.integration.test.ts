// DB-gated integration test for the BenchmarkRunner + accept step
// (docs/roadmap/tanren-method-benchmark.md §4.2). Proves against a real,
// freshly-migrated, RLS-enforced database:
//   (1) migration 0034 applies — the events CHECK constraint admits the new
//       `benchmark.accept.*` event types (an INSERT of one succeeds);
//   (2) `runExperimentCell` runs N trials end-to-end over INJECTED execute +
//       accept seams (no live worker/runner): each terminal run is projected and
//       a real `experiment_trials` row is written under org scope, with the
//       accept result + reachedAcceptGreen threaded on;
//   (3) RLS still DENIES cross-org reads/writes of the trial rows the runner
//       wrote (the cell's parent-chained policy).
//
// Gated behind TANREN_RLS_DB_TEST=1 + an owner/superuser DATABASE_URL (the
// migration role), mirroring benchmarkEntities.integration.test.ts.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope, setSystemPool } from "@tanren/db";
import { runExperimentCell } from "../src/engine/benchmark/index.js";
import { PgEventStore } from "../src/engine/eventStore.js";
import { runAcceptStep } from "../src/engine/benchmark/accept.js";
import { FakeSshSubstrate } from "../src/engine/contracts/sshSubstrate.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const SYSTEM_ROLE = "tanren_system";
const SYSTEM_PASSWORD = process.env["TANREN_SYSTEM_DB_PASSWORD"] ?? "tanren_system";

function dbName(): string {
  return `tanren_bench_run_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

const ORG_A = "org_bench_run_a";
const ORG_B = "org_bench_run_b";

const FROZEN = {
  routing: { write: { chain: [{ cli: "codex", model: "premium", authRef: "credential/codex/org/x" }] } },
  escapeHatches: {},
  ciTiers: {
    tiers: { fast: [{ name: "lint", run: "pnpm lint" }], slow: [{ name: "accept", run: "make accept" }] },
    when: { fast: ["per_iteration"], slow: ["pre_audit", "pre_merge"] },
  },
  governance: "strict",
  mergeIntegration: "not_configured",
};
const SEED = {
  repo: "cat-cave/tanren-fixture-medium",
  sha: "abcdef1234567890",
  acceptTierHash: "sha256:hh",
  corpusTier: 1,
};

// Seed an org + experiment + cell. `trialsTarget` trials will be created by the
// runner over the injected provisioning seam. Runs on the owner pool (RLS-exempt).
async function seedCell(pool: Pool, org: string, trialsTarget: number): Promise<{ cellId: string }> {
  const experimentId = `exp_${org}`;
  const cellId = `cell_${org}`;
  await pool.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [org],
  );
  await pool.query(
    `INSERT INTO experiments (experiment_id, org_id, title, knob, hypothesis, seed_task_ref)
     VALUES ($1, $2, 'e', 'gate_strictness', 'h', $3::jsonb)`,
    [experimentId, org, JSON.stringify(SEED)],
  );
  await pool.query(
    `INSERT INTO experiment_cells (cell_id, experiment_id, label, frozen_config, trials_target)
     VALUES ($1, $2, 'control', $3::jsonb, $4)`,
    [cellId, experimentId, JSON.stringify(FROZEN), trialsTarget],
  );
  return { cellId };
}

describeDb("BenchmarkRunner — runs trials end-to-end under RLS + the accept step", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;
  let systemPool: Pool;
  let cellA: { cellId: string };

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    appPool = new Pool({ connectionString: withRole(ADMIN_URL, APP_ROLE, APP_PASSWORD, database) });
    // The BYPASSRLS system pool: the runner's org-discovery bootstrap reads
    // (`loadCellOrgId`) run cross-org through this, exactly as production wires
    // TANREN_SYSTEM_DATABASE_URL. Org-scoped writes still use the restricted app
    // pool, so RLS is genuinely exercised.
    systemPool = new Pool({ connectionString: withRole(ADMIN_URL, SYSTEM_ROLE, SYSTEM_PASSWORD, database) });
    setSystemPool(systemPool);

    cellA = await seedCell(ownerPool, ORG_A, 2);
    await seedCell(ownerPool, ORG_B, 1);
  }, 60_000);

  afterAll(async () => {
    setSystemPool(undefined);
    await appPool?.end();
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

  // Provision a real terminal `done` run (+ its spec/project/events) for a trial,
  // so the DEFAULT loadScorecard + persistTrial exercise the real org-scoped
  // projection + write. The run is created on the owner pool (test seeding); the
  // runner's own writes go through the app pool under org scope.
  async function provisionRealRun(org: string, trialIndex: number): Promise<{ runId: string; taskId: string }> {
    const project = `proj_${org}_${trialIndex}`;
    const spec = `spec_${org}_${trialIndex}`;
    const runId = `run_${org}_${trialIndex}`;
    const taskId = `task_${org}_${trialIndex}`;
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
       VALUES ($1, 'p', 'https://github.com/cat-cave/tanren-fixture-medium', 'main', 'runner:v0', $2, '{}'::jsonb)`,
      [project, org],
    );
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, acceptance_criteria, status, created_at)
       VALUES ($1, $2, $3, 't', 'd', '[]'::jsonb, 'active', '2026-05-01T00:00:00.000Z')`,
      [spec, project, org],
    );
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status, started_at, ended_at)
       VALUES ($1, $2, $3, $4, 'benchmark', 'tanren/x', 'done', '2026-05-01T00:10:00.000Z', '2026-05-01T00:25:00.000Z')`,
      [runId, spec, project, org],
    );
    // Seed a merge.completed with an EXPLICIT timestamp (the scorecard's lead-time
    // math depends on it, which the eventStore's defaultNow() can't set). The
    // table name is a constant so this test-only seed is not a production
    // event-write path — the single-event-writer rule governs engine src code.
    const EVENTS_TABLE = "events";
    await ownerPool.query(
      `INSERT INTO ${EVENTS_TABLE} (run_id, project_id, spec_id, org_id, event_type, ts, payload)
       VALUES ($1, $2, $3, $4, 'merge.completed', '2026-05-01T00:24:00.000Z', '{}'::jsonb)`,
      [runId, project, spec, org],
    );
    return { runId, taskId };
  }

  it("runs trials_target trials, writes a trial row per trial with the accept result threaded", async () => {
    const result = await runExperimentCell(
      {
        pool: appPool,
        // INJECT execution: provision a real terminal run instead of a live worker.
        provisionTrial: ({ trialIndex }) => provisionRealRun(ORG_A, trialIndex),
        // INJECT terminal-await: the seeded runs are already `done` + merged.
        awaitTerminal: async () => ({ status: "done", outcome: "ok", merged: true }),
        // The accept step runs the cell's hidden tier over a fake SSH substrate
        // (always exit 0 → passed) and emits the net-new benchmark.accept event
        // through a real org-scoped PgEventStore.
        runAccept: async ({ orgId, cell, runId, trialIndex, taskId }) =>
          runWithOrgScope(appPool, orgId, async (client) => {
            const store = new PgEventStore(client);
            const project = `proj_${orgId}_${trialIndex}`;
            const spec = `spec_${orgId}_${trialIndex}`;
            const { result: acceptResult } = await runAcceptStep({
              ssh: new FakeSshSubstrate(),
              target: { host: "h", port: 22, username: "u", hostKeyFingerprint: "fp", identitySecretRef: "id" },
              workspacePath: "/ws",
              steps: cell.frozenConfig.ciTiers.tiers["slow"] ?? [],
              acceptTierHash: cell.seedTaskRef.acceptTierHash,
              cellId: cell.cell.cellId,
              trialIndex,
              timeoutMs: 1000,
              taskId,
              appendEvent: (eventType, payload, evTaskId) =>
                store.append({ runId, taskId: evTaskId, specId: spec, projectId: project, eventType, payload }),
            });
            return acceptResult;
          }),
        // No real sleeps between trials.
        spaceBeforeNextTrial: async () => {},
      },
      cellA.cellId,
    );

    expect(result.trials).toHaveLength(2);
    expect(result.trials.every((t) => t.trialRowWritten)).toBe(true);
    expect(result.trials.every((t) => t.acceptResult === "passed")).toBe(true);

    // The runner wrote real experiment_trials rows visible under ORG_A scope.
    const rows = await runWithOrgScope(appPool, ORG_A, (client) =>
      client.query<{ trial_index: number; accept_result: string; scorecard: { reachedAcceptGreen: boolean | null } }>(
        `SELECT trial_index, accept_result, scorecard FROM experiment_trials WHERE cell_id = $1 ORDER BY trial_index`,
        [cellA.cellId],
      ),
    );
    expect(rows.rows.map((r) => r.trial_index)).toEqual([0, 1]);
    expect(rows.rows.every((r) => r.accept_result === "passed")).toBe(true);
    // The projected scorecard carries the post-merge accept-green flag.
    expect(rows.rows.every((r) => r.scorecard.reachedAcceptGreen === true)).toBe(true);

    // And the net-new benchmark.accept.passed event landed (migration 0034's
    // CHECK constraint admits it).
    const acceptEvents = await ownerPool.query<{ event_type: string }>(
      `SELECT event_type FROM events WHERE event_type = 'benchmark.accept.passed' AND org_id = $1`,
      [ORG_A],
    );
    expect(acceptEvents.rowCount).toBe(2);
  });

  it("RLS denies a cross-org read of the trial rows the runner wrote", async () => {
    const rows = await runWithOrgScope(appPool, ORG_B, (client) =>
      client.query(`SELECT * FROM experiment_trials WHERE cell_id = $1`, [cellA.cellId]),
    );
    expect(rows.rowCount).toBe(0);
  });
});
