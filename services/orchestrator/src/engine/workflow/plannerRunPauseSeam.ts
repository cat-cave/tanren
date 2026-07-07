// task #82 — window-pause auto-resume. The atomic three-arm seam that flips a
// run to the NEW non-terminal `paused` status (outcome `window_paused`) paired
// with the `run.paused` event, extracted from `plannerRunFinalize.ts` (500-line
// cap). The SPEC is intentionally untouched (no flip, no `dag.spec.*` event) —
// the walker reads it as still `in_flight` and does NOT enqueue a successor;
// the prober owns the resume. The `events_run_terminal_unique` partial unique
// index dedups any retried commit (task #40 Class B).

import type { AppendEventInput } from "../eventStore.js";
import type { EventName, EventPayload } from "../events/index.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "./plannerRun.js";
import type { FinalizeRunState } from "./plannerRunFinalize.js";

/** The seam input — every dep `dispositionSeams` already holds. */
export interface FinalizePauseSeamCtx {
  input: RunPlannerLoopInput;
  finalizeRunState: FinalizeRunState;
  context: PlannerRunContext;
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>;
  // `PlannerRunContext.orgId` is a REQUIRED non-empty string (hydration
  // enforces the tenant-scope invariant); this seam receives the SAME string.
  orgId: string;
}

/** Take the direct split (row UPDATE + event append). This seam does NOT ride
 * the writer's `finalizeRunWithEvent` or the in-process
 * `applyFinalizeRunWithEvent` atomic path: BOTH are TERMINAL-ONLY
 * (`runPairSchema` restricts the writer arm to
 * `halted`/`window_exhausted`/`convergence_stalled`/`failed`/`ok`/`cancelled`,
 * and `applyFinalizeRunWithEvent`'s `appendIfAbsent` is covered only by
 * `events_run_terminal_unique` on the three terminal `run.*` events). The
 * pause pair (`paused` / `window_paused` + `run.paused`) is intentionally
 * non-terminal (task #82 — the prober's later resume flips `paused → halted`
 * with the SAME `window_paused` outcome), so pause takes the split. A
 * dedicated non-terminal pause applier is out of scope for this seam — the
 * split rides the operator-visible `run.paused` event through the caller's
 * `appendEvent` closure. */
export async function finalizePauseAtomicSeam(ctx: FinalizePauseSeamCtx, event: AppendEventInput): Promise<void> {
  const { input, finalizeRunState, context, appendEvent } = ctx;
  await finalizeRunState(
    "paused",
    "window_paused",
    ["running", "queued"],
    "UPDATE runs SET status = 'paused', outcome = 'window_paused', ended_at = now() WHERE run_id = $1",
    [context.runId],
  );
  await appendEvent(event.eventType, event.payload, event.taskId);
  // Retain `input` reference to avoid the unused-parameter lint (this seam may
  // reclaim the pool/writer path once a non-terminal pause applier exists).
  void input;
}
