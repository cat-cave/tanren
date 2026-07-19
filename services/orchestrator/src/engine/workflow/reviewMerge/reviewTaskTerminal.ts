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
import type { EventPayload } from "../../events/index.js";
import type { PriorEventInput } from "../../eventStore.js";
import type { ReviewPrincipal } from "../../governance/reviewRules.js";
import { SimulatedReviewPublicationError, type ForgeReviewPublication } from "./simulatedReviewPublication.js";

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
  /** Governance identity of the reviewer; absent evidence never satisfies a required principal. */
  reviewerPrincipal?: ReviewPrincipal;
  /** changes_requested feedback body (the writer-rework steering payload). */
  feedback?: string;
  /**
   * Strict simulated-review forge receipt (gv-2). When present, bound onto the
   * terminal review.* event so land signals / UI observe the same durable proof.
   * Human/auto paths omit it.
   */
  forgePublication?: ForgeReviewPublication;
}): Promise<void> {
  const { writer, base, verdict, prUrl, prNumber, reviewer, reviewerPrincipal, feedback, forgePublication } = input;
  // PRE-TERMINAL verdict event (the loud `review.*` observation, downstream
  // consumers key off this event). Bundled into the SAME atomic transaction
  // as the terminal row + `task.completed` via the writer-seam `priorEvents`
  // extension — collapses what used to be a separate `writer.append()` call
  // into ONE commit alongside the terminal pair.
  //
  // Round-3 audit finding H-R3.2 + gv-2 head rebind: the prior-event entry
  // carries a stable idempotency key so a retried atomic write deduplicates
  // the verdict event on (run_id, idempotency_key) instead of double-emitting.
  //
  // Key shape:
  //   - no forge receipt (human/auto): `${runId}:review:${verdict}`
  //     first-wins finalize; retry of THIS finalize dedupes; a verdict flip
  //     (approve ↔ changes_requested) carries a distinct key and lands afresh.
  //   - strict simulated forge receipt: `${runId}:review:${verdict}:${headSha}`
  //     same-head retry remains idempotent; re-review on a replacement head
  //     (writer push after approval, base-shift restack) lands a NEW durable
  //     receipt. Land signals take LATEST by ts, so B supersedes A for land
  //     authorization — A never authorizes B (exact-head bind).
  //
  // The forge review id is NOT part of the key (receipt id is observation,
  // not identity of the terminal). No second receipt store; one event stream.
  const effectiveReviewer = forgePublication?.reviewerLogin ?? reviewer;
  // Head-bound key only when a forge receipt is present — human/auto omit it.
  const idempotencyKey =
    forgePublication === undefined
      ? `${base.runId}:review:${verdict}`
      : `${base.runId}:review:${verdict}:${forgePublication.headSha}`;

  const verdictEvent: PriorEventInput =
    verdict === "approved"
      ? {
          ...base,
          eventType: "review.approved",
          payload: approvedPayload({
            prUrl,
            prNumber,
            reviewer: effectiveReviewer,
            reviewerPrincipal,
            forgePublication,
          }),
          idempotencyKey,
        }
      : {
          ...base,
          eventType: "review.changes_requested",
          payload: changesRequestedPayload({
            prUrl,
            prNumber,
            reviewer: effectiveReviewer,
            reviewerPrincipal,
            feedback,
            forgePublication,
          }),
          idempotencyKey,
        };

  const completedPayload: EventPayload<"task.completed"> = {
    taskKind: "review",
    status: verdict,
  };
  await writer.updateTaskWithEvent({
    task: { taskId: base.taskId, transition: "done", outcome: "ok" },
    event: {
      ...base,
      eventType: "task.completed",
      payload: completedPayload,
    },
    priorEvents: [verdictEvent],
  });
}

function approvedPayload(input: {
  prUrl: string;
  prNumber: number;
  reviewer?: string;
  reviewerPrincipal?: ReviewPrincipal;
  forgePublication?: ForgeReviewPublication;
}): EventPayload<"review.approved"> {
  const base = {
    prUrl: input.prUrl,
    prNumber: input.prNumber,
    ...(input.reviewer !== undefined && { reviewer: input.reviewer }),
    ...(input.reviewerPrincipal !== undefined && { reviewerPrincipal: input.reviewerPrincipal }),
  };
  if (input.forgePublication === undefined) return base;
  if (input.forgePublication.forgeReviewState !== "approved") {
    throw new SimulatedReviewPublicationError("approved terminal event requires an approved forge receipt");
  }
  return {
    ...base,
    forgeReviewId: input.forgePublication.forgeReviewId,
    forgeReviewState: input.forgePublication.forgeReviewState,
    forgeReviewUrl: input.forgePublication.forgeReviewUrl,
    headSha: input.forgePublication.headSha,
  };
}

function changesRequestedPayload(input: {
  prUrl: string;
  prNumber: number;
  reviewer?: string;
  reviewerPrincipal?: ReviewPrincipal;
  feedback?: string;
  forgePublication?: ForgeReviewPublication;
}): EventPayload<"review.changes_requested"> {
  const base = {
    prUrl: input.prUrl,
    prNumber: input.prNumber,
    ...(input.reviewer !== undefined && { reviewer: input.reviewer }),
    ...(input.reviewerPrincipal !== undefined && { reviewerPrincipal: input.reviewerPrincipal }),
    ...(input.feedback !== undefined && { message: input.feedback }),
  };
  if (input.forgePublication === undefined) return base;
  if (input.forgePublication.forgeReviewState !== "changes_requested") {
    throw new SimulatedReviewPublicationError(
      "changes_requested terminal event requires a changes_requested forge receipt",
    );
  }
  return {
    ...base,
    forgeReviewId: input.forgePublication.forgeReviewId,
    forgeReviewState: input.forgePublication.forgeReviewState,
    forgeReviewUrl: input.forgePublication.forgeReviewUrl,
    headSha: input.forgePublication.headSha,
  };
}
