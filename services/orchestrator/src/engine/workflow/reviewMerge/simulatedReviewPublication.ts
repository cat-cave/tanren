// Strict simulated-review forge publication (gv-2 / F1 safety repair).
//
// Deletes the former COMMENT / best-effort / internal-only authority path:
// the Answerer still produces the typed internal verdict, but land-authoritative
// `review.approved` / `review.changes_requested` events require a durable forge
// receipt for real APPROVE / REQUEST_CHANGES on the exact reviewed head SHA,
// posted with a reviewer identity DISTINCT from the PR writer.
//
// Credential seam (existing managed-secret surface — no new config field):
//   - Preferred: explicit `reviewerGithubCredentialRef` (static `credential/github/*`).
//   - Else: org GitHub App is the writer AND a project/org static GitHub token ref
//     is configured → static token is the reviewer (App-first writer remains App).
//   - Missing second identity, same login, failed/malformed/head-mismatched
//     publication → fail closed (no terminal review.approved).

import type { SecretStore } from "../../contracts/secretStore.js";
import type { ResolvedVcsToken } from "../../contracts/codeHostTypes.js";
import type { OrgGithubAppInstallation } from "../../config/orgConfig.js";
import { normalizeStaticGithubRef } from "../../credentials/githubToken.js";
import { resolveVcsActorIdentity, resolveVcsToken } from "../../credentials/vcsCredentials.js";
import type { GitHubHttpClient } from "../../providers/github.js";
import type { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import { receiptFromListedReview, type ListedPullRequestReview } from "../../providers/githubReviewMergeParse.js";
import type { SubmittedReviewReceipt, SubmitReviewEvent } from "../../providers/githubReviewMerge.js";

/**
 * Durable Tanren-owned marker embedded in the forge review body. Deterministic
 * for a given terminal state — used as the sole forge-side idempotency identity
 * (no second receipt store). Format is exact-line; free-text reasoning cannot
 * satisfy reconcile without this machine line from our publisher.
 */
export const TANREN_SIMULATED_REVIEW_MARKER_PREFIX = "tanren-simulated-review:v1:" as const;

export function tanrenSimulatedReviewMarker(state: "approved" | "changes_requested"): string {
  return `${TANREN_SIMULATED_REVIEW_MARKER_PREFIX}${state}`;
}

export function bodyContainsTanrenSimulatedMarker(
  body: string | undefined,
  state: "approved" | "changes_requested",
): boolean {
  if (body === undefined || body === "") return false;
  const marker = tanrenSimulatedReviewMarker(state);
  // Exact line match — never adopt a body that only embeds the token mid-sentence.
  return body.split(/\r?\n/u).some((line) => line.trim() === marker);
}

/** Durable forge receipt fields bound onto the terminal review.* event payload. */
export interface ForgeReviewPublication {
  forgeReviewId: string;
  forgeReviewState: "approved" | "changes_requested";
  forgeReviewUrl: string;
  headSha: string;
  reviewerLogin?: string;
}

/** Fail-closed publication / identity error — leaves review/land non-authorized. */
export class SimulatedReviewPublicationError extends Error {
  readonly retriable = false as const;
  constructor(message: string) {
    super(message);
    this.name = "SimulatedReviewPublicationError";
  }
}

/**
 * Map the Answerer verdict to the real forge review event. COMMENT is never
 * land-authoritative for simulated review.
 */
export function strictReviewEventFor(verdict: "approve" | "request_changes"): Exclude<SubmitReviewEvent, "COMMENT"> {
  return verdict === "approve" ? "APPROVE" : "REQUEST_CHANGES";
}

/**
 * Validate a forge receipt against the expected internal verdict + exact head.
 * Throws {@link SimulatedReviewPublicationError} on any mismatch or missing field
 * (including COMMENT-state responses and head drift).
 */
export function assertStrictForgeReceipt(input: {
  receipt: SubmittedReviewReceipt;
  expectedVerdict: "approved" | "changes_requested";
  expectedHeadSha: string;
}): ForgeReviewPublication {
  const { receipt, expectedVerdict, expectedHeadSha } = input;
  if (receipt.forgeReviewId === "") {
    throw new SimulatedReviewPublicationError("simulated review publication missing forge review id");
  }
  if (receipt.forgeReviewUrl === "") {
    throw new SimulatedReviewPublicationError("simulated review publication missing forge review url");
  }
  if (receipt.forgeReviewState !== expectedVerdict) {
    throw new SimulatedReviewPublicationError(
      `simulated review publication state mismatch: forge=${receipt.forgeReviewState} expected=${expectedVerdict}`,
    );
  }
  if (receipt.headSha.toLowerCase() !== expectedHeadSha.toLowerCase()) {
    throw new SimulatedReviewPublicationError(
      `simulated review publication head mismatch: forge=${receipt.headSha} expected=${expectedHeadSha}`,
    );
  }
  if (!/^[0-9a-f]{40}$/iu.test(receipt.headSha)) {
    throw new SimulatedReviewPublicationError(
      `simulated review publication head is not a 40-hex sha: ${receipt.headSha}`,
    );
  }
  return {
    forgeReviewId: receipt.forgeReviewId,
    forgeReviewState: receipt.forgeReviewState,
    forgeReviewUrl: receipt.forgeReviewUrl,
    headSha: receipt.headSha,
    ...(receipt.reviewerLogin !== undefined &&
      receipt.reviewerLogin !== "" && { reviewerLogin: receipt.reviewerLogin }),
  };
}

export interface ResolveSimulatedReviewerTokenInput {
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  /** Writer / PR-creation credential context (App install + optional static). */
  writerInstallation?: OrgGithubAppInstallation;
  writerStaticRef?: string;
  githubAppMinter?: GithubAppTokenMinter;
  /**
   * Explicit static reviewer credential ref (`credential/github/*`). When set,
   * this is the reviewer; the writer is resolved from App/static as usual.
   */
  reviewerGithubCredentialRef?: string;
}

/**
 * Resolve the STRICT simulated-reviewer VCS token + prove it is a different
 * GitHub login than the writer. Fail closed when a distinct identity cannot be
 * represented through the existing managed secret seam.
 */
export async function resolveDistinctSimulatedReviewerToken(
  input: ResolveSimulatedReviewerTokenInput,
): Promise<{ reviewer: ResolvedVcsToken; writerLogin: string; reviewerLogin: string }> {
  const writer = await resolveVcsToken(input.githubHttp, {
    secrets: input.secrets,
    installation: input.writerInstallation,
    staticRef: input.writerStaticRef,
    minter: input.githubAppMinter,
  });
  const writerIdentity = await resolveVcsActorIdentity(writer);
  const writerLogin = writerIdentity.login;

  const explicitReviewerRef = normalizeStaticGithubRef(input.reviewerGithubCredentialRef);
  const reviewer = await resolveReviewerToken(input, explicitReviewerRef);

  const reviewerIdentity = await resolveVcsActorIdentity(reviewer);
  const reviewerLogin = reviewerIdentity.login;
  if (reviewerLogin === "" || writerLogin === "") {
    throw new SimulatedReviewPublicationError(
      "strict simulated review could not resolve writer/reviewer GitHub logins",
    );
  }
  if (reviewerLogin.toLowerCase() === writerLogin.toLowerCase()) {
    throw new SimulatedReviewPublicationError(
      `strict simulated review rejected same-identity publication: writer and reviewer are both '${reviewerLogin}'`,
    );
  }
  return { reviewer, writerLogin, reviewerLogin };
}

async function resolveReviewerToken(
  input: ResolveSimulatedReviewerTokenInput,
  explicitReviewerRef: string | undefined,
): Promise<ResolvedVcsToken> {
  if (typeof explicitReviewerRef === "string") {
    // Static-only reviewer (never App-first) so the identity is the managed secret
    // at that ref, not the writer App install.
    return resolveVcsToken(input.githubHttp, {
      secrets: input.secrets,
      staticRef: explicitReviewerRef,
    });
  }
  if (input.writerInstallation !== undefined) {
    // Canonical dual-credential seam: App is the writer; project/org static GitHub
    // token is the reviewer. Both must already be configured.
    const staticReviewerRef = normalizeStaticGithubRef(input.writerStaticRef);
    if (staticReviewerRef === undefined) {
      throw new SimulatedReviewPublicationError(
        "strict simulated review requires a distinct reviewer credential: configure a static " +
          "GitHub token ref (project/org githubCredentialRef) alongside the App install, or pass " +
          "reviewerGithubCredentialRef",
      );
    }
    return resolveVcsToken(input.githubHttp, {
      secrets: input.secrets,
      staticRef: staticReviewerRef,
    });
  }
  throw new SimulatedReviewPublicationError(
    "strict simulated review requires a distinct reviewer identity: with only a single static " +
      "GitHub credential the writer and reviewer are the same login (GitHub rejects self-" +
      "APPROVE/REQUEST_CHANGES). Install the GitHub App for the writer and keep a static " +
      "reviewer token, or pass reviewerGithubCredentialRef",
  );
}

export type SimulatedReviewReconcileInput = {
  reviews: ReadonlyArray<ListedPullRequestReview>;
  expectedState: "approved" | "changes_requested";
  expectedHeadSha: string;
  expectedReviewerLogin: string;
};

export type SimulatedReviewReconcileResult = { kind: "reuse"; receipt: SubmittedReviewReceipt } | { kind: "absent" };

/**
 * Pure forge-side reconcile: adopt only an exact-head, exact-login, marker-
 * matched, land-authoritative Tanren simulated review. Wrong head / wrong login
 * / wrong marker / COMMENT / non-authoritative state are ignored. Opposite
 * terminal Tanren state on the same head fails loud. Multiple distinct matches
 * or a marker-hit that cannot mint a receipt fail loud (ambiguity).
 */
export function reconcileExistingSimulatedReviews(
  input: SimulatedReviewReconcileInput,
): SimulatedReviewReconcileResult {
  const head = input.expectedHeadSha.toLowerCase();
  if (!/^[0-9a-f]{40}$/iu.test(input.expectedHeadSha)) {
    throw new SimulatedReviewPublicationError(
      `simulated review reconcile requires exact 40-hex head (got ${input.expectedHeadSha})`,
    );
  }
  const login = input.expectedReviewerLogin.toLowerCase();
  if (login === "") {
    throw new SimulatedReviewPublicationError("simulated review reconcile requires reviewer login");
  }
  const opposite: "approved" | "changes_requested" =
    input.expectedState === "approved" ? "changes_requested" : "approved";

  const sameMatches: ListedPullRequestReview[] = [];
  for (const review of input.reviews) {
    if (review.headSha === undefined || review.headSha.toLowerCase() !== head) continue;
    if (review.reviewerLogin === undefined || review.reviewerLogin.toLowerCase() !== login) continue;

    const hasExpectedMarker = bodyContainsTanrenSimulatedMarker(review.body, input.expectedState);
    const hasOppositeMarker = bodyContainsTanrenSimulatedMarker(review.body, opposite);

    // Marker is the Tanren ownership proof — no marker ⇒ coincidental human/other.
    if (!hasExpectedMarker && !hasOppositeMarker) continue;

    // COMMENT (or pending/dismissed) is never land-authoritative, even with a marker.
    if (review.state !== "approved" && review.state !== "changes_requested") {
      if (hasExpectedMarker || hasOppositeMarker) {
        throw new SimulatedReviewPublicationError(
          `simulated review forge convergence rejects non-authoritative state '${review.state}' ` +
            `for Tanren-marked review ${review.forgeReviewId} on head ${input.expectedHeadSha}`,
        );
      }
      continue;
    }

    if (hasOppositeMarker || review.state === opposite) {
      throw new SimulatedReviewPublicationError(
        `simulated review forge convergence conflict: existing Tanren review ` +
          `${review.forgeReviewId} is ${review.state} on head ${input.expectedHeadSha}, ` +
          `refusing to publish ${input.expectedState}`,
      );
    }

    if (hasExpectedMarker && review.state === input.expectedState) {
      sameMatches.push(review);
    } else if (hasExpectedMarker) {
      // Marker claims expected state but host state disagrees — fail loud.
      throw new SimulatedReviewPublicationError(
        `simulated review forge convergence ambiguity: review ${review.forgeReviewId} ` +
          `marker is ${input.expectedState} but host state is ${review.state}`,
      );
    }
  }

  if (sameMatches.length === 0) return { kind: "absent" };
  if (sameMatches.length > 1) {
    const ids = sameMatches.map((r) => r.forgeReviewId).join(",");
    throw new SimulatedReviewPublicationError(
      `simulated review forge convergence ambiguity: ${sameMatches.length} Tanren reviews ` +
        `(${ids}) match head ${input.expectedHeadSha} state ${input.expectedState}`,
    );
  }
  const match = sameMatches[0]!;
  try {
    const receipt = receiptFromListedReview(match);
    return { kind: "reuse", receipt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SimulatedReviewPublicationError(
      `simulated review forge convergence found malformed durable review ${match.forgeReviewId}: ${message}`,
    );
  }
}

/**
 * Forge-side recovery authority for strict simulated publication:
 *   1. List + reconcile before POST (stage retry / prior success).
 *   2. POST only when absent.
 *   3. On POST failure, re-list + reconcile (response-loss recovery).
 * Never double-POSTs when a matching durable forge review already exists.
 */
export async function publishSimulatedReviewConvergent(input: {
  listReviews: () => Promise<ReadonlyArray<ListedPullRequestReview>>;
  postReview: () => Promise<SubmittedReviewReceipt>;
  expectedState: "approved" | "changes_requested";
  expectedHeadSha: string;
  expectedReviewerLogin: string;
}): Promise<SubmittedReviewReceipt> {
  const target = {
    expectedState: input.expectedState,
    expectedHeadSha: input.expectedHeadSha,
    expectedReviewerLogin: input.expectedReviewerLogin,
  };
  const before = reconcileExistingSimulatedReviews({
    reviews: await input.listReviews(),
    ...target,
  });
  if (before.kind === "reuse") return before.receipt;

  try {
    return await input.postReview();
  } catch (postErr) {
    // Response-loss / ambiguous transport: the forge may have accepted the review.
    // Re-list and reclaim; only rethrow the post error when still absent.
    let after: SimulatedReviewReconcileResult;
    try {
      after = reconcileExistingSimulatedReviews({
        reviews: await input.listReviews(),
        ...target,
      });
    } catch (listOrReconcileErr) {
      // Prefer the original post failure when re-list itself fails; surface
      // reconcile conflict if the re-list succeeded into a conflict (thrown above).
      if (listOrReconcileErr instanceof SimulatedReviewPublicationError) {
        throw listOrReconcileErr;
      }
      throw postErr instanceof Error ? postErr : new Error(String(postErr));
    }
    if (after.kind === "reuse") return after.receipt;
    throw postErr instanceof Error ? postErr : new Error(String(postErr));
  }
}
