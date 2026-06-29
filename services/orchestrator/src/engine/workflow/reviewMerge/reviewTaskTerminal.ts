// AUDIT FINDING #6 (PR #711) + AUDIT FINDING D2 (writer-seam doctrine sweep):
// the review-kind task terminal pair, now FULLY atomic across all three
// writes. PR #711 routed the pre-terminal `review.*` event through the writer
// seam (`writer.append`) AND the row UPDATE + `task.completed` through the
// atomic seam (`writer.updateTaskWithEvent`) — but those were still TWO
// separate transactions, with the PR file header explicitly noting "A future
// writer-seam extension can collapse the pre-event into the same tx". This is
// that extension. `RunStateWriter.updateTaskWithEvent` now carries an optional
// `priorEvents` array; the applier appends those events on the SAME
// in-transaction client BEFORE the row UPDATE + terminal event, so a
// crash/DB failure anywhere in the bundle rolls back the WHOLE thing — the
// `review.*` observation, the row terminal flip, and the matching
// `task.completed` event live or die together (autonomy-engine.md §1c
// single-finalize invariant, now extended to the pre-terminal observation).
//
// One writer call, one transaction, no half-measure.

import type { RunStateWriter } from "../../contracts/runStateWriter.js";
import type { PriorEventInput } from "../../eventStore.js";

export interface ReviewTaskTerminalBase {
  runId: string;
  specId: string;
  projectId: string;
  taskId: string;
}

/**
 * Atomic review-task terminal triplet: the pre-terminal `review.*` verdict
 * event (`review.approved` / `review.changes_requested`), the row UPDATE,
 * and the matching `task.completed` event, all committed together in ONE
 * org-scoped transaction via `writer.updateTaskWithEvent`'s `priorEvents`
 * bundle. The `status` carried on the `task.completed` payload mirrors the
 * verdict so downstream consumers (dashboard phase, review-stall insight)
 * react unchanged.
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
  // consumers key off this event). Bundled into the SAME atomic transaction
  // as the terminal row + `task.completed` via the writer-seam `priorEvents`
  // extension — collapses what used to be a separate `writer.append()` call
  // into ONE commit alongside the terminal pair.
  //
  // Round-3 audit finding H-R3.2: the prior-event entry carries a stable
  // idempotency key so a retried atomic write deduplicates the verdict event
  // on (run_id, idempotency_key) instead of double-emitting. Key shape
  // `${runId}:review:${verdict}` keys the verdict to its run + outcome, so a
  // retry of THIS finalize call dedupes cleanly; a subsequent flip of the
  // verdict (e.g. an explicit re-review with a DIFFERENT outcome) would carry
  // a distinct key and land afresh.
  const eventType = verdict === "approved" ? "review.approved" : "review.changes_requested";
  const verdictEvent: PriorEventInput =
    verdict === "approved"
      ? {
          ...base,
          eventType,
          payload: { prUrl, prNumber, ...(reviewer !== undefined && { reviewer }) } as never,
          idempotencyKey: `${base.runId}:review:${verdict}`,
        }
      : {
          ...base,
          eventType,
          payload: {
            prUrl,
            prNumber,
            ...(reviewer !== undefined && { reviewer }),
            ...(feedback !== undefined && { message: feedback }),
          } as never,
          idempotencyKey: `${base.runId}:review:${verdict}`,
        };
  await writer.updateTaskWithEvent({
    task: { taskId: base.taskId, transition: "done", outcome: "ok" },
    event: {
      ...base,
      eventType: "task.completed",
      payload: { taskKind: "review", status: verdict } as never,
    },
    priorEvents: [verdictEvent],
  });
}
