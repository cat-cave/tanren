// P3-0008: the review-polling stage. Runs AFTER CI passes (additive to the
// planner-run tail). It marks the draft PR ready-for-review, emits
// review.requested, then polls the PR's review verdict. On approval it returns
// `approved` so the caller proceeds to the merge stage; on changes_requested it
// emits review.changes_requested (carrying the reviewer feedback as steering
// for the writer-rework re-entry) and returns `changes_requested`.
//
// All GitHub calls go through the P3-0003 resolver/client (App-or-static,
// 401-retry). The poll function is injectable so tests never hit real GitHub.

import { randomUUID } from "node:crypto";
import type { SecretStore } from "../../contracts/secretStore.js";
import { resolveGithubToken } from "../../credentials/githubTokenResolver.js";
import { type EventStore, PgEventStore } from "../../eventStore.js";
import type { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import { parseGitHubPullRequestUrl, type GitHubHttpClient } from "../../providers/github.js";
import {
  GitHubReviewMergeService,
  type ReviewVerdict,
  type ReviewVerdictResult,
} from "../../providers/githubReviewMerge.js";
import { loadReviewMergeRunContext, type ReviewMergeRunContext, type RunStateClient } from "./context.js";

export interface PollReviewForRunInput {
  pool: RunStateClient;
  eventStore?: EventStore;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  runId: string;
  githubAppMinter?: GithubAppTokenMinter;
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
  const context = await loadReviewMergeRunContext(input.pool, input.runId);
  const eventStore = input.eventStore ?? new PgEventStore(input.pool);
  const pr = parseGitHubPullRequestUrl(context.prUrl);
  const taskId = await ensureReviewTask(input.pool, context);
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
  await finalizeReviewTask(input.pool, eventStore, context, result);
  return result;
}

async function finalizeReviewTask(
  pool: RunStateClient,
  eventStore: EventStore,
  context: ReviewMergeRunContext,
  result: PollReviewForRunResult,
): Promise<void> {
  const base = {
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    taskId: result.taskId,
  };
  if (result.verdict === "approved") {
    await pool.query("UPDATE tasks SET status = 'done', outcome = 'ok', ended_at = now() WHERE task_id = $1", [
      result.taskId,
    ]);
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
    await pool.query("UPDATE tasks SET status = 'done', outcome = 'ok', ended_at = now() WHERE task_id = $1", [
      result.taskId,
    ]);
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
  await pool.query("UPDATE tasks SET status = 'running', outcome = 'pending', ended_at = NULL WHERE task_id = $1", [
    result.taskId,
  ]);
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

async function ensureReviewTask(pool: RunStateClient, context: ReviewMergeRunContext): Promise<string> {
  const existing = await pool.query(
    "SELECT task_id FROM tasks WHERE run_id = $1 AND kind = 'review' ORDER BY started_at DESC NULLS LAST, task_id ASC LIMIT 1",
    [context.runId],
  );
  const existingTask = existing.rows[0] as { task_id: string } | undefined;
  if (existingTask !== undefined) {
    await pool.query(
      "UPDATE tasks SET status = 'running', started_at = COALESCE(started_at, now()), ended_at = NULL WHERE task_id = $1",
      [existingTask.task_id],
    );
    return existingTask.task_id;
  }
  const taskId = `task_${randomUUID()}`;
  await pool.query(
    `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, started_at, agent_kind, cli, model, attempt)
     VALUES ($1, $2, (SELECT org_id FROM runs WHERE run_id = $2), 'review', 'Poll pull request review', 'running', now(), 'system', 'github', NULL, 1)`,
    [taskId, context.runId],
  );
  return taskId;
}
