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
//
// gv-2: when a forge publication receipt is present (strict simulated review),
// it is bound onto the same atomic `review.approved` / `review.changes_requested`
// payload — no second audit store.

import type { RunStateWriter } from "../../contracts/runStateWriter.js";
import type { PriorEventInput } from "../../eventStore.js";
import type { ForgeReviewPublication } from "./simulatedReviewPublication.js";

export interface ReviewTaskTerminalBase {
  runId: string;
  specId: string;
  projectId: string;
  /** v68 fix: required tenant key stamped onto every event in this atomic triplet. */
  orgId: string;
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
  /**
   * Strict simulated-review forge receipt (gv-2). When present, bound onto the
   * terminal review.* event so land signals / UI observe the same durable proof.
   * Human/auto paths omit it.
   */
  forgePublication?: ForgeReviewPublication;
}): Promise<void> {
  const { writer, base, verdict, prUrl, prNumber, reviewer, feedback, forgePublication } = input;
  // PRE-TERMINAL verdict event (the loud `review.*` observation, downstream
  // consumers key off this event). Bundled into the SAME atomic transaction
  // as the terminal row + `task.completed` via the writer-seam `priorEvents`
  // extension — collapses what used to be a separate `writer.append()` call
  // into ONE commit alongside the terminal pair.
  //
  // Round-3 audit finding H-R3.2: the prior-event entry carries a stable
  // idempotency key so a retried atomic write deduplicates the verdict event
  // on (run_id, idempotency_key) instead of double-emitting. Key shape
  // `${runId}:review:${verdict}` is INTENTIONALLY run+verdict only (first-wins
  // finalize idempotency). A retry of THIS finalize call dedupes cleanly; a
  // subsequent flip of the verdict (e.g. an explicit re-review with a
  // DIFFERENT outcome) carries a distinct key and lands afresh.
  //
  // The forge review id is NOT part of the key. Under append-if-absent the
  // first successful commit wins: a contradictory second receipt for the same
  // run+verdict is suppressed and the durable payload (including any forge
  // receipt fields) remains that of the first winner. Callers that must
  // re-publish on a new head emit a different terminal path (re-review /
  // re-gate), not a second finalize of the same key.
  const eventType = verdict === "approved" ? "review.approved" : "review.changes_requested";
  const forgeFields =
    forgePublication === undefined
      ? {}
      : {
          forgeReviewId: forgePublication.forgeReviewId,
          forgeReviewState: forgePublication.forgeReviewState,
          forgeReviewUrl: forgePublication.forgeReviewUrl,
          headSha: forgePublication.headSha,
        };
  const effectiveReviewer = reviewer ?? forgePublication?.reviewerLogin;
  const verdictEvent: PriorEventInput =
    verdict === "approved"
      ? {
          ...base,
          eventType,
          payload: {
            prUrl,
            prNumber,
            ...(effectiveReviewer !== undefined && { reviewer: effectiveReviewer }),
            ...forgeFields,
          } as never,
          idempotencyKey: `${base.runId}:review:${verdict}`,
        }
      : {
          ...base,
          eventType,
          payload: {
            prUrl,
            prNumber,
            ...(effectiveReviewer !== undefined && { reviewer: effectiveReviewer }),
            ...(feedback !== undefined && { message: feedback }),
            ...forgeFields,
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
