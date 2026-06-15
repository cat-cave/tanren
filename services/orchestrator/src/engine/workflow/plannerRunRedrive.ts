// APPLY a {@link RunDisposition} to a run's lifecycle (apex v35 — the unified
// run-finalize authority). The DECISION (the 3-bucket mapping: RE-DRIVE | GENUINE-HALT |
// CONVERGE) lives in `runFinalizeAuthority.ts` — a pure, DB-free core. THIS module is the
// APPLIER: given a decided disposition + the run/spec write seams, it performs the
// lifecycle writes + emits the ONE observable event for that bucket, consistently, from
// whichever path produced the outcome (the workflow error catch, a non-pass exit, the
// merge stage, or the worker orphan reconciler). It also owns the consecutive-same-failure
// READER (the durable-event-log count the authority's bound keys off).
//
// The product doctrine it embodies: a spec failing due to a RANDOM / TRANSIENT fault must
// NEVER be tolerated as terminal — it RE-DRIVES (run halts recoverable, spec → `open`, the
// walker re-enqueues), emitting an OBSERVABLE `dag.spec.redriven` (never a strand). The
// re-drive is BOUNDED ONLY by a CONSECUTIVE-same-failure counter (a DIFFERENT failure / any
// progress resets it) — never a wall-clock deadline. `needs_attention` is RESERVED for the
// three GENUINE-HALT classes (misconfiguration / persistent-same-failure / human-decision),
// each with a SPECIFIC, actionable diagnostic (never a bare "internal error").

import type pg from "pg";
import { runWithOrgScope } from "@tanren/db";
import type { RunFailureCode } from "../worker/runFailureClassifier.js";
import { createLogger } from "../observability/logger.js";
import type { EventName, EventPayload } from "../events/index.js";
import {
  decideRunDisposition,
  DEFAULT_REDRIVE_ESCALATE_AT,
  redriveBackoffSeconds,
  type RunDisposition,
  type TerminalOutcome,
} from "./runFinalizeAuthority.js";

const log = createLogger("run-redrive");

// Re-exported so the historical import sites (tests, the worker wiring) keep their imports
// pointed at this module while the decision constants live in the authority core.
export { DEFAULT_REDRIVE_ESCALATE_AT, redriveBackoffSeconds };

/** Facts a consecutive-same-failure read needs: the spec + its org + the failure code now seen. */
export interface RedriveHistoryFacts {
  orgId: string;
  specId: string;
  /** The classified failure code of the CURRENT failure (the one being counted). */
  code: RunFailureCode;
}

/**
 * Read the CONSECUTIVE-same-failure count for a spec (this failure included). Walks the
 * spec's prior `dag.spec.redriven` events NEWEST→OLDEST and counts the trailing run of
 * re-drives whose `failureCode` MATCHES the current one — stopping at the first DIFFERENT
 * code (a different failure = progress, which resets the streak). Returns the count
 * INCLUDING the current failure (so the first failure of its kind returns 1). At >= K
 * (`escalateAtAttempts`) the authority escalates instead of re-driving.
 */
export type RedriveHistoryReader = (facts: RedriveHistoryFacts) => Promise<number>;

/**
 * The Pg-backed {@link RedriveHistoryReader} the run worker wires: an org-scoped read of the
 * spec's prior `dag.spec.redriven` events (newest first), counting the trailing run whose
 * `failureCode` matches the current one. A DIFFERENT code breaks the run (progress reset).
 *
 * FAIL-CLOSED toward RE-DRIVING (not toward stranding): a read failure logs loudly and
 * returns 1 (treat as the first failure of its kind) — a transient DB hiccup must NOT cause a
 * spurious escalation to `needs_attention`; the bound still bites once the read recovers.
 */
export function buildRedriveHistoryReader(pool: pg.Pool): RedriveHistoryReader {
  return async (facts) => {
    try {
      return await runWithOrgScope(pool, facts.orgId, async (client) => {
        const result = await client.query<{ payload: { failureCode?: string } }>(
          `SELECT payload FROM events
             WHERE spec_id = $1 AND event_type = 'dag.spec.redriven'
             ORDER BY ts DESC, id DESC`,
          [facts.specId],
        );
        // Count the trailing run of SAME-code prior re-drives, then +1 for the current
        // failure. A different prior code breaks the run (a different failure = progress).
        let priorSameRun = 0;
        for (const row of result.rows) {
          if (row.payload.failureCode !== facts.code) break;
          priorSameRun += 1;
        }
        return priorSameRun + 1;
      });
    } catch (error) {
      log.warn(
        "consecutive-same-failure read failed (fail-closed toward re-drive: treat as first of its kind)",
        { specId: facts.specId },
        error,
      );
      return 1;
    }
  };
}

/** The append-event seam the applier emits its observable timeline events through. */
type AppendEvent = <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>;

/**
 * The run/spec write seams + facts the applier needs, handed in by `finalizeWorkflowError`
 * (so this module never imports back into `plannerRunFinalize.ts` — the file-size cap holds
 * without a circular import). All route through the SAME lifecycle-writer seams the rest of
 * the finalize path uses.
 */
export interface DispositionSeams {
  /** Halt the run RECOVERABLE (work not discarded) — the re-drive's run finalize. The
   * distinct `window_exhausted` / `convergence_stalled` outcome preserves WHY for recovery. */
  finalizeNonPass: (outcome: "halted" | "window_exhausted" | "convergence_stalled") => Promise<void>;
  /** Set the spec status (→ `open` to re-drive, → `needs_attention` to genuine-halt). */
  setSpecStatus: (status: string) => Promise<void>;
  /** The remote/in-process terminal-run finalizer (the genuine-halt `failed` write). */
  finalizeRunState: (
    status: string,
    outcome: string,
    fromStatuses: string[],
    directSql: string,
    directParams: unknown[],
  ) => Promise<void>;
}

/** The run/spec facts the applier reads (the subset of the workflow error context it uses). */
export interface DispositionContext {
  appendEvent: AppendEvent;
  input: { redriveHistoryReader?: RedriveHistoryReader };
  context: { runId: string; specId: string; orgId?: unknown };
}

/** The bucket a terminal outcome was disposed into (the workflow `catch` keys off this). */
export type DispositionBucket = RunDisposition["bucket"];

/**
 * DECIDE + APPLY a terminal outcome's disposition. Reads the consecutive-same-failure count
 * (the durable bound), asks the authority for the bucket, then performs the lifecycle writes:
 *
 *   • RE-DRIVE — run halts RECOVERABLE, spec → `open`, an OBSERVABLE `dag.spec.redriven`
 *     event (carrying the failure code + the consecutive-same-failure counter + the backoff).
 *     The attempt is terminally disposed of; the walker's successor run is the continuation.
 *   • GENUINE-HALT — run → `failed`, spec → `needs_attention`, a `dag.spec.needs_attention`
 *     event with a SPECIFIC reason (`misconfiguration` / `persistent_failure` / `human_decision`).
 *   • CONVERGE — the caller owns the merged-run write; never reached on the error path.
 *
 * Returns the bucket so the workflow `catch` knows whether the attempt was terminally disposed
 * of (re-drive ⇒ return normally, NEVER re-throw into the worker's strand path — the #580
 * double-finalize) or still fails the job (genuine-halt ⇒ re-throw wrapped).
 */
export async function applyTerminalOutcome(
  outcome: TerminalOutcome,
  ctx: DispositionContext,
  seams: DispositionSeams,
): Promise<DispositionBucket> {
  const consecutive = await readConsecutiveSameFailure(ctx, outcome);
  const disposition = decideRunDisposition(outcome, consecutive);
  if (disposition.bucket === "re_drive") {
    await applyRedrive(ctx, seams, disposition);
    return "re_drive";
  }
  if (disposition.bucket === "genuine_halt") {
    await applyGenuineHalt(ctx, seams, disposition);
    return "genuine_halt";
  }
  return "converge";
}

/** Apply a RE-DRIVE: halt the run recoverable, return the spec to `open`, emit `dag.spec.redriven`. */
async function applyRedrive(
  ctx: DispositionContext,
  seams: DispositionSeams,
  disposition: Extract<RunDisposition, { bucket: "re_drive" }>,
): Promise<void> {
  await seams.finalizeNonPass(disposition.runOutcome);
  await seams.setSpecStatus("open");
  // A re-drive WITH a classified failure emits the OBSERVABLE `dag.spec.redriven` (the
  // consecutive-same-failure counter rides it so the bound is visible on the timeline). A
  // NO-FAULT re-drive (an ancestor-wait / a merge hold) carries no failure code and so does
  // not count toward the cap — it re-opens silently (its own event, if any, is the caller's).
  if (disposition.failure === undefined) return;
  await ctx.appendEvent("dag.spec.redriven", {
    specId: ctx.context.specId,
    runId: ctx.context.runId,
    failureCode: disposition.failure.code,
    stage: disposition.failure.stage,
    consecutiveSameFailure: disposition.consecutiveSameFailure,
    escalateAtAttempts: DEFAULT_REDRIVE_ESCALATE_AT,
    backoffSeconds: disposition.backoffSeconds,
  });
}

/** Apply a GENUINE-HALT: land the run `failed`, park the spec `needs_attention` with a specific reason. */
async function applyGenuineHalt(
  ctx: DispositionContext,
  seams: DispositionSeams,
  disposition: Extract<RunDisposition, { bucket: "genuine_halt" }>,
): Promise<void> {
  await seams.finalizeRunState(
    "failed",
    "failed",
    ["running", "queued"],
    "UPDATE runs SET status = 'failed', outcome = 'failed', ended_at = now() WHERE run_id = $1",
    [ctx.context.runId],
  );
  await seams.setSpecStatus("needs_attention");
  await ctx.appendEvent("dag.spec.needs_attention", {
    source: "strand",
    specId: ctx.context.specId,
    reason: disposition.reason,
    terminalRuns: [{ runId: ctx.context.runId, status: "failed" }],
    attempts: disposition.consecutiveSameFailure,
    message: disposition.message,
  });
}

/** Read the consecutive-same-failure count via the wired reader (1 ⇒ first of its kind / no reader / no fault). */
async function readConsecutiveSameFailure(ctx: DispositionContext, outcome: TerminalOutcome): Promise<number> {
  // Only an error / non-pass outcome carries a counted failure code; decide a probe code
  // up front so the reader (when wired) counts the right streak. A merge / ancestor-wait
  // outcome never counts toward the cap, so the count is immaterial (return 1).
  const probe = decideRunDisposition(outcome, 0);
  const code = probe.bucket === "converge" ? undefined : probe.failure?.code;
  const reader = ctx.input.redriveHistoryReader;
  const orgId = typeof ctx.context.orgId === "string" ? ctx.context.orgId : undefined;
  if (reader === undefined || orgId === undefined || code === undefined) return 1;
  return reader({ orgId, specId: ctx.context.specId, code });
}
