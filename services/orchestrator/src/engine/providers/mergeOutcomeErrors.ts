// GitHub-5xx resilience (GAP #2d): typed errors the merge PUT throws when a GitHub
// outage outlasts its bounded re-PUT reconcile loop, so the merge coordinator routes
// them like the ref-reset transient (infra-hold / loud halt) instead of `merge.failed`.
//
// Two distinct cases, deliberately NOT collapsed (the double-merge guard depends on
// the distinction):
//   - MergeTransientError — the reconcile GET POSITIVELY confirmed the PR is still
//     OPEN + UNMERGED after the re-PUTs kept hitting a 5xx/timeout. The merge genuinely
//     did not land, so re-driving when GitHub recovers is SAFE (it cannot double-merge).
//     Retriable → the coordinator's infra-hold + delayed re-drive (bounded by a ceiling).
//   - MergeAmbiguousError — the reconcile GET ITSELF could not confirm the state (it
//     also failed / the PR is neither confirmed-merged nor confirmed-open). We do NOT
//     know whether the merge landed, so auto-re-driving could DOUBLE-MERGE. NOT
//     retriable → a LOUD, operator-visible halt that never auto-re-PUTs.

/**
 * The merge PUT exhausted its bounded re-PUTs on a transient 5xx, AND the reconcile
 * read positively confirmed the PR is still open + unmerged. Safe to retry on a later
 * re-drive (the merge never landed). `retriable: true` so `isRetriableInfraError`
 * routes it to the infra-hold path — exactly like a `RefResetTransientError`.
 */
export class MergeTransientError extends Error {
  readonly retriable = true as const;
  constructor(message: string) {
    super(message);
    this.name = "MergeTransientError";
  }
}

/**
 * The merge PUT hit a transient 5xx but the reconcile read could NOT confirm the PR's
 * state (the read itself failed, or the PR is neither confirmed-merged nor
 * confirmed-open). The merge MAY have landed — auto-re-driving risks a double-merge.
 * `retriable: false` so the coordinator surfaces a LOUD operator-visible halt that does
 * NOT auto-re-PUT, per the double-merge guard.
 */
export class MergeAmbiguousError extends Error {
  readonly retriable = false as const;
  constructor(message: string) {
    super(message);
    this.name = "MergeAmbiguousError";
  }
}

/**
 * True iff `error` is the AMBIGUOUS merge outcome — the merge state could not be
 * confirmed after a transient 5xx. The coordinator routes this to a LOUD, operator-
 * visible halt that does NOT auto-re-PUT (re-driving could double-merge), DISTINCT from
 * both the retriable infra-hold and a genuine recoverable block.
 */
export function isAmbiguousMergeError(error: unknown): error is MergeAmbiguousError {
  return error instanceof MergeAmbiguousError;
}
