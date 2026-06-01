// P3-0008: the review-polling stage. Runs AFTER CI passes (additive to the
// planner-run tail). It marks the draft PR ready-for-review, emits
// review.requested, then polls the PR's review verdict. On approval it returns
// `approved` so the caller proceeds to the merge stage; on changes_requested it
// emits review.changes_requested (carrying the reviewer feedback as steering
// for the writer-rework re-entry) and returns `changes_requested`.
//
// All GitHub calls go through the P3-0003 resolver/client (App-or-static,
// 401-retry). The poll function is injectable so tests never hit real GitHub.

import type { RunStateWriter } from "../../contracts/runStateWriter.js";
import type { SecretStore } from "../../contracts/secretStore.js";
import { ensureSystemTask, routeTaskUpdate } from "../taskWriteRouting.js";
import { resolveGithubToken } from "../../credentials/githubTokenResolver.js";
import { type EventStore, PgEventStore } from "../../eventStore.js";
import type { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import { parseGitHubPullRequestUrl, type GitHubHttpClient } from "../../providers/github.js";
import {
  GitHubReviewMergeService,
  type ReviewVerdict,
  type ReviewVerdictResult,
} from "../../providers/githubReviewMerge.js";
import {
  contextOptionsFor,
  loadReviewMergeRunContext,
  type ReviewMergeRunContext,
  type RunStateClient,
} from "./context.js";

export interface PollReviewForRunInput {
  pool: RunStateClient;
  eventStore?: EventStore;
  // Plane-split P3c: route the review task INSERT/UPDATE through the control plane
  // when wired (remote-writes on); absent, the in-process org-scoped write runs.
  runStateWriter?: RunStateWriter;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  runId: string;
  githubAppMinter?: GithubAppTokenMinter;
  /**
   * The GitHub credential ref the run already resolved for the PR-creation +
   * CI-poll steps. Threaded through so the review stage resolves its token from
   * the same source (project RECORD `githubCredentialRef` → org default) rather
   * than the project-config JSONB alone.
   */
  resolvedGithubCredentialRef?: string;
  maxPolls?: number;
  pollDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Test seam. When provided, the stage uses this instead of GitHub for both
   * the ready-flip and the verdict reads. Production omits it → the real
   * GitHubReviewMergeService drives both through the resolved token.
   */
  reviewProbe?: ReviewProbe;
}

/** Injectable review-state probe (real GitHub by default; mocked in tests). */
export interface ReviewProbe {
  markReady(): Promise<void>;
  fetchVerdict(): Promise<ReviewVerdictResult>;
}

export interface PollReviewForRunResult {
  runId: string;
  taskId: string;
  verdict: ReviewVerdict;
  prUrl: string;
  prNumber: number;
  /** Reviewer login that produced the verdict, when known. */
  reviewer?: string;
  /** changes_requested feedback body, used as writer-rework steering. */
  feedback?: string;
}

export async function pollReviewForRun(input: PollReviewForRunInput): Promise<PollReviewForRunResult> {
  const context = await loadReviewMergeRunContext(input.pool, input.runId, contextOptionsFor(input));
  const eventStore = input.eventStore ?? new PgEventStore(input.pool);
  const pr = parseGitHubPullRequestUrl(context.prUrl);
  const taskId = await ensureReviewTask(input.pool, context, input.runStateWriter);
  await eventStore.append({
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    taskId,
    eventType: "task.started",
    payload: { taskKind: "review" },
  });

  const probe = input.reviewProbe ?? (await buildGitHubProbe(input, context, pr.repo, pr.pullNumber));

  // Flip draft → ready and announce the review request once.
  await probe.markReady();
  await eventStore.append({
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    taskId,
    eventType: "github.pr.ready",
    payload: { prUrl: context.prUrl, prNumber: pr.pullNumber },
  });
  await eventStore.append({
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    taskId,
    eventType: "review.requested",
    payload: { prUrl: context.prUrl, prNumber: pr.pullNumber },
  });

  // No-review tier (project reviewPolicy === "auto"): short-circuit to an
  // approved verdict immediately — no GitHub poll. The PR was already flipped
  // ready above (direct_merge refuses a draft), so the caller proceeds straight
  // to mergeForRun. A distinct `review.auto_approved` event records that no
  // human verdict gated the merge; `finalizeReviewTask` then emits the standard
  // `review.approved` + `task.completed` so every downstream consumer (dashboard
  // phase, review-stall insight, notification severity) reacts unchanged.
  if (context.reviewPolicy === "auto") {
    await eventStore.append({
      runId: context.runId,
      specId: context.specId,
      projectId: context.projectId,
      taskId,
      eventType: "review.auto_approved",
      payload: { prUrl: context.prUrl, prNumber: pr.pullNumber },
    });
    const autoResult: PollReviewForRunResult = {
      runId: context.runId,
      taskId,
      verdict: "approved",
      prUrl: context.prUrl,
      prNumber: pr.pullNumber,
    };
    await finalizeReviewTask(input.pool, eventStore, context, autoResult, input.runStateWriter);
    return autoResult;
  }

  const maxPolls = input.maxPolls ?? 12;
  const delayMs = input.pollDelayMs ?? 10_000;
  const sleep =
    input.sleep ??
    ((ms) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));

  let last: ReviewVerdictResult = { verdict: "pending" };
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    last = await probe.fetchVerdict();
    if (last.verdict !== "pending") {
      break;
    }
    if (attempt < maxPolls - 1) {
      await sleep(delayMs);
    }
  }

  const result: PollReviewForRunResult = {
    runId: context.runId,
    taskId,
    verdict: last.verdict,
    prUrl: context.prUrl,
    prNumber: pr.pullNumber,
    reviewer: last.latest?.reviewer,
    feedback: last.latest?.body,
  };
  await finalizeReviewTask(input.pool, eventStore, context, result, input.runStateWriter);
  return result;
}

async function finalizeReviewTask(
  pool: RunStateClient,
  eventStore: EventStore,
  context: ReviewMergeRunContext,
  result: PollReviewForRunResult,
  writer?: RunStateWriter,
): Promise<void> {
  const base = {
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    taskId: result.taskId,
  };
  if (result.verdict === "approved") {
    await markTaskDoneOk(pool, result.taskId, writer);
    await eventStore.append({
      ...base,
      eventType: "review.approved",
      payload: { prUrl: result.prUrl, prNumber: result.prNumber, reviewer: result.reviewer },
    });
    await eventStore.append({
      ...base,
      eventType: "task.completed",
      payload: { taskKind: "review", status: "approved" },
    });
    return;
  }
  if (result.verdict === "changes_requested") {
    // A standing changes-requested is not a task failure — it routes back into
    // the writer-rework path. Record the verdict event with the reviewer's body
    // as the steering message, and leave the task closed as ok (the rework
    // re-enters the loop, which opens its own writer tasks).
    await markTaskDoneOk(pool, result.taskId, writer);
    await eventStore.append({
      ...base,
      eventType: "review.changes_requested",
      payload: {
        prUrl: result.prUrl,
        prNumber: result.prNumber,
        reviewer: result.reviewer,
        message: result.feedback,
      },
    });
    await eventStore.append({
      ...base,
      eventType: "task.completed",
      payload: { taskKind: "review", status: "changes_requested" },
    });
    return;
  }
  // Pending after the budget: leave the task running (the operator hand-off and
  // the dashboard surface drive it from here).
  await routeTaskUpdate(
    writer,
    pool,
    { taskId: result.taskId, transition: "running_pending" },
    "UPDATE tasks SET status = 'running', outcome = 'pending', ended_at = NULL WHERE task_id = $1",
    [result.taskId],
  );
}

/** The `task done/ok` write, routed remote when wired (review approved + changes-requested). */
async function markTaskDoneOk(pool: RunStateClient, taskId: string, writer?: RunStateWriter): Promise<void> {
  await routeTaskUpdate(
    writer,
    pool,
    { taskId, transition: "done", outcome: "ok" },
    "UPDATE tasks SET status = 'done', outcome = 'ok', ended_at = now() WHERE task_id = $1",
    [taskId],
  );
}

async function buildGitHubProbe(
  input: PollReviewForRunInput,
  context: ReviewMergeRunContext,
  repo: ReturnType<typeof parseGitHubPullRequestUrl>["repo"],
  pullNumber: number,
): Promise<ReviewProbe> {
  const resolved = await resolveGithubToken({
    secrets: input.secrets,
    installation: context.installation,
    staticRef: context.staticCredentialRef,
    minter: input.githubAppMinter,
  });
  const service = new GitHubReviewMergeService(input.githubHttp);
  return {
    markReady: () =>
      service.markReadyForReview({
        repo,
        pullNumber,
        token: resolved.token,
        refreshToken: resolved.refresh,
      }),
    fetchVerdict: () =>
      service.fetchReviewVerdict({
        repo,
        pullNumber,
        token: resolved.token,
        refreshToken: resolved.refresh,
      }),
  };
}

async function ensureReviewTask(
  pool: RunStateClient,
  context: ReviewMergeRunContext,
  writer?: RunStateWriter,
): Promise<string> {
  return ensureSystemTask(pool, { runId: context.runId, kind: "review", title: "Poll pull request review" }, writer);
}
