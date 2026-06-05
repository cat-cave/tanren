// P3-0019 DORA metric computation. Pure reducer (`deriveDoraMetrics`) over
// rows that runs/tasks/events already persist, plus a thin DB loader
// (`computeDoraMetrics`) that pulls those rows for a project + window. No new
// data collection and no migration — every input column predates this spec.
//
// Inputs (all read-only):
//   - merges:   `merge.completed` events (P3-0008) joined to their spec's
//               created_at → one merge row per completed merge.
//   - runs:     terminal runs in the window (status completed/failed/
//               halted/cancelled) → change-failure-rate denominator.
//   - halts:    halt boundaries (a run reaching status 'halted') paired with
//               the next merge for the same spec → recovery time for MTTR.

import type pg from "pg";
import { DoraMetrics, type DoraMetricFigure } from "./types.js";

const DEFAULT_WINDOW_DAYS = 30;

/** A completed merge with the lead-time clock anchor (spec creation). */
export interface MergeRow {
  specId: string;
  /** When the spec was first created (lead-time start). */
  specCreatedAt: Date;
  /** When the merge completed (lead-time end + the "deploy" instant). */
  mergedAt: Date;
}

/** A terminal run, used for the change-failure-rate ratio. */
export interface FinishedRunRow {
  runId: string;
  /** Terminal run status; "failed"/"halted"/"cancelled" count as failures. */
  status: string;
  endedAt: Date;
}

/** A halt boundary paired with the recovery merge that cleared it. */
export interface RecoveryRow {
  specId: string;
  /** When the run halted (restore clock start). */
  haltedAt: Date;
  /** When the spec next merged after the halt (restore clock end). */
  recoveredAt: Date;
}

export interface DoraInputs {
  merges: MergeRow[];
  finishedRuns: FinishedRunRow[];
  recoveries: RecoveryRow[];
}

export interface DeriveOptions {
  projectId: string;
  windowStart: Date;
  windowEnd: Date;
  windowDays: number;
}

/** A finished run is a "failure" when it did not reach a clean terminal state. */
const FAILURE_STATUSES = new Set(["failed", "halted", "cancelled"]);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function figure(value: number | null, sample: number): DoraMetricFigure {
  return { value, sample };
}

/**
 * Pure DORA reducer. Deterministic over its inputs; the DB loader below is the
 * only impure shell. Returns a fully-typed, schema-valid `DoraMetrics`.
 */
export function deriveDoraMetrics(inputs: DoraInputs, options: DeriveOptions): DoraMetrics {
  const { merges, finishedRuns, recoveries } = inputs;

  // Lead time: median(spec.created → merge.completed) across merged specs.
  const leadSeconds = merges
    .map((m) => (m.mergedAt.getTime() - m.specCreatedAt.getTime()) / 1000)
    .filter((s) => Number.isFinite(s) && s >= 0);
  const leadTime = figure(median(leadSeconds), leadSeconds.length);

  // Deploy frequency: merges per day over the window.
  const deployValue = merges.length === 0 ? null : merges.length / options.windowDays;
  const deployFrequency = figure(deployValue, merges.length);

  // Change-failure rate: failures / finished runs over the window.
  const failedRuns = finishedRuns.filter((r) => FAILURE_STATUSES.has(r.status)).length;
  const cfrValue = finishedRuns.length === 0 ? null : failedRuns / finishedRuns.length;
  const changeFailureRate = figure(cfrValue, finishedRuns.length);

  // MTTR: median(halt → recovery merge) across recovered halts.
  const restoreSeconds = recoveries
    .map((r) => (r.recoveredAt.getTime() - r.haltedAt.getTime()) / 1000)
    .filter((s) => Number.isFinite(s) && s >= 0);
  const mttr = figure(median(restoreSeconds), restoreSeconds.length);

  return DoraMetrics.parse({
    projectId: options.projectId,
    windowStart: options.windowStart.toISOString(),
    windowEnd: options.windowEnd.toISOString(),
    windowDays: options.windowDays,
    leadTimeSeconds: leadTime,
    deployFrequencyPerDay: deployFrequency,
    changeFailureRate,
    meanTimeToRestoreSeconds: mttr,
    totals: {
      merges: merges.length,
      finishedRuns: finishedRuns.length,
      failedRuns,
      recoveries: restoreSeconds.length,
    },
    computedAt: options.windowEnd.toISOString(),
  });
}

export interface ComputeDoraOptions {
  projectId: string;
  now?: Date;
  windowDays?: number;
}

interface MergeQueryRow {
  spec_id: string;
  spec_created_at: Date;
  merged_at: Date;
}
interface FinishedRunQueryRow {
  run_id: string;
  status: string;
  ended_at: Date;
}
interface RecoveryQueryRow {
  spec_id: string;
  halted_at: Date;
  recovered_at: Date;
}

/**
 * Load the read-only inputs for a project + window and reduce them to the four
 * DORA metrics. The queries touch only `events`, `runs`, and `specs` — all
 * pre-existing tables.
 */
export async function computeDoraMetrics(
  pool: Pick<pg.Pool, "query">,
  options: ComputeDoraOptions,
): Promise<DoraMetrics> {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  // Completed merges + the spec's creation instant (lead-time anchor). One row
  // per merge.completed event inside the window.
  const mergesResult = await pool.query<MergeQueryRow>(
    `SELECT e.spec_id,
            s.created_at AS spec_created_at,
            e.ts AS merged_at
       FROM events e
       INNER JOIN specs s ON s.spec_id = e.spec_id
       WHERE e.event_type = 'merge.completed'
         AND e.project_id = $1
         AND e.spec_id IS NOT NULL
         AND e.ts >= $2
       ORDER BY e.ts ASC`,
    [options.projectId, since],
  );

  // Terminal runs in the window — the change-failure denominator.
  const finishedResult = await pool.query<FinishedRunQueryRow>(
    `SELECT r.run_id, r.status, r.ended_at
       FROM runs r
       WHERE r.project_id = $1
         AND r.ended_at IS NOT NULL
         AND r.ended_at >= $2
         AND r.status IN ('completed','failed','halted','cancelled')`,
    [options.projectId, since],
  );

  // Halt → recovery pairs: each run that halted, matched to the earliest
  // merge.completed for the SAME spec strictly after the halt.
  const recoveryResult = await pool.query<RecoveryQueryRow>(
    `SELECT halt.spec_id,
            halt.halted_at,
            MIN(m.ts) AS recovered_at
       FROM (
         SELECT r.spec_id, MIN(r.ended_at) AS halted_at
           FROM runs r
          WHERE r.project_id = $1
            AND r.status = 'halted'
            AND r.ended_at IS NOT NULL
            AND r.ended_at >= $2
          GROUP BY r.spec_id
       ) halt
       INNER JOIN events m
               ON m.spec_id = halt.spec_id
              AND m.event_type = 'merge.completed'
              AND m.ts > halt.halted_at
       GROUP BY halt.spec_id, halt.halted_at`,
    [options.projectId, since],
  );

  const inputs: DoraInputs = {
    merges: mergesResult.rows.map((row) => ({
      specId: row.spec_id,
      specCreatedAt: new Date(row.spec_created_at),
      mergedAt: new Date(row.merged_at),
    })),
    finishedRuns: finishedResult.rows.map((row) => ({
      runId: row.run_id,
      status: row.status,
      endedAt: new Date(row.ended_at),
    })),
    recoveries: recoveryResult.rows.map((row) => ({
      specId: row.spec_id,
      haltedAt: new Date(row.halted_at),
      recoveredAt: new Date(row.recovered_at),
    })),
  };

  return deriveDoraMetrics(inputs, {
    projectId: options.projectId,
    windowStart: since,
    windowEnd: now,
    windowDays,
  });
}
