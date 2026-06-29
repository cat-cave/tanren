// AUDIT FINDING #6 — the review-kind task terminal pair. PR #690 made the
// merge-kind task terminal atomic but the sibling review-kind terminal in
// `finalizeReviewTask` stayed three sequential writes (row UPDATE → `review.*`
// event → `task.completed` event) with no transaction. Apex doesn't currently
// exercise live human review polling — doctrine, not blocking — but a Tier-3
// governance run would expose the same strand class the merge fix closed.
//
// Mirrors `mergeTaskTerminal.markMergeTaskDoneWithEvent`: the §1c-critical
// terminal pair (row + `task.completed`) lands atomically through the writer
// seam (`updateTaskWithEvent`); the pre-terminal `review.*` observation event
// lands BEFORE through the SAME writer surface (`writer.append`), so all three
// writes route through the same writer (the production atomic seam). The
// pre-terminal event is not in the same transaction as the row+terminal pair —
// that would require a new writer-seam variant carrying a `priorEvents[]` (the
// terminalPairSchema only admits ONE terminal event); the doctrine-critical
// atomicity (row + terminal event) is what §1c guards, and that part IS atomic
// here. A future writer-seam extension can collapse the pre-event into the
// same tx; this PR scopes to the helper-purity + atomic-terminal fix the
// merge-kind sibling already shipped.

import type { RunStateWriter } from "../../contracts/runStateWriter.js";

export interface ReviewTaskTerminalBase {
  runId: string;
  specId: string;
  projectId: string;
  taskId: string;
}

/**
 * Atomic review-task terminal pair: append the verdict event (`review.approved`
 * / `review.changes_requested`) then commit the row UPDATE + `task.completed`
 * atomically via `writer.updateTaskWithEvent`. All three writes flow through
 * the same writer seam. The `status` carried on the `task.completed` payload
 * mirrors the verdict so downstream consumers (dashboard phase, review-stall
 * insight) react unchanged.
 */
export async function markReviewTaskDoneWithEvent(input: {
  writer: RunStateWriter;
  base: ReviewTaskTerminalBase;
  verdict: "approved" | "changes_requested";
  prUrl: string;
  prNumber: number;
  reviewer?: string;
  /** changes_requested feedback body (the writer-rework steering payload). */
  feedback?: string;
}): Promise<void> {
  const { writer, base, verdict, prUrl, prNumber, reviewer, feedback } = input;
  // PRE-TERMINAL verdict event (the loud `review.*` observation, downstream
  // consumers key off this event). Routed through the writer's EventStore
  // surface so all three review-terminal writes flow through the same seam.
  if (verdict === "approved") {
    await writer.append({
      ...base,
      eventType: "review.approved",
      payload: { prUrl, prNumber, ...(reviewer !== undefined && { reviewer }) } as never,
    });
  } else {
    await writer.append({
      ...base,
      eventType: "review.changes_requested",
      payload: {
        prUrl,
        prNumber,
        ...(reviewer !== undefined && { reviewer }),
        ...(feedback !== undefined && { message: feedback }),
      } as never,
    });
  }
  // TERMINAL row + event atomic pair (the §1c single-finalize guarantee).
  await writer.updateTaskWithEvent({
    task: { taskId: base.taskId, transition: "done", outcome: "ok" },
    event: {
      ...base,
      eventType: "task.completed",
      payload: { taskKind: "review", status: verdict } as never,
    },
  });
}
