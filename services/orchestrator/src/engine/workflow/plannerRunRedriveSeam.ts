// apex v67 fixes #119 + #120 — RE-DRIVE halt observability. The atomic three-arm
// seam that flips a run to `halted` (the recoverable outcome) paired with the
// `run.failed` event AND the internal `job_queue.failure_message` capture,
// extracted from `plannerRunFinalize.ts` (500-line cap). Mirrors
// `plannerRunPauseSeam.ts`'s three-arm shape.
//
// The prior re-drive path emitted ONLY the spec-side `dag.spec.redriven` event —
// NO public `run.failed` (watchers/observers/UI that key on the canonical halt
// event were blind to this halt class), and NO raw error capture on
// `job_queue.failure_message` (the worker-level `runExecutor.ts`
// `job_queue.failure_message` write only fires on the WORKER catch — the
// workflow's re-drive catch never reaches it). apex v67's halted spec ran 1h47m
// through three wandering failure codes with ZERO actionable detail.
//
// This seam runs THREE writes in ONE org-scoped transaction (in-process path):
//   1. UPDATE runs SET status='halted', outcome=<runOutcome>
//   2. Append `run.failed` event (paired via `events_run_terminal_unique` partial
//      unique index — Class B idempotency on a retried commit)
//   3. UPDATE job_queue.failure_message for this run's CLAIMED `running` job
//      (internal-only, outside RLS; the org-scoped GUC does not gate job_queue —
//      it is the worker's bootstrap source)
// A throw anywhere rolls back the whole tx — the run is never stranded `halted`
// without its `run.failed` event. The REMOTE writer path runs the run+event
// atomically server-side, then issues a best-effort `failure_message` UPDATE
// against the worker's pool (logged loudly on a failure — never silent).

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { AppendEventInput } from "../eventStore.js";
import type { EventName, EventPayload } from "../events/index.js";
import { applyFinalizeRunWithEvent } from "../worker/runStateAtomicSql.js";
import { createLogger } from "../observability/logger.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "./plannerRun.js";
import type { FinalizeRunState } from "./plannerRunFinalize.js";

const log = createLogger("run-redrive-seam");

// Probe a real pg.Pool vs a fake unit-test stub (needs `.connect()` for runWithOrgScope).
const isRealPool = (p: unknown): boolean => typeof (p as { connect?: unknown }).connect === "function";

/** The seam input — every dep `dispositionSeams` already holds. */
export interface FinalizeRedriveSeamCtx {
  input: RunPlannerLoopInput;
  finalizeRunState: FinalizeRunState;
  context: PlannerRunContext;
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>;
  // `PlannerRunContext.orgId` is a REQUIRED non-empty string (hydration enforces
  // the tenant-scope invariant); this seam receives the SAME string, no null.
  orgId: string;
}

/** The seam payload — the run outcome to persist + the paired `run.failed` event +
 * the raw caught-error string for `job_queue.failure_message` (internal-only). */
export interface FinalizeRedriveSeamInput {
  runOutcome: "halted" | "convergence_stalled";
  runFailedEvent: AppendEventInput;
  rawErrorMessage: string;
}

/** SQL to capture the raw error string on the running job's `failure_message` column. */
const JOB_QUEUE_FAILURE_MESSAGE_SQL =
  "UPDATE job_queue SET failure_message = $2 WHERE run_id = $1 AND status = 'running'";

/** Two-arm dispatch: writer wired → remote atomic + best-effort failure_message;
 * else → in-process ONE-TX atomic (run+event+failure_message). The prior third
 * arm (no orgId → unit-test legacy split without failure_message) is gone:
 * `orgId` is required by the hydration invariant. A fake-pool unit test still
 * lands here on the second branch and falls through to the plain
 * `finalizeRunState` + `appendEvent` split when `isRealPool` returns false. */
export async function finalizeRedriveAtomicSeam(
  ctx: FinalizeRedriveSeamCtx,
  { runOutcome, runFailedEvent, rawErrorMessage }: FinalizeRedriveSeamInput,
): Promise<void> {
  const { input, finalizeRunState, context, appendEvent, orgId } = ctx;
  if (input.runStateWriter !== undefined) {
    // Remote atomic finalize + run.failed event (server-side org-scoped tx). The
    // failure_message capture is a separate best-effort write against the
    // worker's pool — job_queue is OUTSIDE RLS so no GUC scope is required,
    // and a failure is logged loudly (the run.failed event already landed; the
    // failure_message is internal-only triage detail).
    await input.runStateWriter.finalizeRunWithEvent({
      finalize: {
        runId: context.runId,
        orgId,
        status: "halted",
        outcome: runOutcome,
        fromStatuses: ["running", "queued"],
      },
      event: runFailedEvent,
    });
    await persistFailureMessageBestEffort(input.pool, context.runId, rawErrorMessage);
    return;
  }
  if (isRealPool(input.pool)) {
    // In-process atomic: runs UPDATE + run.failed event + job_queue
    // failure_message UPDATE in ONE org-scoped transaction.
    const finalizeInput = {
      runId: context.runId,
      orgId,
      status: "halted",
      outcome: runOutcome,
      fromStatuses: ["running", "queued"],
    };
    await runWithOrgScope(input.pool as unknown as pg.Pool, orgId, async (client) => {
      const outcome = await applyFinalizeRunWithEvent(client, { finalize: finalizeInput, event: runFailedEvent });
      // The workflow's earlier finalize already landed this run (or another
      // worker did) ⇒ skip the failure_message UPDATE too (there is no
      // `running` job_queue row left to capture against).
      if (!outcome.updated) return;
      await client.query(JOB_QUEUE_FAILURE_MESSAGE_SQL, [context.runId, rawErrorMessage]);
    });
    return;
  }
  // Unit-test legacy split: no real pool / no org scope, so no atomic tx and no
  // job_queue update (the FakeJobQueue is in-memory, not shared with this fake
  // pool). Emit through the existing seams so the test surface still sees the
  // row UPDATE + the run.failed event.
  await finalizeRunState(
    "halted",
    runOutcome,
    ["running", "queued"],
    "UPDATE runs SET status = 'halted', outcome = $2, ended_at = now() WHERE run_id = $1",
    [context.runId, runOutcome],
  );
  await appendEvent(runFailedEvent.eventType, runFailedEvent.payload, runFailedEvent.taskId);
}

/** INTERNAL-only raw-error capture on the REMOTE writer path. Best-effort UPDATE
 * against the worker's pool — the run.failed event has already committed, so a
 * failure here only degrades the triage detail, never the observable halt.
 * Logged loudly (NEVER silent degradation, per the standing "loud failures, full
 * detail" doctrine). */
async function persistFailureMessageBestEffort(
  pool: RunPlannerLoopInput["pool"],
  runId: string,
  rawErrorMessage: string,
): Promise<void> {
  try {
    if (!isRealPool(pool)) return;
    await (pool as unknown as pg.Pool).query(JOB_QUEUE_FAILURE_MESSAGE_SQL, [runId, rawErrorMessage]);
  } catch (error) {
    log.error(
      "re-drive failure_message capture failed (best-effort, surfaced — the run.failed event already landed)",
      { runId },
      error,
    );
  }
}
