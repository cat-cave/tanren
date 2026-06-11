// The `VisibilityProjection` seam (tanren-owns-the-engine.md §0, §6) — the
// BEST-EFFORT mirror of the change as a PR / check / comment on a forge UI, for
// humans. EVERY method is OPTIONAL and EVERY method is best-effort.
//
// WHY this seam (the governing principle it embodies): §0. Best-effort applies ONLY
// to strictly external interactions; projecting the change/verdict/review to
// GitHub's PR/check/comment UI is the canonical best-effort surface. The TYPES make
// this explicit and ENFORCE it STRUCTURALLY:
//   - the RAW impl (`VisibilityProjection`) has optional methods that MAY reject —
//     but it is NOT the call surface;
//   - the CALL surface (`SafeVisibilityProjection`, built once via `harden`) has
//     methods that return a `ProjectionOutcome` and CAN NEVER REJECT (a missing
//     method is `skipped`, a throw is captured as `failed`). It is IMPOSSIBLE to
//     invoke a projection without the safe boundary, so a projection failure can
//     never propagate to the caller and can never alter a recorded decision.
// The projection is a MIRROR, not a gate — by construction, not by remembering to
// wrap each call in a best-effort helper.

/** Input to opening/updating the external change request (a PR/MR) for a node. */
export interface ChangeRequestInput {
  repoFullName: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body?: string;
}

/** The opened/updated change request handle (a best-effort, human-facing artifact). */
export interface ProjectedChangeRequest {
  url: string;
  number: number;
}

/** Input to publishing the gate verdict as an external check/status. */
export interface PublishGateInput {
  repoFullName: string;
  headSha: string;
  verdict: "passed" | "failed";
  summary: string;
}

/** Input to publishing a review as an external comment/review artifact. */
export interface PublishReviewInput {
  repoFullName: string;
  changeRequestNumber: number;
  body: string;
}

/** Input to retargeting an external change request's base branch. */
export interface RetargetChangeRequestInput {
  repoFullName: string;
  changeRequestNumber: number;
  newBaseBranch: string;
}

/** Input to reading an external change request's current base branch. */
export interface ReadChangeRequestBaseInput {
  repoFullName: string;
  changeRequestNumber: number;
}

/**
 * Input to opening a best-effort tracking issue on the forge — the home for the
 * post-merge-failure tracking issue (the regression note filed when the post-merge
 * CI on the default branch fails). Carries only non-secret, code-controlled fields.
 */
export interface TrackingIssueInput {
  repoFullName: string;
  title: string;
  body: string;
  labels?: ReadonlyArray<string>;
}

/** The opened tracking issue handle (a best-effort, human-facing artifact). */
export interface ProjectedTrackingIssue {
  url: string;
  number: number;
}

/** Input to un-drafting (marking ready) the external change request mirror. */
export interface MarkChangeRequestReadyInput {
  repoFullName: string;
  changeRequestNumber: number;
}

/**
 * The RAW best-effort projection impl — a host provides any subset of these (or
 * none). This is NOT the call surface: callers never hold a `VisibilityProjection`
 * directly. Each method MAY reject (it talks to an external forge); `harden` is what
 * turns it into the never-rejecting {@link SafeVisibilityProjection} the engine uses.
 */
export interface VisibilityProjection {
  /** Open or update the external change request (PR/MR). Optional + best-effort. */
  openOrUpdateChangeRequest?(input: ChangeRequestInput): Promise<ProjectedChangeRequest>;
  /** Publish the gate verdict to the forge UI. Optional + best-effort. */
  publishGate?(input: PublishGateInput): Promise<void>;
  /** Publish a review to the forge UI. Optional + best-effort. */
  publishReview?(input: PublishReviewInput): Promise<void>;
  /** Retarget the external change request's base. Optional + best-effort. */
  retargetChangeRequest?(input: RetargetChangeRequestInput): Promise<void>;
  /**
   * Read the external change request's CURRENT base branch — the speculative stacked-PR
   * retarget walk's `fromBase` (it tracks the live forge base across walks). Optional +
   * best-effort: a host that omits it leaves the walk to re-derive on the next ancestor
   * merge (the base re-point is a cosmetic forge mirror — the land targets the real
   * default branch regardless).
   */
  readChangeRequestBase?(input: ReadChangeRequestBaseInput): Promise<string>;
  /**
   * Open a best-effort tracking issue on the forge (the post-merge-failure
   * regression note). Optional + best-effort: a host with no issue support simply
   * does not provide it → the safe surface resolves it `skipped`, never an error.
   */
  openTrackingIssue?(input: TrackingIssueInput): Promise<ProjectedTrackingIssue>;
  /**
   * Un-draft the external change request mirror (mark it ready for review).
   * Optional + best-effort: a host that never drafts the mirror simply omits it.
   */
  markChangeRequestReady?(input: MarkChangeRequestReadyInput): Promise<void>;
}

/** The recorded outcome of a projection attempt — a NOTE, never a gate. */
export type ProjectionOutcome<T> =
  | { kind: "projected"; value: T }
  | { kind: "skipped"; reason: "method-not-provided" }
  | { kind: "failed"; error: string };

/**
 * The CALL surface the engine uses — every method returns a {@link ProjectionOutcome}
 * and CAN NEVER REJECT. This is the structural fail-safe boundary: because the only
 * way to invoke a projection is through these methods (the raw impl is hidden behind
 * `harden`), it is IMPOSSIBLE to call a projection without the best-effort severance.
 * A missing raw method is `skipped`; a rejecting one is `failed`; neither propagates.
 */
export interface SafeVisibilityProjection {
  openOrUpdateChangeRequest(input: ChangeRequestInput): Promise<ProjectionOutcome<ProjectedChangeRequest>>;
  publishGate(input: PublishGateInput): Promise<ProjectionOutcome<void>>;
  publishReview(input: PublishReviewInput): Promise<ProjectionOutcome<void>>;
  retargetChangeRequest(input: RetargetChangeRequestInput): Promise<ProjectionOutcome<void>>;
  readChangeRequestBase(input: ReadChangeRequestBaseInput): Promise<ProjectionOutcome<string>>;
  openTrackingIssue(input: TrackingIssueInput): Promise<ProjectionOutcome<ProjectedTrackingIssue>>;
  markChangeRequestReady(input: MarkChangeRequestReadyInput): Promise<ProjectionOutcome<void>>;
}

/** Invoke one optional raw projection method through the best-effort severance. */
async function severed<I, T>(method: ((input: I) => Promise<T>) | undefined, input: I): Promise<ProjectionOutcome<T>> {
  if (method === undefined) {
    return { kind: "skipped", reason: "method-not-provided" };
  }
  try {
    return { kind: "projected", value: await method(input) };
  } catch (err) {
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Harden a RAW {@link VisibilityProjection} into the never-rejecting
 * {@link SafeVisibilityProjection} the engine holds. WHY: §0 demands a projection
 * failure NEVER propagate to the caller + NEVER alter a recorded decision. Making
 * the SAFE surface the only thing callers can hold means the best-effort boundary
 * is enforced by construction — a caller cannot accidentally invoke a raw,
 * rejection-prone method. `harden` binds the raw methods to the impl so `this` is
 * preserved.
 */
export function harden(raw: VisibilityProjection): SafeVisibilityProjection {
  return {
    openOrUpdateChangeRequest: (input) => severed(raw.openOrUpdateChangeRequest?.bind(raw), input),
    publishGate: (input) => severed(raw.publishGate?.bind(raw), input),
    publishReview: (input) => severed(raw.publishReview?.bind(raw), input),
    retargetChangeRequest: (input) => severed(raw.retargetChangeRequest?.bind(raw), input),
    readChangeRequestBase: (input) => severed(raw.readChangeRequestBase?.bind(raw), input),
    openTrackingIssue: (input) => severed(raw.openTrackingIssue?.bind(raw), input),
    markChangeRequestReady: (input) => severed(raw.markChangeRequestReady?.bind(raw), input),
  };
}
