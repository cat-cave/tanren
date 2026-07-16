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

import { createHash } from "node:crypto";
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
export const TANREN_SIMULATED_REVIEW_INTENT_PREFIX = "tanren-simulated-review-intent:v1:" as const;

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

export function simulatedReviewIntentFingerprint(input: {
  runId: string;
  taskId: string;
  headSha: string;
  state: "approved" | "changes_requested";
  reviewerLogin: string;
  message: string;
}): string {
  const canonical = JSON.stringify([
    input.runId,
    input.taskId,
    input.headSha.toLowerCase(),
    input.state,
    input.reviewerLogin.trim().toLowerCase(),
    input.message,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export function simulatedReviewIntentMarker(fingerprint: string): string {
  if (!/^[0-9a-f]{64}$/u.test(fingerprint)) {
    throw new SimulatedReviewPublicationError("simulated review intent fingerprint must be 64 lowercase hex");
  }
  return `${TANREN_SIMULATED_REVIEW_INTENT_PREFIX}${fingerprint}`;
}

export function bodyContainsSimulatedReviewIntentMarker(body: string | undefined, marker: string): boolean {
  if (body === undefined || body === "") return false;
  return body.split(/\r?\n/u).some((line) => line.trim() === marker);
}

export function requireSimulatedReviewIntentMarker(body: string): string {
  const markers = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(TANREN_SIMULATED_REVIEW_INTENT_PREFIX));
  if (markers.length !== 1 || !/^tanren-simulated-review-intent:v1:[0-9a-f]{64}$/u.test(markers[0] ?? "")) {
    throw new SimulatedReviewPublicationError(
      "strict simulated review body requires exactly one valid durable intent fingerprint marker",
    );
  }
  return markers[0]!;
}

/** Durable forge receipt fields bound onto the terminal review.* event payload. */
export interface ForgeReviewPublication {
  forgeReviewId: string;
  forgeReviewState: "approved" | "changes_requested";
  forgeReviewUrl: string;
  headSha: string;
  /** Provider-proved reviewer login (mandatory — never synthesized from credential label alone). */
  reviewerLogin: string;
}

/** Fail-closed publication / identity error — leaves review/land non-authorized. */
export class SimulatedReviewPublicationError extends Error {
  /**
   * Default false (structural / permanent). Fence-busy and similar contention
   * paths pass `{ retriable: true }` so the job redrive re-lists/reclaims.
   */
  readonly retriable: boolean;
  constructor(message: string, opts?: { retriable?: boolean }) {
    super(message);
    this.name = "SimulatedReviewPublicationError";
    this.retriable = opts?.retriable ?? false;
  }
}

/** The PR advanced after review computation; redrive must snapshot and review the new head. */
export class SimulatedReviewHeadStaleError extends SimulatedReviewPublicationError {
  override readonly retriable = true as const;
  constructor(expectedHeadSha: string, liveHeadSha: string) {
    super(`simulated review head advanced before publication: reviewed=${expectedHeadSha} live=${liveHeadSha}`, {
      retriable: true,
    });
    this.name = "SimulatedReviewHeadStaleError";
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
  const reviewerLogin = receipt.reviewerLogin?.trim() ?? "";
  if (reviewerLogin === "") {
    throw new SimulatedReviewPublicationError(
      "simulated review publication missing provider reviewer login (required provider proof)",
    );
  }
  return {
    forgeReviewId: receipt.forgeReviewId,
    forgeReviewState: receipt.forgeReviewState,
    forgeReviewUrl: receipt.forgeReviewUrl,
    headSha: receipt.headSha,
    reviewerLogin,
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
  expectedIntentMarker: string;
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
  const login = input.expectedReviewerLogin.trim().toLowerCase();
  if (login === "") {
    throw new SimulatedReviewPublicationError("simulated review reconcile requires reviewer login");
  }
  const opposite: "approved" | "changes_requested" =
    input.expectedState === "approved" ? "changes_requested" : "approved";

  const sameMatches: ListedPullRequestReview[] = [];
  for (const review of input.reviews) {
    if (isMatchingExistingReview(review, input, head, login, opposite)) sameMatches.push(review);
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

function isMatchingExistingReview(
  review: ListedPullRequestReview,
  input: SimulatedReviewReconcileInput,
  head: string,
  login: string,
  opposite: "approved" | "changes_requested",
): boolean {
  if (review.headSha === undefined || review.headSha.toLowerCase() !== head) return false;
  if (review.reviewerLogin === undefined || review.reviewerLogin.toLowerCase() !== login) return false;
  if (!bodyContainsSimulatedReviewIntentMarker(review.body, input.expectedIntentMarker)) return false;
  const hasExpectedMarker = bodyContainsTanrenSimulatedMarker(review.body, input.expectedState);
  const hasOppositeMarker = bodyContainsTanrenSimulatedMarker(review.body, opposite);
  if (!hasExpectedMarker && !hasOppositeMarker) return false;
  if (review.state !== "approved" && review.state !== "changes_requested") {
    throw new SimulatedReviewPublicationError(
      `simulated review forge convergence rejects non-authoritative state '${review.state}' ` +
        `for Tanren-marked review ${review.forgeReviewId} on head ${input.expectedHeadSha}`,
    );
  }
  if (hasOppositeMarker || review.state === opposite) {
    throw new SimulatedReviewPublicationError(
      `simulated review forge convergence conflict: existing Tanren review ` +
        `${review.forgeReviewId} is ${review.state} on head ${input.expectedHeadSha}, ` +
        `refusing to publish ${input.expectedState}`,
    );
  }
  if (hasExpectedMarker && review.state === input.expectedState) return true;
  throw new SimulatedReviewPublicationError(
    `simulated review forge convergence ambiguity: review ${review.forgeReviewId} ` +
      `marker is ${input.expectedState} but host state is ${review.state}`,
  );
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
  expectedIntentMarker: string;
}): Promise<SubmittedReviewReceipt> {
  const target = {
    expectedState: input.expectedState,
    expectedHeadSha: input.expectedHeadSha,
    expectedReviewerLogin: input.expectedReviewerLogin,
    expectedIntentMarker: input.expectedIntentMarker,
  };
  const before = reconcileExistingSimulatedReviews({
    reviews: await input.listReviews(),
    ...target,
  });
  if (before.kind === "reuse") return before.receipt;

  try {
    return await input.postReview();
  } catch (postErr) {
    // The immediately-pre-POST head guard proves no write was attempted, so
    // this is not ambiguous response loss and needs no recovery re-list.
    if (postErr instanceof SimulatedReviewHeadStaleError) throw postErr;
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
