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
import type { AppendEventInput } from "../eventStore.js";
import {
  type ConvergenceFacts,
  decideRunDisposition,
  redriveBackoffSeconds,
  type RunDisposition,
  type TerminalOutcome,
} from "./runFinalizeAuthority.js";
import { type AttemptSignature, decideConvergence, fixedPointRuleJudgment } from "./convergenceDetector.js";

const log = createLogger("run-redrive");

// Re-exported so the historical import sites (tests, the worker wiring) keep their imports
// pointed at this module while the backoff helper lives in the authority core.
export { redriveBackoffSeconds };

/** Facts a fixed-point read needs: the spec + its org + the failure code + the work signature now seen. */
export interface RedriveHistoryFacts {
  orgId: string;
  specId: string;
  /** The classified failure code of the CURRENT failure (one fixed-point axis). */
  code: RunFailureCode;
  /** The produced-work signature of the CURRENT run (the head/commit sha), when observable. */
  workSignature?: string;
}

/**
 * Read the FIXED-POINT streak for a spec — the count of CONSECUTIVE prior re-drives that are
 * structurally INDISTINGUISHABLE from the current one (same failure code AND, when both
 * observed, the same produced-work signature). Computed via the shared `convergenceDetector`
 * over the spec's `dag.spec.redriven` history. A DIFFERENT failure code OR DIFFERENT produced
 * work (PROGRESS) breaks the streak, so the loop is UNBOUNDED while it keeps changing; the
 * authority escalates ONLY once the streak shows a proven fixed point (the prior attempt was
 * already identical). Returns the count of PRIOR identical attempts (0 ⇒ progress / first).
 */
export type RedriveHistoryReader = (facts: RedriveHistoryFacts) => Promise<number>;

/**
 * The Pg-backed {@link RedriveHistoryReader} the run worker wires: an org-scoped read of the
 * spec's prior `dag.spec.redriven` events (newest first), assembled into the shared
 * convergence-detector history (failure code + work signature per attempt) with the CURRENT
 * attempt appended — then `decideConvergence` (routed through the principled fixed-point judge)
 * decides progress vs a proven fixed point.
 *
 * FAIL-CLOSED toward RE-DRIVING (not toward stranding): a read failure logs loudly and
 * returns 0 (treat as progress / first of its kind) — a transient DB hiccup must NOT cause a
 * spurious escalation to `needs_attention`; the fixed-point detection still bites once the
 * read recovers.
 */
export function buildRedriveHistoryReader(pool: pg.Pool): RedriveHistoryReader {
  return async (facts) => {
    try {
      return await runWithOrgScope(pool, facts.orgId, async (client) => {
        const result = await client.query<{ payload: { failureCode?: string; workSignature?: string } }>(
          `SELECT payload FROM events
             WHERE spec_id = $1 AND event_type = 'dag.spec.redriven'
             ORDER BY ts ASC, id ASC`,
          [facts.specId],
        );
        // Assemble the oldest→newest attempt history (each prior re-drive's failure code +
        // work signature) and append the CURRENT attempt, then route the escalation decision
        // through the shared convergence judge (below). 1 ⇒ a proven fixed point (the authority
        // escalates); 0 ⇒ progress (a changing failure / work, or a not-yet-cyclic repeat).
        const history: AttemptSignature[] = result.rows.map((row) => ({
          failureSignature: row.payload.failureCode ?? "",
          ...(row.payload.workSignature !== undefined && { workSignature: row.payload.workSignature }),
        }));
        history.push({
          failureSignature: facts.code,
          ...(facts.workSignature !== undefined && { workSignature: facts.workSignature }),
        });
        // Route the escalation decision through the SHARED `decideConvergence` judge — NOT a raw
        // `=== "fixed_point"` boolean (the disguised-K=2 the audit flagged). There is no answerer
        // at the durable re-drive point (it is a bare DB-driven decision), so `fixedPointRuleJudgment`
        // is the principled stand-in: it escalates ONLY at a PROVEN dead-end (a byte-identical
        // reproduced head, or a cycle with no progress). `priorSameFixedPoint` = 1 when the judge
        // escalates, 0 while progressing — the authority escalates only when this is >= 1.
        const decision = await decideConvergence(history, (h) =>
          fixedPointRuleJudgment(
            h,
            () =>
              `the run reached a FIXED POINT (${facts.code}) — it produced the identical failure and ` +
              `identical work with no new information across re-drives; the spec is genuinely stuck`,
          ),
        );
        return decision.decision === "escalate" ? 1 : 0;
      });
    } catch (error) {
      log.warn(
        "fixed-point read failed (fail-closed toward re-drive: treat as progress / first of its kind)",
        { specId: facts.specId },
        error,
      );
      return 0;
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
 *
 * Task #48 (run/spec atomicity sweep): the disposition appliers below now route the
 * spec-status flip + its dag event through ONE atomic seam (`updateSpecWithEvent`)
 * and the genuine-halt run-finalize + `run.failed` event through ONE atomic seam
 * (`finalizeRunWithEvent`) — so the split row-write/event-append strand the prior
 * code was vulnerable to is now closed. The legacy seams (`finalizeNonPass`,
 * `setSpecStatus`, `finalizeRunState`) are retained because the merge/non-pass
 * finalize paths in `plannerRunFinalize.ts` still call them for the
 * RUN-LEVEL finalize on the RE-DRIVE path (no `run.failed` paired today —
 * re-drive is a recoverable halt + a spec re-open, the event is `dag.spec.redriven`,
 * not `run.failed`).
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
  /**
   * ATOMIC spec-status flip + spec-disposition event (task #48 Site A/B): flips
   * the spec status AND appends the matching `dag.spec.*` event in ONE org-scoped
   * transaction so the flip + event live or die together. Replaces the prior
   * `setSpecStatus(...)` + `appendEvent(...)` split. Returns whether the
   * guarded UPDATE moved a row — `false` ⇒ the caller already suppressed
   * the event (the applier handled the no-op).
   */
  updateSpecAtomic: (spec: { status: string; notFromStatuses?: string[] }, event: AppendEventInput) => Promise<void>;
  /**
   * ATOMIC genuine-halt RUN finalize + `run.failed` event (task #48 Site B):
   * runs the row UPDATE + the `run.failed` event INSERT in ONE org-scoped
   * transaction. Carries the run-id internally; the caller supplies the
   * pairing data. Suppresses the event on a no-row-moved outcome.
   */
  finalizeGenuineHaltAtomic: (event: AppendEventInput) => Promise<void>;
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
  const facts = await readConvergenceFacts(ctx, outcome);
  const disposition = decideRunDisposition(outcome, facts);
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

/** Resolve the run's projectId from `ctx.context` (the planner-run context carries it). */
function resolveProjectId(ctx: DispositionContext): string {
  const projectId = (ctx.context as { projectId?: unknown }).projectId;
  return typeof projectId === "string" ? projectId : "";
}

/** Apply a RE-DRIVE: halt the run recoverable, return the spec to `open`, emit `dag.spec.redriven`.
 *
 * Task #48 Site A: the spec flip + `dag.spec.redriven` event are now ATOMIC
 * (`updateSpecAtomic` — `applyUpdateSpecWithEvent`), so a crash/DB failure
 * between the row UPDATE and the event INSERT no longer strands the spec
 * `open` with no `dag.spec.redriven` event (or vice versa). The
 * `finalizeNonPass` run-level finalize remains separate — re-drive does NOT
 * emit `run.failed` today (the re-drive shape is `dag.spec.redriven`, not
 * a terminal run failure), so there is no run-level pair to atomize. */
async function applyRedrive(
  ctx: DispositionContext,
  seams: DispositionSeams,
  disposition: Extract<RunDisposition, { bucket: "re_drive" }>,
): Promise<void> {
  await seams.finalizeNonPass(disposition.runOutcome);
  // A re-drive WITH a classified failure emits the OBSERVABLE `dag.spec.redriven` (the
  // consecutive-same-failure counter rides it so the bound is visible on the timeline). A
  // NO-FAULT re-drive (an ancestor-wait / a merge hold) carries no failure code and so does
  // not count toward the cap — it re-opens silently (its own event, if any, is the caller's).
  if (disposition.failure === undefined) {
    // No event to pair → fall back to the bare status flip (no atomic seam needed).
    await seams.setSpecStatus("open");
    return;
  }
  await seams.updateSpecAtomic(
    { status: "open" },
    {
      runId: ctx.context.runId,
      specId: ctx.context.specId,
      projectId: resolveProjectId(ctx),
      eventType: "dag.spec.redriven",
      payload: {
        specId: ctx.context.specId,
        runId: ctx.context.runId,
        failureCode: disposition.failure.code,
        stage: disposition.failure.stage,
        consecutiveSameFailure: disposition.consecutiveSameFailure,
        backoffSeconds: disposition.backoffSeconds,
      },
    },
  );
}

/** Apply a GENUINE-HALT: land the run `failed`, park the spec `needs_attention` with a specific reason.
 *
 * Task #48 Site B: BOTH the run-level (`run.failed` paired with the row finalize)
 * AND the spec-level (`dag.spec.needs_attention` paired with the
 * `needs_attention` flip) are now ATOMIC pairs. Plan §8 risk: today
 * `applyGenuineHalt` does NOT emit a `run.failed` event — only
 * `dag.spec.needs_attention`. The plan recommends ADDING the `run.failed`
 * emit (paired with the row finalize). The worker-orphan path in
 * `runFinalize.ts` DOES emit `run.failed` (status `halted`), but only for
 * runs the workflow's own finalizer never reached; the partial unique index
 * `events_run_terminal_unique` + `appendIfAbsent` dedup any race. Adding
 * `run.failed` here is the natural close — the timeline now carries
 * `run.failed` for EVERY terminal-`failed` run, not just orphaned ones.
 * The reads that key off `run.failed` (`sensitivityRules`, the notification
 * `eventDefaultSeverity` matrix, the run-progress subscriber) all treat it
 * as a PUBLIC fail signal — none key off its ABSENCE, so adding the emit
 * cannot regress an existing reader. */
async function applyGenuineHalt(
  ctx: DispositionContext,
  seams: DispositionSeams,
  disposition: Extract<RunDisposition, { bucket: "genuine_halt" }>,
): Promise<void> {
  await seams.finalizeGenuineHaltAtomic({
    runId: ctx.context.runId,
    specId: ctx.context.specId,
    projectId: resolveProjectId(ctx),
    eventType: "run.failed",
    payload: {
      status: "failed",
      // The disposition's failure carries the public-safe classified code +
      // stage + message (the same shape `runFinalize.ts` emits for the
      // worker-orphan path). A FAULTLESS genuine-halt (e.g. the merge-stage
      // `needs_attention` outcome — a real human-decision) carries no
      // failure; pad with a safe `genuine_halt` code so the registry-typed
      // payload still parses.
      failureCode: disposition.failure?.code ?? "genuine_halt",
      stage: disposition.failure?.stage ?? "finalize",
      message: disposition.message,
    },
  });
  await seams.updateSpecAtomic(
    { status: "needs_attention" },
    {
      runId: ctx.context.runId,
      specId: ctx.context.specId,
      projectId: resolveProjectId(ctx),
      eventType: "dag.spec.needs_attention",
      payload: {
        source: "strand",
        specId: ctx.context.specId,
        reason: disposition.reason,
        terminalRuns: [{ runId: ctx.context.runId, status: "failed" }],
        attempts: disposition.consecutiveSameFailure,
        message: disposition.message,
      },
    },
  );
}

/**
 * Read the CONVERGENCE FACTS (the fixed-point streak) via the wired reader. `0` ⇒ progress /
 * first of its kind / no reader / no fault (⇒ ALWAYS re-drive). The reader returns 1 only at
 * a proven fixed point (the prior attempt was structurally identical), which is when the
 * authority escalates — no hardcoded count.
 */
async function readConvergenceFacts(ctx: DispositionContext, outcome: TerminalOutcome): Promise<ConvergenceFacts> {
  // Only an error / non-pass outcome carries a counted failure code; probe a disposition at
  // progress (0) to recover the code. A merge / ancestor-wait outcome never reaches the
  // fixed-point rule, so the facts are immaterial (return progress).
  const probe = decideRunDisposition(outcome, { priorSameFixedPoint: 0 });
  const code = probe.bucket === "converge" ? undefined : probe.failure?.code;
  const reader = ctx.input.redriveHistoryReader;
  const orgId = typeof ctx.context.orgId === "string" ? ctx.context.orgId : undefined;
  if (reader === undefined || orgId === undefined || code === undefined) return { priorSameFixedPoint: 0 };
  const priorSameFixedPoint = await reader({ orgId, specId: ctx.context.specId, code });
  return { priorSameFixedPoint };
}
