// Production GitHub ReviewProbe for the review-polling stage (extracted so
// reviewPolling.ts stays under the 500-line architecture cap). Ready-flip and
// external-approval reads stay best-effort via SafeVisibilityProjection; strict
// simulated-review publication calls GitHubReviewMergeService with a distinct
// reviewer token and throws on any failure (gv-2). Forge-side convergent
// publish (list → reconcile → POST only if absent → response-loss re-list)
// lives here so production composition always converges the external artifact.

import type { SecretStore } from "../../contracts/secretStore.js";
import type { PullRequestRef, RepoRef } from "../../contracts/codeHostTypes.js";
import type { GitHubHttpClient } from "../../providers/github.js";
import type { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import { resolveVcsToken } from "../../credentials/vcsCredentials.js";
import { projectHostSeamsOver, readChangeRequestShas } from "../../providers/projectHostSeamsOver.js";
import {
  GitHubReviewMergeService,
  type ReviewVerdictResult,
  type SubmitReviewEvent,
  type SubmittedReviewReceipt,
} from "../../providers/githubReviewMerge.js";
import type { ReviewMergeRunContext } from "./context.js";
import {
  bodyContainsTanrenSimulatedMarker,
  publishSimulatedReviewConvergent,
  resolveDistinctSimulatedReviewerToken,
  SimulatedReviewPublicationError,
} from "./simulatedReviewPublication.js";

/**
 * Injectable review-state probe (real GitHub by default; mocked in tests). The
 * `fetchDiff`/`fetchHeadSha`/`submitReview` members are used ONLY on the
 * simulated path; human/auto test probes may omit them.
 */
export interface ReviewProbe {
  markReady(): Promise<void>;
  fetchVerdict(): Promise<ReviewVerdictResult>;
  fetchDiff?(): Promise<string>;
  /** Exact PR head SHA the simulated review is bound to. */
  fetchHeadSha?(): Promise<string>;
  /**
   * Distinct reviewer login for the durable intent fence. Production resolves
   * the dual-credential seam; test probes may hard-code the fixture login.
   */
  resolveReviewerLogin?(): Promise<string>;
  /**
   * Strict forge publication: posts the event (or reclaims an existing exact
   * match) and returns a durable receipt. Must throw (not swallow) on failure
   * — no best-effort path for simulated land.
   */
  submitReview?(event: SubmitReviewEvent, body: string, headSha: string): Promise<SubmittedReviewReceipt>;
}

export interface BuildGitHubReviewProbeInput {
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
  reviewerGithubCredentialRef?: string;
  context: ReviewMergeRunContext;
  repo: RepoRef;
  pullNumber: number;
}

export async function buildGitHubReviewProbe(input: BuildGitHubReviewProbeInput): Promise<ReviewProbe> {
  const { secrets, githubHttp, githubAppMinter, context, repo, pullNumber } = input;
  const resolved = await resolveVcsToken(githubHttp, {
    secrets,
    installation: context.installation,
    staticRef: context.staticCredentialRef,
    minter: githubAppMinter,
  });
  const pr: PullRequestRef = { repo, number: pullNumber };
  const repoFullName = `${repo.owner}/${repo.name}`;
  const { codeHost, visibility } = projectHostSeamsOver(githubHttp, async () => resolved);
  const reviewMerge = new GitHubReviewMergeService(githubHttp);
  let cachedReviewer:
    | { reviewer: Awaited<ReturnType<typeof resolveDistinctSimulatedReviewerToken>>["reviewer"]; reviewerLogin: string }
    | undefined;
  async function loadReviewer() {
    if (cachedReviewer !== undefined) return cachedReviewer;
    const resolvedReviewer = await resolveDistinctSimulatedReviewerToken({
      secrets,
      githubHttp,
      writerInstallation: context.installation,
      writerStaticRef: context.staticCredentialRef,
      githubAppMinter,
      reviewerGithubCredentialRef: input.reviewerGithubCredentialRef,
    });
    cachedReviewer = { reviewer: resolvedReviewer.reviewer, reviewerLogin: resolvedReviewer.reviewerLogin };
    return cachedReviewer;
  }
  return {
    markReady: async () => {
      await visibility.markChangeRequestReady({ repoFullName, changeRequestNumber: pullNumber });
    },
    fetchVerdict: async () => {
      const outcome = await visibility.readExternalApproval({ repoFullName, changeRequestNumber: pullNumber });
      return outcome.kind === "projected" ? outcome.value : { verdict: "pending" };
    },
    fetchDiff: async () => {
      const { baseSha, headSha } = await readChangeRequestShas(githubHttp, pr, resolved);
      return codeHost.readDiff(repo, baseSha, headSha);
    },
    fetchHeadSha: async () => {
      const { headSha } = await readChangeRequestShas(githubHttp, pr, resolved);
      return headSha;
    },
    resolveReviewerLogin: async () => {
      const { reviewerLogin } = await loadReviewer();
      return reviewerLogin;
    },
    submitReview: async (event, body, headSha) => {
      if (event === "COMMENT") {
        throw new SimulatedReviewPublicationError(
          "strict simulated review refuses COMMENT event — only APPROVE/REQUEST_CHANGES",
        );
      }
      const expectedState = event === "APPROVE" ? "approved" : "changes_requested";
      if (!bodyContainsTanrenSimulatedMarker(body, expectedState)) {
        throw new SimulatedReviewPublicationError(
          `strict simulated review body missing durable Tanren marker for ${expectedState}`,
        );
      }
      const { reviewer, reviewerLogin } = await loadReviewer();
      try {
        // list→POST convergence lives here; the stage wraps this call in the
        // cross-process advisory publish fence so concurrent workers serialize.
        return await publishSimulatedReviewConvergent({
          expectedState,
          expectedHeadSha: headSha,
          expectedReviewerLogin: reviewerLogin,
          listReviews: () =>
            reviewMerge.listPullRequestReviews({
              repo,
              pullNumber,
              token: reviewer.token,
              refreshToken: reviewer.refresh,
            }),
          postReview: async () => {
            const receipt = await reviewMerge.submitReview({
              repo,
              pullNumber,
              event,
              body,
              commitId: headSha,
              token: reviewer.token,
              refreshToken: reviewer.refresh,
            });
            if (receipt === undefined) {
              throw new SimulatedReviewPublicationError(
                "strict simulated review got no forge receipt (COMMENT or empty response)",
              );
            }
            return receipt;
          },
        });
      } catch (err) {
        if (err instanceof SimulatedReviewPublicationError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new SimulatedReviewPublicationError(`simulated review forge publication failed: ${message}`);
      }
    },
  };
}
