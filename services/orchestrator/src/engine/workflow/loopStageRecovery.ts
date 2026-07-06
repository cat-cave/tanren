// SHARED loop-stage answerer-stall RECOVERY (Phase-2: loop-stage answerer stall →
// recoverable stage re-drive, not whole-spec restart).
//
// THE GAP this closes (feedback_no_timeouts_progress_based + feedback_robustness_over_recovery,
// both BINDING): every spec-loop STAGE that calls a single answerer — checker, auditor,
// triage, convergence, demo-run, design-oracle — used to let a TRANSIENT provider stall
// (`AnswererStalledError`, surfaced by the ActivityWatchdog) propagate straight out of
// `runSubtaskLoop` → `plannerRun` re-drove the WHOLE spec (re-plan from scratch, every
// passed subtask + writer diff redone). A stall is NON-deterministic — the next identical
// call almost always succeeds — so throwing away a whole spec loop's legitimate progress on
// one is a robustness defect (and, with the watchdog now SURFACING stalls on long answerer
// calls, a likely apex halt family). The WRITER path already has this in-loop recovery
// (subtaskInnerLoop.ts); the AUDITOR already recovers a *schema* miss (auditorStage.ts).
//
// THE FIX: `runAnswererStageWithRecovery` wraps a stage's single answerer invocation in the
// shared, UNBOUNDED, progress-based `retryUntilConverged` primitive. A transient stall is
// fed as its OWN attempt signature into `decideConvergence`, so:
//   - a transient stall (succeeds on a re-drive) → the stage re-drives IN PLACE and the spec
//     loop's sibling progress is PRESERVED (no whole-spec restart);
//   - a genuinely-wedged stage (a stall on EVERY re-drive — the IDENTICAL failure signature
//     with no new information) → the convergence detector reaches a PROVEN fixed point and
//     the helper escalates LOUDLY via `StageStallEscalationError` (NOT a count / cap), which
//     propagates to the workflow catch-all exactly as the stall did before — but only after
//     the stage genuinely could not recover, never on the first transient blip.
// A genuine DETERMINISTIC error (schema/contract miss, usage-limit, infra crash) is NOT a
// transient stall, so it is NOT re-driven here — it propagates to the stage's own handling
// (the auditor's schema-miss → synthetic-P0, the usage-limit window escalation, etc.).

import { AnswererStalledError } from "../providers/answererSchemaError.js";
import { type AttemptSignature, fixedPointRuleJudgment } from "./convergenceDetector.js";
import { retryUntilConverged } from "./retryUntilConverged.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("loop-stage-recovery");

// A genuinely-wedged stage: the SAME answerer stalled on EVERY re-drive (a proven fixed
// point — identical failure signature, no new information), so the convergence judgment
// escalated. LOUD (never a silent degrade): it propagates to the workflow catch-all that
// finalizes the run as a parked needs_attention, exactly like the bare stall throw did
// before this wrapper — but only after the stage demonstrably could not recover, and WITHOUT
// nuking the spec loop's sibling progress on a single transient blip.
export class StageStallEscalationError extends Error {
  constructor(
    readonly stage: string,
    reason: string,
  ) {
    super(`Loop stage "${stage}" did not recover from repeated answerer stalls: ${reason}`);
    this.name = "StageStallEscalationError";
  }
}

/**
 * Run ONE loop-stage answerer invocation with TRANSIENT-stall recovery. `invoke` runs the
 * stage's single answerer call (the same inputs each time — a stall is non-deterministic, so
 * the SAME call is what recovers it). On success the stage's result is returned. On an
 * `AnswererStalledError` the SAME stage is re-driven, UNBOUNDED, while the stalls keep
 * arriving — the shared `retryUntilConverged` only escalates at a PROVEN fixed point (every
 * attempt the identical stall, no new information), where the wedged stage throws
 * `StageStallEscalationError` (loud, not a count). Any NON-stall error propagates verbatim —
 * a deterministic schema/usage-limit/infra failure is not a transient stall and is left to
 * the stage's own handling.
 *
 * `stage` is the stable stall signature (the answerer role) the convergence detector keys
 * the fixed point off — so a genuinely-wedged stage escalates, while a transient stall
 * (which then succeeds) reads as progress (`done`) and never escalates.
 *
 * OBSERVABILITY (Codex critic #13): the helper opts in to `retryUntilConverged`'s
 * `onAttempt` hook so every iteration emits a durable `<stage>.retrying` structured log
 * line with `{ stage, attempt, decision, failureSignature }`. Previously the wrapper
 * only logged a warn on the catch branch (visible per stall, but not the attempt count /
 * decision / eventual success), which left a silently-spinning stage invisible in
 * production. Now an operator can tail the log stream and see WHICH stage is spinning,
 * how many re-drives it has taken, and whether the loop is progressing or escalating —
 * the plan / writer / checker / auditor / triage / convergence / demo / designOracle
 * stages all route through this wrapper, so each of them inherits the observability.
 */
export async function runAnswererStageWithRecovery<T>(stage: string, invoke: () => Promise<T>): Promise<T> {
  const outcome = await retryUntilConverged<T | undefined>({
    attempt: async (): Promise<{ result: T | undefined; signature: AttemptSignature; done: boolean }> => {
      try {
        const result = await invoke();
        // The stage answerer returned an answer — SUCCESS. `done: true` returns at once with
        // no convergence check (success needs no fixed-point assessment). The signature is
        // recorded for completeness but never consulted once `done`.
        return { result, signature: { failureSignature: `${stage}:ok` }, done: true };
      } catch (error) {
        // ONLY a transient stall is recoverable here — re-drive the SAME stage. A
        // deterministic error (schema/contract/usage-limit/infra) is NOT a stall and
        // propagates to the stage's own handling. The stall's signature is STABLE (the
        // stage role): an identical stall on every attempt converges to a fixed point (a
        // genuinely-wedged stage → escalate), while a stall that then SUCCEEDS reads as
        // progress (the next attempt is `done`) and never escalates.
        if (!(error instanceof AnswererStalledError)) throw error;
        log.warn("answerer stalled — re-driving the SAME stage (transient, sibling progress preserved)", { stage });
        return { result: undefined, signature: { failureSignature: `${stage}:stalled` }, done: false };
      }
    },
    // No agent to ask at this point — the rigorous fixed-point rule stands in. It escalates
    // ONLY once the stall is a PROVEN fixed point (the identical stall recurred with no new
    // information), with a specific, human-actionable diagnosis. NOT a count.
    judge: (history) =>
      fixedPointRuleJudgment(
        history,
        () => `the ${stage} answerer stalled (no sign of life) on every re-drive — the runner or provider is wedged`,
      ),
    // Codex critic #13: emit a `<stage>.retrying` structured log per iteration so an
    // operator can watch the stall-recovery loop live. `info.attempt` counts every
    // iteration (including the successful `done` one and the escalating one), so a tail
    // of this stream directly answers "is a stage silently spinning, and where is it in
    // the loop?". The primitive stays silent; observability is opt-in at the call site.
    onAttempt: (info) => {
      log.info(`${stage}.retrying`, {
        stage,
        attempt: info.attempt,
        decision: info.decision,
        failureSignature: info.signature.failureSignature,
      });
    },
  });
  if (outcome.kind === "escalate") {
    // PROVEN fixed point: the stage stalled on every re-drive. Escalate LOUDLY (the workflow
    // catch-all finalizes a parked needs_attention) — never a silent fallback to a default.
    throw new StageStallEscalationError(stage, outcome.reason);
  }
  // `done`: the stage's answerer returned an answer (possibly after a transient stall the
  // loop re-drove through). `result` is the real stage result — never `undefined` on `done`
  // (a `done` attempt always carries the genuine answer; `undefined` is only the stall
  // placeholder, which never reaches a `done` outcome).
  return outcome.result as T;
}
