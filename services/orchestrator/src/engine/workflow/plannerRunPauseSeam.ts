// task #82 — window-pause auto-resume. The atomic three-arm seam that flips a
// run to the NEW non-terminal `paused` status (outcome `window_paused`) paired
// with the `run.paused` event, extracted from `plannerRunFinalize.ts` (500-line
// cap). The SPEC is intentionally untouched (no flip, no `dag.spec.*` event) —
// the walker reads it as still `in_flight` and does NOT enqueue a successor;
// the prober owns the resume. The `events_run_terminal_unique` partial unique
// index dedups any retried commit (task #40 Class B).

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { AppendEventInput } from "../eventStore.js";
import type { EventName, EventPayload } from "../events/index.js";
import { applyFinalizeRunWithEvent } from "../worker/runStateAtomicSql.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "./plannerRun.js";
import type { FinalizeRunState } from "./plannerRunFinalize.js";

// Probe a real pg.Pool vs a fake unit-test stub (needs `.connect()` for runWithOrgScope).
const isRealPool = (p: unknown): boolean => typeof (p as { connect?: unknown }).connect === "function";

/** The seam input — every dep `dispositionSeams` already holds. */
export interface FinalizePauseSeamCtx {
  input: RunPlannerLoopInput;
  finalizeRunState: FinalizeRunState;
  context: PlannerRunContext;
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>;
  orgId: string | undefined;
}

/** Run the three-arm dispatch: writer+orgId → remote atomic; orgId-only → in-process
 * direct atomic via `runWithOrgScope`'s BEGIN/COMMIT around `applyFinalizeRunWithEvent`;
 * no orgId → unit-test legacy split (direct SQL + append). Same shape as
 * `finalizeGenuineHaltAtomic` — only the status / outcome / event payload differ. */
export async function finalizePauseAtomicSeam(ctx: FinalizePauseSeamCtx, event: AppendEventInput): Promise<void> {
  const { input, finalizeRunState, context, appendEvent, orgId } = ctx;
  if (input.runStateWriter !== undefined && orgId !== undefined) {
    await input.runStateWriter.finalizeRunWithEvent({
      finalize: {
        runId: context.runId,
        orgId,
        status: "paused",
        outcome: "window_paused",
        fromStatuses: ["running", "queued"],
      },
      event,
    });
    return;
  }
  if (orgId !== undefined && isRealPool(input.pool)) {
    const finalizeInput = {
      runId: context.runId,
      orgId,
      status: "paused",
      outcome: "window_paused",
      fromStatuses: ["running", "queued"],
    };
    await runWithOrgScope(input.pool as unknown as pg.Pool, orgId, async (client) => {
      await applyFinalizeRunWithEvent(client, { finalize: finalizeInput, event });
    });
    return;
  }
  await finalizeRunState(
    "paused",
    "window_paused",
    ["running", "queued"],
    "UPDATE runs SET status = 'paused', outcome = 'window_paused', ended_at = now() WHERE run_id = $1",
    [context.runId],
  );
  await appendEvent(event.eventType, event.payload, event.taskId);
}
