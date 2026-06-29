// AUDIT FINDING #5 — the TEST-ONLY direct split-write seam for the dispatcher's
// finalize when no `RunStateWriter` is wired. The HELPER
// (`markMergeTaskDoneWithEvent` / `markMergeTaskFailedWithEvent` in
// `mergeTaskTerminal.ts`) is doctrine-pure: writer is REQUIRED, no fallback
// arm inside. Production always wires the writer, so this path is unreachable
// in production — only merge-stage unit tests that build the dispatcher
// without a workflow-level writer (`mergeDispatcherConflictAuthority.*`,
// `mergeLandReGateOnBaseShift.*`, etc.) reach it. The split-write IS the
// pre-#5 shape, preserved verbatim here so the bounded scope of the audit-#5
// lift is "ban the fallback INSIDE the helper", not "rewrite every merge-stage
// test to wire a workflow-level writer". Extracted to its own file so the
// dispatcher stays under the 500-line architecture cap.

import type pg from "pg";
import type { RunStateWriter } from "../../contracts/runStateWriter.js";
import type { EventStore } from "../../eventStore.js";
import { routeTaskUpdate } from "../taskWriteRouting.js";
import { markMergeTaskDoneWithEvent, type MergeTaskTerminalBase } from "./mergeTaskTerminal.js";

type DispatcherPool = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * The speculative-hold's terminal-task completion, replacing the deleted
 * `completeHeldMergeTask`. Production has a writer wired and routes through the
 * doctrine-pure atomic helper; the writer-undefined branch is the TEST-ONLY
 * split-write seam (see the file header for the rationale). One source of truth.
 */
export async function completeHeldMergeTask(
  writer: RunStateWriter | undefined,
  pool: DispatcherPool,
  eventStore: EventStore,
  base: MergeTaskTerminalBase,
  integration: string,
): Promise<void> {
  if (writer === undefined) {
    await finalizeDirectSplitDone(pool, eventStore, base, integration);
    return;
  }
  await markMergeTaskDoneWithEvent({ writer, base, integration });
}

export async function finalizeDirectSplitDone(
  pool: DispatcherPool,
  eventStore: EventStore,
  base: MergeTaskTerminalBase,
  integration: string,
): Promise<void> {
  await routeTaskUpdate(
    undefined,
    pool,
    { taskId: base.taskId, transition: "done", outcome: "ok" },
    "UPDATE tasks SET status = 'done', outcome = $2, ended_at = now() WHERE task_id = $1",
    [base.taskId, "ok"],
  );
  await eventStore.append({
    ...base,
    eventType: "task.completed",
    payload: { taskKind: "merge", status: integration },
  });
}

export async function finalizeDirectSplitFailed(
  pool: DispatcherPool,
  eventStore: EventStore,
  base: MergeTaskTerminalBase,
  failureKind: string,
): Promise<void> {
  await routeTaskUpdate(
    undefined,
    pool,
    { taskId: base.taskId, transition: "failed_with_kind", failureKind },
    "UPDATE tasks SET status = 'failed', outcome = 'failed', failure_kind = $2, ended_at = now() WHERE task_id = $1",
    [base.taskId, failureKind],
  );
  await eventStore.append({
    ...base,
    eventType: "task.failed",
    payload: { taskKind: "merge", failureKind },
  });
}
