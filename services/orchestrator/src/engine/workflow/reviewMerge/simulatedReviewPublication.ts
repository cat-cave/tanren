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
import type { SubmittedReviewReceipt, SubmitReviewEvent } from "../../providers/githubReviewMerge.js";

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
