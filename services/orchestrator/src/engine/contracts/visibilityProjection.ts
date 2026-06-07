// The `VisibilityProjection` seam (tanren-owns-the-engine.md §0, §6) — the
// BEST-EFFORT mirror of the change as a PR / check / comment on a forge UI, for
// humans. EVERY method is OPTIONAL and EVERY method is best-effort.
//
// WHY this seam (the governing principle it embodies): §0. Best-effort applies ONLY
// to strictly external interactions; projecting the change/verdict/review to
// GitHub's PR/check/comment UI is the canonical best-effort surface. The TYPES make
// this explicit and ENFORCE it:
//   - every method is optional (`?`) — a host with no UI mirror is fully valid;
//   - a failure here NEVER propagates to the caller and NEVER alters a recorded
//     decision (the merge proceeds or holds EXACTLY as `MergeAuthority` decided).
// The projection is a MIRROR, not a gate. This closes the class of fail-OPEN bugs
// where an external publish leaked inward to change an internal verdict — here it
// CANNOT, because the projection result is structurally severed from the decision
// (see `runProjection`, which swallows failure into a recorded-but-non-fatal outcome).

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

/**
 * The `VisibilityProjection` contract — a best-effort, human-facing MIRROR. EVERY
 * method is optional: an impl may provide any subset (or none). NONE of these may
 * ever throw to the caller in a way that changes a recorded decision — the caller
 * MUST route every call through {@link runProjection}, which severs the failure.
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
}

/** The recorded outcome of a projection attempt — a NOTE, never a gate. */
export type ProjectionOutcome<T> =
  | { kind: "projected"; value: T }
  | { kind: "skipped"; reason: "method-not-provided" }
  | { kind: "failed"; error: string };

/**
 * Run a single projection method through the best-effort boundary. WHY this exists:
 * §0 demands a projection failure NEVER propagate to the caller and NEVER alter a
 * recorded decision. This helper STRUCTURALLY enforces it — a missing method is
 * `skipped`, a throw is captured as `failed`, and NEITHER ever rejects. The caller
 * gets a recorded outcome it can log/mirror, but its control flow is unchanged. This
 * is the type-level proof the projection is a mirror, not a gate.
 */
export async function runProjection<T>(
  method: ((...args: never[]) => Promise<T>) | undefined,
  invoke: (m: (...args: never[]) => Promise<T>) => Promise<T>,
): Promise<ProjectionOutcome<T>> {
  if (method === undefined) {
    return { kind: "skipped", reason: "method-not-provided" };
  }
  try {
    const value = await invoke(method);
    return { kind: "projected", value };
  } catch (err) {
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
