// Success-path run finalize: row → completed/ok + `run.completed` event in ONE
// org-scoped transaction. Three-arm dispatch (R5 #1 + #2 fixes / tasks #49+#50):
// (1) writer+orgId → remote atomic; (2) orgId, no writer → in-process direct
// atomic via runWithOrgScope; (3) no orgId → unit-test legacy split.
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
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
  const orgId = typeof context.orgId === "string" ? context.orgId : undefined;
  // events.org_id is NOT NULL + AppendEventInput requires explicit `orgId` (v68
  // fix): both atomic-applier paths below carry it on the event so the row lands
  // tenant-scoped. The unit-test fallback at the bottom (no-org / no-pool) emits
  // via the appendEvent closure, which adds orgId itself.
  const evt = (eventOrgId: string) => ({
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    orgId: eventOrgId,
    eventType: "run.completed" as const,
    payload: { status: "completed", outcome: "ok" },
  });
  if (input.runStateWriter !== undefined && orgId !== undefined) {
    await input.runStateWriter.finalizeRunWithEvent({
      finalize: {
        runId: context.runId,
        orgId,
        status: "completed",
        outcome: "ok",
        fromStatuses: ["running", "queued"],
      },
      event: evt(orgId),
    });
    return;
  }
  if (orgId !== undefined && typeof (input.pool as { connect?: unknown }).connect === "function") {
    const finalizeInput = {
      runId: context.runId,
      orgId,
      status: "completed",
      outcome: "ok",
      fromStatuses: ["running", "queued"],
    };
    await runWithOrgScope(input.pool as unknown as pg.Pool, orgId, async (client) => {
      await applyFinalizeRunWithEvent(client, { finalize: finalizeInput, event: evt(orgId) });
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
