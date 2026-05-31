// BenchmarkRunner (docs/roadmap/tanren-method-benchmark.md §4.2 item 2). A
// SCHEDULER over the existing worker run-executor — NOT a second executor. Per
// cell it provisions the frozen config for each trial (the seed repo at its
// pinned SHA + the cell's RoutingTable/EscapeHatches/governance applied as the
// trial's project config), enqueues ONE `plan` job per trial for the existing
// dequeue→execute path to run, SPACES/serializes trials to respect the §3.3
// comparability invariants + real provider rate limits, runs the post-merge
// hidden `accept` tier, and writes an `experiment_trials` row joining the trial
// to its real `runs` row.
//
// Everything heavy is REUSED: project/spec/run creation (`workflow/projectSpec`),
// the worker run-executor (the run is executed by the worker, not here — we only
// ENQUEUE + await its terminal state), the gate/CI-tier substrate (the accept
// step, `accept.ts`), and `loadTrialScorecard` (the foundation's projection).
// The provisioning + await + accept seams are all injectable so the orchestration
// is unit-testable without a live runner.

import { randomUUID } from "node:crypto";
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { migrateProjectConfig } from "../config/index.js";
import { createProject, createQueuedRunFromSpec, createSpec } from "../workflow/projectSpec.js";
import type { AcceptResult, FrozenConfig, SeedTaskRef } from "./entities.js";
import { loadTrialScorecard, type TrialScorecard } from "./scorecard.js";
import {
  CellNotFoundError,
  isTerminalStatus,
  loadCellOrgId,
  loadCellWithExperiment,
  loadExperimentCellIds,
  loadExperimentOrgId,
  readActiveRateLimitGate,
  readRunStatus,
  writeTrialRow,
  type CellWithExperiment,
} from "./runnerDb.js";

export { CellNotFoundError };

// ---- Seams ----------------------------------------------------------------

/** What `provisionTrial` returns: the run that backs this trial. */
export interface ProvisionedTrial {
  runId: string;
  /** The plan task id (correlates accept events with the trial's run task). */
  taskId?: string;
}

/** The post-merge accept-step seam (defaults to running `accept.ts` over SSH). */
export interface TrialAcceptInput {
  orgId: string;
  cell: CellWithExperiment;
  runId: string;
  trialIndex: number;
  taskId?: string;
}

export interface BenchmarkRunnerDeps {
  /** Cross-org system pool to bootstrap the experiment's org, then scope per-op. */
  pool: pg.Pool;
  /**
   * Provision one trial's frozen config and enqueue its `plan` job. Defaults to
   * the real project/spec/run creation with the cell's frozen config applied.
   * Returns the run id the worker will execute.
   */
  provisionTrial?: (input: {
    orgId: string;
    cell: CellWithExperiment;
    trialIndex: number;
  }) => Promise<ProvisionedTrial>;
  /**
   * Await a run to a terminal state (the worker executes it). Defaults to polling
   * `runs.status` under org scope until terminal or the deadline. Returns the
   * terminal snapshot, or undefined if the deadline passed without terminating.
   */
  awaitTerminal?: (input: {
    orgId: string;
    runId: string;
  }) => Promise<{ status: string; outcome: string | null; merged: boolean } | undefined>;
  /**
   * Run the post-merge hidden accept tier and emit `benchmark.accept.*`. Only
   * called when the trial's run merged. Defaults to a no-op that returns null
   * (the live accept wiring is injected by the worker boot; a no-op keeps the
   * scheduler pure for unit paths). Returns the AcceptResult or null if not run.
   */
  runAccept?: (input: TrialAcceptInput) => Promise<AcceptResult | null>;
  /**
   * Load a run's TrialScorecard. Defaults to `loadTrialScorecard` under org
   * scope. Injected in tests to assert projection without seeding a full run.
   */
  loadScorecard?: (input: {
    orgId: string;
    runId: string;
    cellId: string;
    trialIndex: number;
    reachedAcceptGreen: boolean | null;
  }) => Promise<TrialScorecard | null>;
  /**
   * Persist the trial's `experiment_trials` join row. Defaults to `writeTrialRow`
   * under org scope (RLS-enforced via the cell's parent chain). Injected in tests
   * to assert the trial-row write without a live DB.
   */
  persistTrial?: (input: {
    orgId: string;
    trialId: string;
    cellId: string;
    runId: string;
    trialIndex: number;
    acceptResult: AcceptResult | null;
    scorecard: TrialScorecard;
  }) => Promise<void>;
  /** Poll interval for the default `awaitTerminal` (ms). */
  pollIntervalMs?: number;
  /** Max wall-clock to await a single trial's terminal state (ms). */
  trialTimeoutMs?: number;
  /**
   * §3.3 spacing: how the scheduler waits between trials. Defaults to a policy
   * that delays a fixed gap, extended to `retry_after_s` when a recent provider
   * window-exhaustion observation gates the next trial. Injected in tests so
   * spacing is asserted deterministically (no real sleeps).
   */
  spaceBeforeNextTrial?: (input: { orgId: string; cell: CellWithExperiment; nextTrialIndex: number }) => Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
// 30m — a real trial is a full run (plan→write→check→audit→PR→CI→merge).
const DEFAULT_TRIAL_TIMEOUT_MS = 1_800_000;
const DEFAULT_INTER_TRIAL_GAP_MS = 2_000;

// ---- Per-trial + per-cell results -----------------------------------------

export interface TrialResult {
  trialIndex: number;
  runId: string;
  /** True when the run reached a terminal state within the deadline. */
  terminated: boolean;
  terminalStatus: string | null;
  acceptResult: AcceptResult | null;
  /** True when an experiment_trials row was written for this trial. */
  trialRowWritten: boolean;
}

export interface CellRunResult {
  cellId: string;
  experimentId: string;
  trialsTarget: number;
  trials: TrialResult[];
}

export interface ExperimentRunResult {
  experimentId: string;
  cells: CellRunResult[];
}

// ---- Public entry points --------------------------------------------------

/**
 * Run every trial of one cell, serialized + spaced (§3.3). The programmatic entry
 * the CLI/report surface (a follow-up) will call. Resolves the cell's org from
 * the experiment, then runs `trials_target` trials one at a time: provision →
 * await terminal → (if merged) accept → project scorecard → write trial row.
 */
export async function runExperimentCell(deps: BenchmarkRunnerDeps, cellId: string): Promise<CellRunResult> {
  const orgId = await loadCellOrgId(deps.pool, cellId);
  if (orgId === null) throw new CellNotFoundError(cellId);
  const loaded = await loadCellWithExperiment(deps.pool, orgId, cellId);
  return runCellTrials(deps, orgId, loaded);
}

/**
 * Run every cell of an experiment (each cell's trials serialized within the
 * cell). Cells run in id order; an experiment with N cells × M trials enqueues
 * N×M plan jobs total, one trial at a time.
 */
export async function runExperiment(deps: BenchmarkRunnerDeps, experimentId: string): Promise<ExperimentRunResult> {
  const orgId = await loadExperimentOrgId(deps.pool, experimentId);
  if (orgId === null) throw new CellNotFoundError(experimentId);
  const cellIds = await loadExperimentCellIds(deps.pool, orgId, experimentId);
  const cells: CellRunResult[] = [];
  for (const cellId of cellIds) {
    const loaded = await loadCellWithExperiment(deps.pool, orgId, cellId);
    cells.push(await runCellTrials(deps, orgId, loaded));
  }
  return { experimentId, cells };
}

// ---- Orchestration --------------------------------------------------------

/**
 * Run every trial of an already-loaded cell, serialized + spaced (§3.3). Exposed
 * (vs. only via `runExperimentCell`) so the orchestration is unit-testable with a
 * fabricated cell + injected seams — no DB load. The two public entry points wrap
 * this with the org-scoped cell load.
 */
export async function runCellTrials(
  deps: BenchmarkRunnerDeps,
  orgId: string,
  loaded: CellWithExperiment,
): Promise<CellRunResult> {
  const trials: TrialResult[] = [];
  for (let trialIndex = 0; trialIndex < loaded.cell.trialsTarget; trialIndex += 1) {
    // §3.3 spacing: serialize + space trials so trial N+1 never starts under an
    // exhausted provider window while trial N ran under a fresh one. The gap
    // applies BEFORE every trial after the first (the first runs immediately).
    if (trialIndex > 0) {
      await spaceBeforeNextTrial(deps, orgId, loaded, trialIndex);
    }
    trials.push(await runOneTrial(deps, orgId, loaded, trialIndex));
  }
  return {
    cellId: loaded.cell.cellId,
    experimentId: loaded.cell.experimentId,
    trialsTarget: loaded.cell.trialsTarget,
    trials,
  };
}

async function runOneTrial(
  deps: BenchmarkRunnerDeps,
  orgId: string,
  loaded: CellWithExperiment,
  trialIndex: number,
): Promise<TrialResult> {
  // 1. Provision the frozen config + enqueue the trial's plan job (the worker
  //    dequeues + executes it; we never execute here).
  const provision = deps.provisionTrial ?? defaultProvisionTrial(deps.pool);
  const provisioned = await provision({ orgId, cell: loaded, trialIndex });

  // 2. Await the worker-driven run's terminal state.
  const awaitTerminal = deps.awaitTerminal ?? defaultAwaitTerminal(deps);
  const terminal = await awaitTerminal({ orgId, runId: provisioned.runId });

  // 3. If the run merged, run the post-merge hidden accept tier.
  let acceptResult: AcceptResult | null = null;
  if (terminal?.merged === true) {
    const runAccept = deps.runAccept ?? (async () => null);
    acceptResult = await runAccept({
      orgId,
      cell: loaded,
      runId: provisioned.runId,
      trialIndex,
      taskId: provisioned.taskId,
    });
  }

  // 4. Project the TrialScorecard + write the experiment_trials row. We write a
  //    row whenever the run terminated (a halted/failed trial is still a real
  //    observation — its merge-success/accept rates feed the cell aggregate).
  let trialRowWritten = false;
  if (terminal !== undefined) {
    const reachedAcceptGreen = acceptGreenFlag(terminal.merged, acceptResult);
    const loadScorecard = deps.loadScorecard ?? defaultLoadScorecard(deps.pool);
    const scorecard = await loadScorecard({
      orgId,
      runId: provisioned.runId,
      cellId: loaded.cell.cellId,
      trialIndex,
      reachedAcceptGreen,
    });
    if (scorecard !== null) {
      const persistTrial = deps.persistTrial ?? defaultPersistTrial(deps.pool);
      await persistTrial({
        orgId,
        trialId: `trial_${randomUUID()}`,
        cellId: loaded.cell.cellId,
        runId: provisioned.runId,
        trialIndex,
        acceptResult,
        scorecard,
      });
      trialRowWritten = true;
    }
  }

  return {
    trialIndex,
    runId: provisioned.runId,
    terminated: terminal !== undefined && isTerminalStatus(terminal.status),
    terminalStatus: terminal?.status ?? null,
    acceptResult,
    trialRowWritten,
  };
}

/**
 * The scorecard's `reachedAcceptGreen` input: null when the run never merged (the
 * accept tier did not run — honestly "not evaluated"), else true/false from the
 * accept outcome. A merged run with no accept wiring stays null, not false.
 */
function acceptGreenFlag(merged: boolean, acceptResult: AcceptResult | null): boolean | null {
  if (!merged || acceptResult === null) return null;
  return acceptResult === "passed";
}

// ---- Default seams --------------------------------------------------------

/** Apply the cell's frozen config as the trial's project config (the §3.1 freeze). */
export function projectConfigFromFrozen(frozen: FrozenConfig): Record<string, unknown> {
  // FrozenConfig pins routing × escape-hatches × ci-tier snapshot × governance.
  // The ci-tier snapshot lives in the seed repo's tanren-ci.yml (read at gate
  // time), not the project config — so it is part of the substrate, not mapped
  // here. The other four map directly onto ProjectConfigV1; migrateProjectConfig
  // parses + validates the result (fail-hard on a bad shape).
  return migrateProjectConfig({
    version: 1,
    routing: frozen.routing,
    escapeHatches: frozen.escapeHatches,
    governancePosture: frozen.governance,
    mergeIntegration: frozen.mergeIntegration,
  });
}

function seedSpecTitle(seed: SeedTaskRef, cellLabel: string, trialIndex: number): string {
  return `benchmark ${cellLabel} trial ${trialIndex} @ ${seed.sha.slice(0, 8)}`;
}

/**
 * Default provisioning: create a project carrying the cell's frozen config, a
 * spec from the seed task, and a queued run (which enqueues the `plan` job). One
 * project/spec/run per trial keeps each trial's frozen config + pinned SHA fully
 * reproducible from its own rows (§3.1) and gives the worker an ordinary run to
 * execute. The system-scoped actor carries the experiment's org so every write
 * is RLS-scoped to the tenant.
 */
function defaultProvisionTrial(
  pool: pg.Pool,
): (input: { orgId: string; cell: CellWithExperiment; trialIndex: number }) => Promise<ProvisionedTrial> {
  return async ({ orgId, cell, trialIndex }) => {
    const actor: ActorContext = {
      userId: "benchmark-runner",
      orgId,
      projectId: null,
      scopes: ["platform:admin"],
      source: "local_dev",
    };
    const project = await createProject(
      pool,
      {
        name: `bench ${cell.cell.label} t${trialIndex}`,
        repoUrl: gitHubRepoUrl(cell.seedTaskRef.repo),
        config: projectConfigFromFrozen(cell.frozenConfig),
      },
      actor,
    );
    const spec = await createSpec(
      pool,
      {
        projectId: project.projectId,
        title: seedSpecTitle(cell.seedTaskRef, cell.cell.label, trialIndex),
        description: `Benchmark trial for experiment ${cell.experiment.experimentId} (knob: ${cell.experiment.knob}).`,
        acceptanceCriteria: [`Seed task ${cell.seedTaskRef.repo}@${cell.seedTaskRef.sha} accepted by the hidden tier.`],
      },
      actor,
    );
    const run = await createQueuedRunFromSpec(pool, { specId: spec.specId, trigger: "benchmark" }, actor);
    return { runId: run.runId, taskId: run.plannerTaskId };
  };
}

function gitHubRepoUrl(repo: string): string {
  return repo.startsWith("http") ? repo : `https://github.com/${repo}`;
}

/** Default await: poll `runs.status` under org scope until terminal or deadline. */
function defaultAwaitTerminal(
  deps: BenchmarkRunnerDeps,
): (input: {
  orgId: string;
  runId: string;
}) => Promise<{ status: string; outcome: string | null; merged: boolean } | undefined> {
  const pool = deps.pool;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = deps.trialTimeoutMs ?? DEFAULT_TRIAL_TIMEOUT_MS;
  return async ({ orgId, runId }) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const snapshot = await readRunStatus(pool, orgId, runId);
      if (snapshot !== undefined && isTerminalStatus(snapshot.status)) return snapshot;
      if (Date.now() >= deadline) return snapshot;
      await sleep(pollIntervalMs);
    }
  };
}

function defaultLoadScorecard(
  pool: pg.Pool,
): (input: {
  orgId: string;
  runId: string;
  cellId: string;
  trialIndex: number;
  reachedAcceptGreen: boolean | null;
}) => Promise<TrialScorecard | null> {
  return ({ orgId, runId, cellId, trialIndex, reachedAcceptGreen }) =>
    runWithOrgScope(pool, orgId, (client) =>
      loadTrialScorecard(client, { runId, cellId, trialIndex, reachedAcceptGreen }),
    );
}

function defaultPersistTrial(
  pool: pg.Pool,
): (input: {
  orgId: string;
  trialId: string;
  cellId: string;
  runId: string;
  trialIndex: number;
  acceptResult: AcceptResult | null;
  scorecard: TrialScorecard;
}) => Promise<void> {
  return ({ orgId, ...row }) => writeTrialRow(pool, orgId, row);
}

/**
 * Default spacing (§3.3): a fixed inter-trial gap, EXTENDED to a provider's
 * `retry_after_s` when a recent window-exhaustion observation gates the next
 * trial — so trial N+1 never starts under an exhausted window. Reads the write
 * role's provider from the cell's frozen routing (the dimension whose rate limit
 * bites the most); falls back to the fixed gap when no provider is resolvable.
 */
async function spaceBeforeNextTrial(
  deps: BenchmarkRunnerDeps,
  orgId: string,
  cell: CellWithExperiment,
  nextTrialIndex: number,
): Promise<void> {
  if (deps.spaceBeforeNextTrial !== undefined) {
    await deps.spaceBeforeNextTrial({ orgId, cell, nextTrialIndex });
    return;
  }
  const gapMs = DEFAULT_INTER_TRIAL_GAP_MS;
  const provider = writeProviderOf(cell.frozenConfig);
  if (provider !== undefined) {
    const gate = await readActiveRateLimitGate(deps.pool, provider, Date.now() - 3_600_000);
    if (gate !== undefined) {
      const retryMs = gate.retryAfterS === null ? gapMs : gate.retryAfterS * 1_000;
      await sleep(Math.max(gapMs, retryMs));
      return;
    }
  }
  await sleep(gapMs);
}

/** The write role's first-choice provider/model identity (for spacing + record). */
function writeProviderOf(frozen: FrozenConfig): string | undefined {
  const chain = frozen.routing.write?.chain ?? [];
  return chain[0]?.model;
}

// ---- helpers --------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}
