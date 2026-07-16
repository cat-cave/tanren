// Production GitHub ReviewProbe for the review-polling stage (extracted so
// reviewPolling.ts stays under the 500-line architecture cap). Ready-flip and
// external-approval reads stay best-effort via SafeVisibilityProjection; strict
// simulated-review publication calls GitHubReviewMergeService with a distinct
// reviewer token and throws on any failure (gv-2). Forge-side convergent
// publish (list → reconcile → POST only if absent → response-loss re-list)
// lives here so production composition always converges the external artifact.

import type { SecretStore } from "../../contracts/secretStore.js";
import type { RepoRef, ResolvedVcsToken } from "../../contracts/codeHostTypes.js";
import { repoPath, type GitHubHttpClient } from "../../providers/github.js";
import type { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import { resolveVcsToken } from "../../credentials/vcsCredentials.js";
import { projectHostSeamsOver } from "../../providers/projectHostSeamsOver.js";
import {
  GitHubReviewMergeService,
  GitHubReviewHttpError,
  type ReviewVerdictResult,
  type SubmitReviewEvent,
  type SubmittedReviewReceipt,
} from "../../providers/githubReviewMerge.js";
import type { ReviewMergeRunContext } from "./context.js";
import {
  bodyContainsTanrenSimulatedMarker,
  publishSimulatedReviewConvergent,
  requireSimulatedReviewIntentMarker,
  resolveDistinctSimulatedReviewerToken,
  SimulatedReviewHeadStaleError,
  SimulatedReviewPublicationError,
} from "./simulatedReviewPublication.js";

/**
 * Injectable review-state probe (real GitHub by default; mocked in tests). The
 * `fetchSnapshot`/`fetchLiveHeadSha`/`pinSimulatedReviewer` members are used ONLY on the
 * simulated path; human/auto test probes may omit them.
 */
export interface ReviewProbe {
  markReady(): Promise<void>;
  fetchVerdict(): Promise<ReviewVerdictResult>;
  /** One coherent PR metadata read followed by an immutable base/head diff. */
  fetchSnapshot?(): Promise<ReviewSnapshot>;
  /** Re-read only the live PR head immediately before the provider POST. */
  fetchLiveHeadSha?(): Promise<string>;
  /** Resolve one attempt-scoped reviewer identity + credential capability. */
  pinSimulatedReviewer?(): Promise<PinnedSimulatedReviewer>;
}

/**
 * Opaque attempt capability: the login and submit closure are derived from one
 * credential resolution. The token never enters the intent/event payload, and
 * submit cannot perform a second mutable secret lookup.
 */
export interface PinnedSimulatedReviewer {
  readonly reviewerLogin: string;
  submitReview(event: SubmitReviewEvent, body: string, headSha: string): Promise<SubmittedReviewReceipt>;
}

export interface ReviewSnapshot {
  baseSha: string;
  headSha: string;
  authorLogin: string;
  diff: string;
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
  const repoFullName = `${repo.owner}/${repo.name}`;
  const { codeHost, visibility } = projectHostSeamsOver(githubHttp, async () => resolved);
  const reviewMerge = new GitHubReviewMergeService(githubHttp);
  async function pinSimulatedReviewer(): Promise<PinnedSimulatedReviewer> {
    const resolvedReviewer = await resolveDistinctSimulatedReviewerToken({
      secrets,
      githubHttp,
      writerInstallation: context.installation,
      writerStaticRef: context.staticCredentialRef,
      githubAppMinter,
      reviewerGithubCredentialRef: input.reviewerGithubCredentialRef,
    });
    const { reviewer, reviewerLogin } = resolvedReviewer;
    return {
      reviewerLogin,
      submitReview: (event, body, headSha) =>
        publishPinnedSimulatedReview({
          event,
          body,
          headSha,
          reviewer,
          reviewerLogin,
          githubHttp,
          reviewMerge,
          resolvedWriter: resolved,
          repo,
          pullNumber,
        }),
    };
  }
  return {
    markReady: async () => {
      await visibility.markChangeRequestReady({ repoFullName, changeRequestNumber: pullNumber });
    },
    fetchVerdict: async () => {
      const outcome = await visibility.readExternalApproval({ repoFullName, changeRequestNumber: pullNumber });
      return outcome.kind === "projected" ? outcome.value : { verdict: "pending" };
    },
    fetchSnapshot: async () => {
      const metadata = await readReviewMetadata(githubHttp, repo, pullNumber, resolved);
      return { ...metadata, diff: await codeHost.readDiff(repo, metadata.baseSha, metadata.headSha) };
    },
    fetchLiveHeadSha: async () => (await readReviewMetadata(githubHttp, repo, pullNumber, resolved)).headSha,
    pinSimulatedReviewer,
  };
}

async function publishPinnedSimulatedReview(input: {
  event: SubmitReviewEvent;
  body: string;
  headSha: string;
  reviewer: ResolvedVcsToken;
  reviewerLogin: string;
  githubHttp: GitHubHttpClient;
  reviewMerge: GitHubReviewMergeService;
  resolvedWriter: ResolvedVcsToken;
  repo: RepoRef;
  pullNumber: number;
}): Promise<SubmittedReviewReceipt> {
  if (input.event === "COMMENT") {
    throw new SimulatedReviewPublicationError(
      "strict simulated review refuses COMMENT event — only APPROVE/REQUEST_CHANGES",
    );
  }
  const expectedState = input.event === "APPROVE" ? "approved" : "changes_requested";
  if (!bodyContainsTanrenSimulatedMarker(input.body, expectedState)) {
    throw new SimulatedReviewPublicationError(
      `strict simulated review body missing durable Tanren marker for ${expectedState}`,
    );
  }
  const expectedIntentMarker = requireSimulatedReviewIntentMarker(input.body);
  try {
    return await publishSimulatedReviewConvergent({
      expectedState,
      expectedHeadSha: input.headSha,
      expectedReviewerLogin: input.reviewerLogin,
      expectedIntentMarker,
      listReviews: () =>
        input.reviewMerge.listPullRequestReviews({
          repo: input.repo,
          pullNumber: input.pullNumber,
          token: input.reviewer.token,
          refreshToken: input.reviewer.refresh,
        }),
      postReview: async () => {
        const liveHeadSha = (
          await readReviewMetadata(input.githubHttp, input.repo, input.pullNumber, input.resolvedWriter)
        ).headSha;
        if (liveHeadSha.toLowerCase() !== input.headSha.toLowerCase()) {
          throw new SimulatedReviewHeadStaleError(input.headSha, liveHeadSha);
        }
        const receipt = await input.reviewMerge.submitReview({
          repo: input.repo,
          pullNumber: input.pullNumber,
          event: input.event,
          body: input.body,
          commitId: input.headSha,
          token: input.reviewer.token,
          refreshToken: input.reviewer.refresh,
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
    throw new SimulatedReviewPublicationError(`simulated review forge publication failed: ${message}`, {
      retriable: err instanceof GitHubReviewHttpError && err.retriable,
    });
  }
}

async function readReviewMetadata(
  http: GitHubHttpClient,
  repo: RepoRef,
  pullNumber: number,
  token: ResolvedVcsToken,
): Promise<{ baseSha: string; headSha: string; authorLogin: string }> {
  const response = await http.request({
    method: "GET",
    path: repoPath(repo, `/pulls/${pullNumber}`),
    token: token.token,
    refreshToken: token.refresh,
  });
  if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
    throw new SimulatedReviewPublicationError(
      `strict simulated review PR snapshot failed for #${pullNumber}: HTTP ${response.status}`,
      { retriable: response.status === 408 || response.status === 429 || response.status >= 500 },
    );
  }
  const body = response.body as {
    base?: { sha?: unknown };
    head?: { sha?: unknown };
    user?: { login?: unknown };
  };
  const baseSha = body.base?.sha;
  const headSha = body.head?.sha;
  const authorLogin = body.user?.login;
  if (
    typeof baseSha !== "string" ||
    !/^[0-9a-f]{40}$/iu.test(baseSha) ||
    typeof headSha !== "string" ||
    !/^[0-9a-f]{40}$/iu.test(headSha) ||
    typeof authorLogin !== "string" ||
    authorLogin.trim() === ""
  ) {
    throw new SimulatedReviewPublicationError(
      `strict simulated review PR snapshot for #${pullNumber} lacked exact base/head/author metadata`,
    );
  }
  return { baseSha, headSha, authorLogin: authorLogin.trim() };
}
