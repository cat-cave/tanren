import type { RunnerHandle } from "../contracts/allocator.js";
import type { ActorIdentity } from "../contracts/codeHostTypes.js";
import type { EventStore } from "../eventStore.js";
import { NoCommitsBetweenBaseAndHeadError } from "../providers/githubPullRequestReuse.js";
import { prepareCleanPrBranch } from "../workspace/index.js";
import { publishDraftPullRequestWithDurableLease } from "./githubDraftPrDurableLease.js";
import { findPendingDraftPushIntent } from "./githubDraftPrPushIntent.js";
import { publishDraftPullRequest, type PublishedDraftPullRequest } from "./githubDraftPr.js";
import { appTokenSeam, mergeQueueEarlyEnqueueSeam } from "./plannerRunSeams.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "./plannerRun.js";

export type NoCommitsDisposition = "converged" | "redrive";

export type CleanedPushSource = Awaited<ReturnType<typeof prepareCleanPrBranch>>;

export type PublishCleanedDraftPrResult =
  | { kind: "published"; pushSource: CleanedPushSource; pullRequest: PublishedDraftPullRequest }
  | { kind: "no_commits"; pushSource: CleanedPushSource; disposition: NoCommitsDisposition };

export function requirePublishedHeadSha(headSha: string): string {
  if (!/^[0-9a-f]{40}$/u.test(headSha)) {
    throw new Error("cleaned draft PR head is invalid; refusing to publish without a durable lease witness");
  }
  return headSha;
}

/**
 * Prepare the cleaned PR branch + publish the draft PR for one writer-loop pass. Replays
 * the writer commits onto the clone HEAD, dropping the synthetic bootstrap commit (+
 * install artifacts) so the pushed branch / PR carries only the writer's changes (the
 * working HEAD is left intact so a review/merge-gate-rework re-entry keeps its bootstrapSha
 * diff base — no-op on fake-SSH), then publishes the draft PR. Returns both the cleaned
 * push source (its `headSha` is the commit the `pre_merge` gate + land authority bind to,
 * §5) and the published PR.
 *
 * A pending write-ahead intent is a crash recovery instruction, not a hint. It is read
 * before clean-PR preparation so a rebuilt SHA can never replace the remote CAS that may
 * already have succeeded. Publication then reconciles that immutable intent against the
 * remote ref before deciding whether a push is needed.
 */
export async function publishCleanedDraftPr(
  input: RunPlannerLoopInput,
  ctx: { target: RunnerHandle; workspacePath: string; eventStore: EventStore },
  context: PlannerRunContext,
  shas: { cloneHeadSha: string; bootstrapSha: string; pushIdentity?: ActorIdentity },
): Promise<PublishCleanedDraftPrResult> {
  const pendingIntent = await findPendingDraftPushIntent(input.pool, {
    orgId: context.orgId,
    projectId: context.projectId,
    runId: context.runId,
    specId: context.specId,
    repoUrl: context.repoUrl,
    branch: context.runBranch,
  });
  const pushSource =
    pendingIntent === undefined
      ? await prepareCleanPrBranch({
          ssh: input.ssh,
          target: ctx.target,
          workspacePath: ctx.workspacePath,
          cloneHeadSha: shas.cloneHeadSha,
          bootstrapSha: shas.bootstrapSha,
          runId: context.runId,
          ...(shas.pushIdentity !== undefined && { pushIdentity: shas.pushIdentity }),
        })
      : { ref: pendingIntent.sourceRef, headSha: pendingIntent.intendedSha };
  const publishedHeadSha = requirePublishedHeadSha(pushSource.headSha);
  try {
    const appendEventOrgId = context.orgId;
    const pullRequest = await publishDraftPullRequestWithDurableLease(
      {
        pool: input.pool,
        eventStore: ctx.eventStore,
        runStateWriter: input.runStateWriter,
        orgId: context.orgId,
        appendEventOrgId,
        secrets: input.secrets,
        githubHttp: input.githubHttp,
        ssh: input.ssh,
        target: ctx.target,
        sourceRef: publishedHeadSha,
        publishedHeadSha,
        runId: context.runId,
        specId: context.specId,
        projectId: context.projectId,
        workspacePath: ctx.workspacePath,
        repoUrl: context.repoUrl,
        targetBranch: context.targetBranch,
        ...(context.ancestorStack !== undefined && { ancestorStack: context.ancestorStack }),
        runBranch: context.runBranch,
        title: `Tanren: ${context.specTitle}`,
        body: context.specDescription,
        githubCredentialRef: context.githubCredentialRef,
        ...appTokenSeam(context, input),
        ...mergeQueueEarlyEnqueueSeam(input, context, ctx.eventStore, appendEventOrgId),
      },
      { orgId: context.orgId, specId: context.specId, branch: context.runBranch },
      publishDraftPullRequest,
    );
    return { kind: "published", pushSource, pullRequest };
  } catch (error) {
    if (error instanceof NoCommitsBetweenBaseAndHeadError) {
      const disposition = discriminateNoCommits(pushSource.headSha, shas.cloneHeadSha);
      return { kind: "no_commits", pushSource, disposition };
    }
    throw error;
  }
}

export function discriminateNoCommits(cleanedHeadSha: string, cloneHeadSha: string): NoCommitsDisposition {
  if (cleanedHeadSha === "" || cleanedHeadSha === cloneHeadSha) return "redrive";
  return "converged";
}
