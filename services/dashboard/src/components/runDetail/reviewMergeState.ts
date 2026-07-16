/**
 * Review/merge state derived from a run's typed review.* / merge.* / github.pr.*
 * events. Pure presentation helpers (no DOM/JSX); contract-typed inputs only.
 *
 * Extracted from `model.ts` so each file stays under the 500-line architecture
 * cap. The forge-publication tri-state (`ForgeReviewPublicationView` /
 * `forgePublicationFromPayload`) is the gv-2 strict simulated-review receipt
 * surface; the phase/reducer predate it.
 */

import type { RunEventRow } from "../../api/types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The review/merge phase the operator surface reflects. */
export type ReviewMergePhase =
  | "none"
  | "review_requested"
  | "changes_requested"
  | "approved"
  | "merge_queued"
  | "merge_conflict"
  | "merge_failed"
  | "merged";

export interface ReviewMergeState {
  phase: ReviewMergePhase;
  /** Latest changes-requested / failure / conflict message, when present. */
  message?: string;
  /** Merge commit sha once merged. */
  mergeSha?: string;
  /** Dispatched merge integration recorded on a merge.* event. */
  integration?: string;
  /**
   * gv-2 forge publication bound onto the latest terminal review.* event.
   * Tri-state: `undefined` = no receipt fields at all (neutral unpublished),
   * partial = a strict subset of receipt fields (loud incomplete/danger),
   * complete = the full valid receipt tuple (published/success).
   */
  forgePublication?: ForgeReviewPublicationView;
  publicationStatus: "publishing" | "published" | "stale" | "failed" | "non_simulated";
}

/** Durable forge receipt fields from review.approved / review.changes_requested. */
export interface ForgeReviewPublicationView {
  forgeReviewId?: string;
  forgeReviewState?: string;
  forgeReviewUrl?: string;
  headSha?: string;
  reviewer?: string;
  /** True only for full tuple with state exactly approved|changes_requested. */
  complete: boolean;
}

/**
 * Extract forge publication from a terminal review payload. Honest tri-state:
 * zero receipt fields → undefined (neutral); strict subset or non-authoritative
 * state (`commented`/unknown) → complete:false (loud); full approved/
 * changes_requested tuple → complete:true.
 */
export function forgePublicationFromPayload(payload: Record<string, unknown>): ForgeReviewPublicationView | undefined {
  const forgeReviewId = asString(payload["forgeReviewId"]);
  const forgeReviewState = asString(payload["forgeReviewState"]);
  const forgeReviewUrl = asString(payload["forgeReviewUrl"]);
  const headSha = asString(payload["headSha"]);
  const reviewer = asString(payload["reviewer"]);
  // Zero receipt fields → unpublished. A lone non-receipt field does not count.
  if (
    forgeReviewId === undefined &&
    forgeReviewState === undefined &&
    forgeReviewUrl === undefined &&
    headSha === undefined
  ) {
    return undefined;
  }
  const stateAuthoritative = forgeReviewState === "approved" || forgeReviewState === "changes_requested";
  const complete =
    forgeReviewId !== undefined &&
    stateAuthoritative &&
    forgeReviewUrl !== undefined &&
    headSha !== undefined &&
    /^[0-9a-f]{40}$/iu.test(headSha) &&
    reviewer !== undefined;
  return {
    ...(forgeReviewId !== undefined && { forgeReviewId }),
    ...(forgeReviewState !== undefined && { forgeReviewState }),
    ...(forgeReviewUrl !== undefined && { forgeReviewUrl }),
    ...(headSha !== undefined && { headSha }),
    ...(reviewer !== undefined && { reviewer }),
    complete,
  };
}

/**
 * Reduce the run's review.* / merge.* / github.pr.* events into the single
 * review/merge phase the review sub-surface renders. The latest matching event
 * wins (events arrive in order), so a re-reviewed PR reflects its final state.
 */
export function reviewMergeStateFromEvents(events: RunEventRow[]): ReviewMergeState {
  const state: ReviewMergeState = { phase: "none", publicationStatus: "non_simulated" };
  let latestIntent: { index: number; headSha?: string; reviewState?: string; reviewer?: string } | undefined;
  let latestTerminal:
    | { index: number; eventType: string; publication: ForgeReviewPublicationView | undefined }
    | undefined;
  let latestGateHead: string | undefined;
  let latestPublicationFailureIndex = -1;
  for (const [index, event] of events.entries()) {
    const payload = asRecord(event.payload) ?? {};
    const message = asString(payload["message"]);
    const integration = asString(payload["integration"]);
    switch (event.eventType) {
      case "github.pr.ready":
      case "review.requested":
        if (state.phase === "none") state.phase = "review_requested";
        break;
      case "review.simulated_intent":
        latestIntent = {
          index,
          headSha: asString(payload["headSha"]),
          reviewState: asString(payload["state"]),
          reviewer: asString(payload["reviewerLogin"]),
        };
        break;
      case "review.changes_requested":
        state.phase = "changes_requested";
        state.message = message;
        state.forgePublication = forgePublicationFromPayload(payload);
        latestTerminal = { index, eventType: event.eventType, publication: state.forgePublication };
        break;
      case "review.approved":
        if (state.phase !== "merged") state.phase = "approved";
        state.forgePublication = forgePublicationFromPayload(payload);
        latestTerminal = { index, eventType: event.eventType, publication: state.forgePublication };
        break;
      case "review.auto_approved":
        if (state.phase !== "merged") state.phase = "approved";
        latestTerminal = { index, eventType: event.eventType, publication: undefined };
        break;
      case "gate.verdict":
        if (payload["when"] === "pre_merge") latestGateHead = asString(payload["headSha"]);
        break;
      case "run.failed":
        if (isSimulatedPublicationFailure(payload)) latestPublicationFailureIndex = index;
        break;
      case "task.failed":
        break;
      case "merge.queued":
        state.phase = "merge_queued";
        state.integration = integration;
        break;
      case "merge.conflict":
        state.phase = "merge_conflict";
        state.message = message;
        state.integration = integration;
        break;
      case "merge.failed":
        state.phase = "merge_failed";
        state.message = message;
        state.integration = integration;
        break;
      case "merge.completed":
      case "github.pr.merged":
        state.phase = "merged";
        state.mergeSha = asString(payload["mergeSha"]);
        state.integration = integration ?? state.integration;
        break;
      default:
        break;
    }
  }
  state.publicationStatus = publicationStatus({
    latestIntent,
    latestTerminal,
    latestGateHead,
    latestPublicationFailureIndex,
  });
  return state;
}

function publicationStatus(input: {
  latestIntent: { index: number; headSha?: string; reviewState?: string; reviewer?: string } | undefined;
  latestTerminal: { index: number; eventType: string; publication: ForgeReviewPublicationView | undefined } | undefined;
  latestGateHead: string | undefined;
  latestPublicationFailureIndex: number;
}): ReviewMergeState["publicationStatus"] {
  const { latestIntent: intent, latestTerminal: terminal } = input;
  if (terminal === undefined || (intent !== undefined && terminal.index < intent.index)) {
    if (intent !== undefined) return input.latestPublicationFailureIndex > intent.index ? "failed" : "publishing";
    return "non_simulated";
  }
  const publication = terminal.publication;
  if (intent === undefined) {
    if (publication === undefined) return "non_simulated";
    return publication.complete ? "published" : "failed";
  }
  if (publication?.complete !== true) return "failed";
  const expectedState = terminal.eventType === "review.approved" ? "approved" : "changes_requested";
  if (publication.forgeReviewState !== expectedState || publication.forgeReviewState !== intent.reviewState) {
    return "failed";
  }
  if (publication.reviewer?.toLowerCase() !== intent.reviewer?.toLowerCase()) return "failed";
  if (
    publication.headSha?.toLowerCase() !== intent.headSha?.toLowerCase() ||
    (input.latestGateHead !== undefined && publication.headSha?.toLowerCase() !== input.latestGateHead.toLowerCase())
  ) {
    return "stale";
  }
  return "published";
}

const SIMULATED_PUBLICATION_FAILURE_MESSAGES = new Set([
  "strict simulated-review publication failed",
  "strict simulated-review publication is contended",
  "the pull request advanced before strict simulated-review publication",
]);

function isSimulatedPublicationFailure(payload: Record<string, unknown>): boolean {
  const message = asString(payload["message"]);
  return (
    payload["failureCode"] === "merge" &&
    payload["stage"] === "merge" &&
    message !== undefined &&
    SIMULATED_PUBLICATION_FAILURE_MESSAGES.has(message)
  );
}

/** Human label + pill class; approved is green only with honest publication state. */
export function reviewMergePill(state: ReviewMergeState): { label: string; cls: "ok" | "warn" | "danger" } {
  switch (state.phase) {
    case "merged":
      return { label: `merged${state.mergeSha ? ` · ${state.mergeSha.slice(0, 7)}` : ""}`, cls: "ok" };
    case "approved":
      if (state.publicationStatus === "published" || state.publicationStatus === "non_simulated") {
        return { label: "review approved", cls: "ok" };
      }
      return {
        label: state.publicationStatus === "stale" ? "review stale" : "review publication pending",
        cls: state.publicationStatus === "failed" || state.publicationStatus === "stale" ? "danger" : "warn",
      };
    case "merge_queued":
      return { label: `merge queued${state.integration ? ` · ${state.integration}` : ""}`, cls: "warn" };
    case "review_requested":
      return { label: "review requested", cls: "warn" };
    case "changes_requested":
      return { label: "changes requested", cls: "danger" };
    case "merge_conflict":
      return { label: "merge conflict", cls: "danger" };
    case "merge_failed":
      return { label: "merge failed", cls: "danger" };
    default:
      return { label: "review pending", cls: "warn" };
  }
}
