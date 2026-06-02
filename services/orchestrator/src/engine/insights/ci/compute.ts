// P2e-1 CI analytics computation (autonomy-engine.md §2d Mergify parity, item
// 2). Pure reducer (`deriveCiAnalytics`) over the CI events the engine already
// persists, plus a thin DB loader (`computeCiAnalytics`) that pulls those rows
// for a project + window. No migration, no write path — every input column
// predates this spec.
//
// Inputs (all read-only):
//   - runs:   each `ci.started` (run start) paired to its terminal `ci.passed`/
//             `ci.failed` for the same head SHA → run-level pass-rate, timing,
//             and the retry signal (a SHA with > 1 CI run).
//   - checks: the per-check `checkRuns[]` on every terminal CI event →
//             per-check pass-rate + slowest/least-reliable steps.

import type pg from "pg";
import { CiAnalytics, type CiCheckStat } from "./types.js";

const DEFAULT_WINDOW_DAYS = 30;
const SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const SLOWEST_LIMIT = 5;

/** A normalized CI run: one `ci.*` observation row. */
export interface CiRunObservation {
  headSha: string;
  /** terminal outcome of the whole CI run. */
  outcome: "passed" | "failed";
  /** ci.started instant for this SHA (timing clock start), if observed. */
  startedAt: Date | null;
  /** terminal ci.* instant (timing clock end). */
  endedAt: Date;
  /** per-check outcomes carried on the terminal observation. */
  checks: Array<{ name: string; outcome: "passed" | "failed" }>;
}

export interface CiAnalyticsInputs {
  runs: CiRunObservation[];
}

export interface DeriveCiOptions {
  projectId: string;
  windowStart: Date;
  windowEnd: Date;
  windowDays: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Pure CI-analytics reducer. Deterministic over its inputs; the DB loader below
 * is the only impure shell. Returns a fully-typed, schema-valid `CiAnalytics`.
 */
export function deriveCiAnalytics(inputs: CiAnalyticsInputs, options: DeriveCiOptions): CiAnalytics {
  const { runs } = inputs;

  // Run-level pass-rate.
  const passedCiRuns = runs.filter((r) => r.outcome === "passed").length;
  const runPassRate = runs.length === 0 ? null : passedCiRuns / runs.length;

  // Retry rate: fraction of distinct head SHAs that needed more than one CI run.
  const runsBySha = new Map<string, number>();
  for (const run of runs) runsBySha.set(run.headSha, (runsBySha.get(run.headSha) ?? 0) + 1);
  const retriedShas = [...runsBySha.values()].filter((n) => n > 1).length;
  const retryRate = runsBySha.size === 0 ? null : retriedShas / runsBySha.size;

  // Timing: ci.started → terminal seconds, where a start was observed.
  const durations = runs
    .filter((r): r is CiRunObservation & { startedAt: Date } => r.startedAt !== null)
    .map((r) => (r.endedAt.getTime() - r.startedAt.getTime()) / 1000)
    .filter((s) => Number.isFinite(s) && s >= 0);
  const timing = {
    medianSeconds: median(durations),
    maxSeconds: durations.length === 0 ? null : Math.max(...durations),
    sample: durations.length,
  };

  // Per-check pass-rate over every check observation across the window.
  const byCheck = new Map<string, { observations: number; passes: number }>();
  for (const run of runs) {
    for (const check of run.checks) {
      const agg = byCheck.get(check.name) ?? { observations: 0, passes: 0 };
      agg.observations += 1;
      if (check.outcome === "passed") agg.passes += 1;
      byCheck.set(check.name, agg);
    }
  }
  const checks: CiCheckStat[] = [...byCheck.entries()]
    .map(([checkName, agg]) => ({
      checkName,
      observations: agg.observations,
      passes: agg.passes,
      passRate: agg.observations === 0 ? null : agg.passes / agg.observations,
    }))
    // Least-reliable first (lowest pass-rate), then most-observed, then name.
    .sort(
      (a, b) =>
        (a.passRate ?? 1) - (b.passRate ?? 1) ||
        b.observations - a.observations ||
        a.checkName.localeCompare(b.checkName),
    );

  // "Slowest steps" surrogate: the checks that fail most often are the ones that
  // most slow delivery (each failure forces a re-run). Highest fail-rate first.
  const slowestChecks = [...checks]
    .filter((c) => c.passRate !== null && c.passRate < 1)
    .sort((a, b) => (a.passRate ?? 1) - (b.passRate ?? 1) || b.observations - a.observations)
    .slice(0, SLOWEST_LIMIT);

  return CiAnalytics.parse({
    projectId: options.projectId,
    windowStart: options.windowStart.toISOString(),
    windowEnd: options.windowEnd.toISOString(),
    windowDays: options.windowDays,
    runPassRate,
    totalCiRuns: runs.length,
    passedCiRuns,
    retryRate,
    timing,
    checks,
    slowestChecks,
    computedAt: options.windowEnd.toISOString(),
  });
}

export interface ComputeCiAnalyticsOptions {
  projectId: string;
  now?: Date;
  windowDays?: number;
}

interface CiEventQueryRow {
  event_type: string;
  payload: unknown;
  ts: Date;
}

/**
 * Load the read-only CI events for a project + window and reduce them to
 * `CiAnalytics`. Touches only the `events` table.
 */
export async function computeCiAnalytics(
  pool: Pick<pg.Pool, "query">,
  options: ComputeCiAnalyticsOptions,
): Promise<CiAnalytics> {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const result = await pool.query<CiEventQueryRow>(
    `SELECT event_type, payload, ts
       FROM events
       WHERE project_id = $1
         AND event_type IN ('ci.started','ci.passed','ci.failed')
         AND ts >= $2
       ORDER BY ts ASC`,
    [options.projectId, since],
  );

  return deriveCiAnalytics(
    { runs: reduceCiEventsToRuns(result.rows) },
    { projectId: options.projectId, windowStart: since, windowEnd: now, windowDays },
  );
}

/**
 * Reduce raw `ci.*` event rows to one `CiRunObservation` per terminal CI run.
 * Pairs each terminal (`ci.passed`/`ci.failed`) with the EARLIEST preceding
 * `ci.started` for the same head SHA that has not yet been paired (so multiple
 * CI runs on the same SHA — the retry signal — each get their own start). Pure.
 */
export function reduceCiEventsToRuns(rows: ReadonlyArray<CiEventQueryRow>): CiRunObservation[] {
  // Per-SHA queue of unpaired ci.started instants (ordered ascending).
  const pendingStarts = new Map<string, Date[]>();
  const runs: CiRunObservation[] = [];

  for (const row of rows) {
    const payload = row.payload as { headSha?: unknown; checkRuns?: unknown };
    const headSha = typeof payload.headSha === "string" ? payload.headSha : undefined;
    if (headSha === undefined) continue;

    if (row.event_type === "ci.started") {
      const queue = pendingStarts.get(headSha) ?? [];
      queue.push(new Date(row.ts));
      pendingStarts.set(headSha, queue);
      continue;
    }

    // terminal ci.passed / ci.failed
    const outcome: "passed" | "failed" = row.event_type === "ci.passed" ? "passed" : "failed";
    const queue = pendingStarts.get(headSha);
    const startedAt = queue !== undefined && queue.length > 0 ? queue.shift()! : null;
    const checks = extractCheckOutcomes(payload.checkRuns);
    runs.push({ headSha, outcome, startedAt, endedAt: new Date(row.ts), checks });
  }

  return runs;
}

function extractCheckOutcomes(raw: unknown): Array<{ name: string; outcome: "passed" | "failed" }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ name: string; outcome: "passed" | "failed" }> = [];
  for (const entry of raw) {
    const check = entry as { name?: unknown; conclusion?: unknown };
    if (typeof check.name !== "string") continue;
    const conclusion = typeof check.conclusion === "string" ? check.conclusion : null;
    // A pending check (null conclusion) has no verdict yet — skip it.
    if (conclusion === null) continue;
    out.push({ name: check.name, outcome: SUCCESS_CONCLUSIONS.has(conclusion) ? "passed" : "failed" });
  }
  return out;
}
