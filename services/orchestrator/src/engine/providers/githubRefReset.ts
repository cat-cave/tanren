// Bug 1 (merge queue robust to infra errors): the TYPED provider-layer infra errors +
// the retriable-classification the merge coordinators read. A transient transport/ref/
// merge error is HELD + retried (never a wrong dequeue of a clean PR); a typed PERMANENT
// error holds loud-once then escalates. (The server-side integration-ref reset that once
// also lived here was deleted with `VcsProvider.buildIntegrationBranch` — the prospective
// merged state now assembles LOCALLY over jj, so no host ref is reset.)

/**
 * A TRANSIENT infra error setting up a forge operation (e.g. a git-ref op that hit a
 * racy HTTP 422 on GitHub's git database). It means the operation could not be RUN —
 * it is NOT a CI failure and NOT a merge conflict. The batch coordinator maps this to
 * the `infra-error` verdict (retriable: true) so a clean PR is HELD + retried, never
 * dequeued/blamed. The live repro shows the SAME ref op succeeds on immediate retry.
 */
export class RefResetTransientError extends Error {
  /** Always retriable — the operation should self-heal on a re-attempt. */
  readonly retriable = true as const;
  constructor(message: string) {
    super(message);
    this.name = "RefResetTransientError";
  }
}

/**
 * A PERMANENT infra error setting up a forge operation (e.g. an op rejected for a
 * reason that will not self-heal). It is STILL an infra error (the check could not be
 * run) — the coordinator HOLDS rather than dequeues — but it is NOT worth retrying, so
 * the coordinator skips its retry budget and surfaces the loud hold immediately.
 */
export class RefResetPermanentError extends Error {
  readonly retriable = false as const;
  constructor(message: string) {
    super(message);
    this.name = "RefResetPermanentError";
  }
}

/**
 * True iff `error` is a RETRIABLE infra error from the provider layer (a transient
 * transport/ref/merge error). Structural by design — it reads the typed errors'
 * readonly `retriable` flag rather than enumerating classes, so the ref transients
 * (`RefResetTransientError`) AND the merge-PUT transients (`MergeTransientError`) both
 * route to the coordinator's infra-hold, while the typed PERMANENT/AMBIGUOUS errors
 * (`retriable: false`) do not. The batch coordinator uses it for the `infra-error`
 * verdict's `retriable` flag; the per-PR coordinator uses it to choose hold-vs-halt.
 *
 * An UNTYPED thrown value defaults to RETRIABLE: the live repros are transient (a git-db
 * 422, a gateway 504), and a bounded hold-then-loud-ceiling is safe (it never strands,
 * and the hold-attempt ceiling stops an untyped error from looping forever). Permanence
 * is only asserted via a typed `retriable: false`.
 */
export function isRetriableInfraError(error: unknown): boolean {
  if (error instanceof Error) {
    const flag = (error as { retriable?: unknown }).retriable;
    if (typeof flag === "boolean") return flag;
  }
  return true;
}
