// A RAW `VisibilityProjection` (tanren-owns-the-engine.md §0, §6) backed by the
// EXISTING `VcsProvider` rather than the bare `GitHubHttpClient`. WHY this exists
// alongside `GitHubVisibilityProjection`: the live forge-UI write call-sites (the
// draft-PR open, the `tanren/gate` status publish, the simulated-review comment)
// already hold a `VcsProvider` + a resolved token — NOT the raw http client. This
// adapter lets those sites route their write through the SAME best-effort severance
// (`harden` → `SafeVisibilityProjection`) without threading a second http client +
// token plumbing down every stage. It re-uses the provider's `openDraftPullRequest`
// / `publishStatus` / `submitReview` / `retargetPullRequestBase` — it never
// re-implements GitHub logic, so the published artifact is byte-identical to today.
//
// CRITICAL (§0): this is the RAW impl — each method MAY reject (it talks to the
// forge). The engine never holds it directly; it only reaches it through `harden()`,
// which captures a rejection as `ProjectionOutcome.failed` and CAN NEVER propagate
// it to the caller. So a projection failure can never alter a recorded decision.

import type {
  ChangeRequestInput,
  ProjectedChangeRequest,
  PublishGateInput,
  PublishReviewInput,
  RetargetChangeRequestInput,
  VisibilityProjection,
} from "../contracts/visibilityProjection.js";
import type { RepoRef, ResolvedVcsToken, StatusState, VcsProvider } from "../contracts/vcsProvider.js";

/** The context label of the gate verdict published as a `tanren/gate` commit status. */
export const GATE_PROJECTION_CONTEXT = "tanren/gate";

/** GitHub caps a commit-status `description` at 140 chars; clamp the summary inside it. */
const STATUS_DESCRIPTION_MAX = 140;

/**
 * Parse a `repoFullName` (`owner/name`) into the provider-neutral {@link RepoRef}.
 * A malformed value is a LOUD throw — captured by `harden()` as a `failed` outcome.
 */
function parseRepoFullName(repoFullName: string): RepoRef {
  const slash = repoFullName.indexOf("/");
  const owner = slash === -1 ? "" : repoFullName.slice(0, slash);
  const name = slash === -1 ? "" : repoFullName.slice(slash + 1);
  if (owner === "" || name === "" || name.includes("/")) {
    throw new Error(`unsupported repoFullName (expected owner/name): ${repoFullName}`);
  }
  return { owner, name };
}

/** Clamp a status description to GitHub's commit-status limit (no secrets in the text). */
function clampDescription(text: string): string {
  return text.length <= STATUS_DESCRIPTION_MAX ? text : `${text.slice(0, STATUS_DESCRIPTION_MAX - 1)}…`;
}

/**
 * A RAW {@link VisibilityProjection} that mirrors a change onto the forge UI through
 * an existing {@link VcsProvider} + a resolved-token supplier. Constructed at a call
 * site that already resolved its token; the supplier is invoked per projection call
 * so a long-lived instance never holds a stale credential.
 */
export class VcsProviderVisibilityProjection implements VisibilityProjection {
  constructor(
    private readonly provider: VcsProvider,
    private readonly resolveToken: () => Promise<ResolvedVcsToken>,
  ) {}

  // Open-or-REUSE the canonical draft PR for the head branch — the provider's
  // idempotent `openDraftPullRequest`, returning the human-facing PR handle.
  async openOrUpdateChangeRequest(input: ChangeRequestInput): Promise<ProjectedChangeRequest> {
    const repo = parseRepoFullName(input.repoFullName);
    const token = await this.resolveToken();
    const pr = await this.provider.openDraftPullRequest({
      repo,
      token,
      headBranch: input.headBranch,
      baseBranch: input.baseBranch,
      title: input.title,
      ...(input.body !== undefined && { body: input.body }),
    });
    return { url: pr.url, number: pr.number };
  }

  // Post the `tanren/gate` COMMIT STATUS on the head sha (the provider's
  // `publishStatus`, the same primitive `publishGateVerdict` already publishes).
  async publishGate(input: PublishGateInput): Promise<void> {
    const repo = parseRepoFullName(input.repoFullName);
    const token = await this.resolveToken();
    const state: StatusState = input.verdict === "passed" ? "success" : "failure";
    await this.provider.publishStatus({
      repo,
      token,
      headSha: input.headSha,
      context: GATE_PROJECTION_CONTEXT,
      state,
      description: clampDescription(input.summary),
    });
  }

  // Submit a forge review COMMENT mirroring Tanren's recorded review (the provider's
  // `submitReview` as a COMMENT — the audit artifact, never the decision source).
  async publishReview(input: PublishReviewInput): Promise<void> {
    const repo = parseRepoFullName(input.repoFullName);
    const token = await this.resolveToken();
    await this.provider.submitReview({ repo, number: input.changeRequestNumber }, "COMMENT", input.body, token);
  }

  // Re-point the PR's base branch (the provider's `retargetPullRequestBase`).
  async retargetChangeRequest(input: RetargetChangeRequestInput): Promise<void> {
    const repo = parseRepoFullName(input.repoFullName);
    const token = await this.resolveToken();
    await this.provider.retargetPullRequestBase(
      { repo, number: input.changeRequestNumber },
      input.newBaseBranch,
      token,
    );
  }
}
