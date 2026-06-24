// Success-path run finalize: row → completed/ok + `run.completed` event in ONE
// org-scoped transaction via the new `finalizeRunWithEvent` seam (#676's
// primitive). Critic-arc R5 #1 fix / task #49 — pre-fix the success path was
// row-only, leaving `runs.status='completed'` rows with no audit-trail
// terminal event. Mirrors `finalizeGenuineHaltAtomic` (failure path); same
// writer/org fallback rule for the unit-test harnesses that wire neither.
import type { EventName, EventPayload } from "../events/index.js";
import type { FinalizeRunState } from "./plannerRunFinalize.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "./plannerRun.js";

export async function finalizeRunCompletedAtomic(
  input: RunPlannerLoopInput,
  finalizeRunState: FinalizeRunState,
  context: PlannerRunContext,
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
): Promise<void> {
  const orgId = typeof context.orgId === "string" ? context.orgId : undefined;
  const evt = {
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    eventType: "run.completed" as const,
    payload: { status: "completed", outcome: "ok" },
  };
  if (input.runStateWriter !== undefined && orgId !== undefined) {
    await input.runStateWriter.finalizeRunWithEvent({
      finalize: {
        runId: context.runId,
        orgId,
        status: "completed",
        outcome: "ok",
        fromStatuses: ["running", "queued"],
      },
      event: evt,
    });
    return;
  }
  // Fallback for unit-test harnesses that wire neither writer nor org.
  await finalizeRunState(
    "completed",
    "ok",
    ["running", "queued"],
    "UPDATE runs SET status = 'completed', outcome = 'ok', ended_at = now() WHERE run_id = $1",
    [context.runId],
  );
  await appendEvent(evt.eventType, evt.payload);
}
