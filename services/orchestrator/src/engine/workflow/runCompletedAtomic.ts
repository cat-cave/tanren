// Success-path run finalize: row → completed/ok + `run.completed` event in ONE
// org-scoped transaction. Two-arm dispatch (R5 #1 + #2 fixes / tasks #49+#50):
// (1) writer wired → remote atomic; (2) else → in-process direct atomic via
// runWithOrgScope on a real pool; else → unit-test legacy split (fake pool).
// The prior third arm (no orgId → legacy split) is gone: `PlannerRunContext.orgId`
// is REQUIRED by the hydration invariant (a run is always tenant-scoped).
import { runWithOrgScope } from "@tanren/db";
import { isPool } from "../data/orgScopedDb.js";
import type { EventName, EventPayload } from "../events/index.js";
import type { FinalizeRunState } from "./plannerRunFinalize.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "./plannerRun.js";
import { applyFinalizeRunWithEvent } from "../worker/runStateAtomicSql.js";

export async function finalizeRunCompletedAtomic(
  input: RunPlannerLoopInput,
  finalizeRunState: FinalizeRunState,
  context: PlannerRunContext,
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
): Promise<void> {
  // `PlannerRunContext.orgId` is a REQUIRED non-empty string (hydration enforces
  // the tenant-scope invariant); both atomic-applier paths carry it on the event
  // so the row lands tenant-scoped. The fake-pool fallback at the bottom emits
  // via the appendEvent closure, which adds orgId itself.
  const orgId = context.orgId;
  const evt = () => ({
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    orgId,
    eventType: "run.completed" as const,
    payload: { status: "completed", outcome: "ok" },
  });
  if (input.runStateWriter !== undefined) {
    await input.runStateWriter.finalizeRunWithEvent({
      finalize: {
        runId: context.runId,
        orgId,
        status: "completed",
        outcome: "ok",
        fromStatuses: ["running", "queued"],
      },
      event: evt(),
    });
    return;
  }
  // Real pool (or orgScopingPool proxy) → org-scoped atomic finalize; unit-test
  // fakes lack `.connect` and take the split path below. `isPool` narrows without cast.
  if (isPool(input.pool)) {
    const finalizeInput = {
      runId: context.runId,
      orgId,
      status: "completed",
      outcome: "ok",
      fromStatuses: ["running", "queued"],
    };
    await runWithOrgScope(input.pool, orgId, async (client) => {
      await applyFinalizeRunWithEvent(client, { finalize: finalizeInput, event: evt() });
    });
    return;
  }
  await finalizeRunState(
    "completed",
    "ok",
    ["running", "queued"],
    "UPDATE runs SET status = 'completed', outcome = 'ok', ended_at = now() WHERE run_id = $1",
    [context.runId],
  );
  await appendEvent("run.completed", { status: "completed", outcome: "ok" });
}
