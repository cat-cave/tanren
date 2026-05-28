// P3-0008: the merge stage. Runs after the review stage returns `approved`.
// Dispatches to one of the per-repo MergeIntegration modes selected from the
// project config:
//
//   direct_merge      → GitHub merge API (PUT /pulls/:n/merge)
//   mergify_queue     → apply the configured label; Mergify enqueues + merges
//   external_reviewer → stop at ready-for-review; emit a hand-off and let a
//                       human merge (no merge call is made here)
//   not_configured    → treated as an external_reviewer hand-off (safe default;
//                       never auto-merge a repo that has not opted in)
//
// A direct merge that GitHub reports as non-mergeable (405/409) is surfaced as
// `merge.conflict` + a typed recoverable outcome — the hook the future
// conflict-resolver attaches to. Required checks are never bypassed: a
// branch-protected PR returns 405 and is reported as not-merged, not forced.

import { randomUUID } from "node:crypto";
import type { MergeIntegration } from "../../config/shared.js";
import type { SecretStore } from "../../contracts/secretStore.js";
import { resolveGithubToken } from "../../credentials/githubTokenResolver.js";
import { type EventStore, PgEventStore } from "../../eventStore.js";
import type { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import { parseGitHubPullRequestUrl, type GitHubHttpClient } from "../../providers/github.js";
import { GitHubReviewMergeService, type MergePullRequestResult } from "../../providers/githubReviewMerge.js";
import { loadReviewMergeRunContext, type ReviewMergeRunContext, type RunStateClient } from "./context.js";

/** The integration modes the merge stage actually dispatches to. */
export type DispatchedIntegration = "mergify_queue" | "direct_merge" | "external_reviewer";

/** The outcome of the merge stage; `conflict` is the recoverable branch. */
export type MergeOutcomeKind = "merged" | "queued" | "handed_off" | "conflict" | "failed";

export interface MergeForRunResult {
  runId: string;
  taskId: string;
  integration: DispatchedIntegration;
  outcome: MergeOutcomeKind;
  prUrl: string;
  prNumber: number;
  mergeSha?: string;
  message?: string;
}

export interface MergeForRunInput {
  pool: RunStateClient;
  eventStore?: EventStore;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  runId: string;
  githubAppMinter?: GithubAppTokenMinter;
  /** Label applied for the mergify_queue path; defaults to `tanren:merge`. */
  mergifyQueueLabel?: string;
  /** GitHub merge method for direct_merge; defaults to `squash`. */
  mergeMethod?: "merge" | "squash" | "rebase";
  /**
   * Test seam. When provided, the stage uses this instead of GitHub for the
   * label/merge operations. Production omits it → the real
   * GitHubReviewMergeService drives both through the resolved token.
   */
  mergeProbe?: MergeProbe;
  /**
   * P3-0008 conflict-resolver scaffolding. Invoked on a detected merge conflict
   * BEFORE the recoverable `merge.conflict` outcome is emitted. The default is a
   * no-op stub; a future resolver replaces it. Returning `resolved: true` lets
   * the dispatcher retry the merge once.
   */
  resolveConflict?: ConflictResolverHook;
}

/** Injectable merge-operation probe (real GitHub by default; mocked in tests). */
export interface MergeProbe {
  applyQueueLabel(label: string): Promise<void>;
  merge(): Promise<MergePullRequestResult>;
}

export interface ConflictContext {
  runId: string;
  prUrl: string;
  prNumber: number;
  baseBranch: string;
  message: string;
}

export type ConflictResolverHook = (context: ConflictContext) => Promise<{ resolved: boolean }>;

/** The default conflict-resolver stub: records nothing, resolves nothing. */
export const noopConflictResolver: ConflictResolverHook = async () => ({ resolved: false });

/** Map the configured integration to the mode the stage dispatches to. */
export function dispatchedIntegrationFor(mode: MergeIntegration): DispatchedIntegration {
  if (mode === "direct_merge" || mode === "mergify_queue" || mode === "external_reviewer") {
    return mode;
  }
  // not_configured → never auto-merge; hand off to a human.
  return "external_reviewer";
}

export async function mergeForRun(input: MergeForRunInput): Promise<MergeForRunResult> {
  const context = await loadReviewMergeRunContext(input.pool, input.runId);
  const eventStore = input.eventStore ?? new PgEventStore(input.pool);
  const pr = parseGitHubPullRequestUrl(context.prUrl);
  const integration = dispatchedIntegrationFor(context.mergeIntegration);
  const taskId = await ensureMergeTask(input.pool, context);
  await eventStore.append({
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    taskId,
    eventType: "task.started",
    payload: { taskKind: "merge" }
  });

  const probe = input.mergeProbe ?? (await buildGitHubProbe(input, context, pr.repo, pr.pullNumber));
  const dispatcher = new MergeDispatcher({ input, context, eventStore, taskId, integration, pr, probe });

  if (integration === "external_reviewer") {
    return dispatcher.handOff();
  }
  if (integration === "mergify_queue") {
    return dispatcher.enqueueMergify();
  }
  return dispatcher.directMerge();
}

interface DispatcherDeps {
  input: MergeForRunInput;
  context: ReviewMergeRunContext;
  eventStore: EventStore;
  taskId: string;
  integration: DispatchedIntegration;
  pr: ReturnType<typeof parseGitHubPullRequestUrl>;
  probe: MergeProbe;
}

class MergeDispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  private base() {
    const { context, taskId } = this.deps;
    return { runId: context.runId, specId: context.specId, projectId: context.projectId, taskId };
  }

  private prFields() {
    const { context, pr } = this.deps;
    return { prUrl: context.prUrl, prNumber: pr.pullNumber };
  }

  /** external_reviewer / not_configured: stop at ready, emit the hand-off. */
  async handOff(): Promise<MergeForRunResult> {
    const { eventStore, integration } = this.deps;
    await eventStore.append({
      ...this.base(),
      eventType: "merge.queued",
      payload: { ...this.prFields(), integration }
    });
    await this.finalize("handed_off", { taskOutcome: "ok", taskStatus: "done" });
    return this.result("handed_off");
  }

  /** mergify_queue: apply the label, then mark the stage handed-off to Mergify. */
  async enqueueMergify(): Promise<MergeForRunResult> {
    const { eventStore, probe, input } = this.deps;
    const label = input.mergifyQueueLabel ?? "tanren:merge";
    await probe.applyQueueLabel(label);
    await eventStore.append({
      ...this.base(),
      eventType: "merge.queued",
      payload: { ...this.prFields(), integration: "mergify_queue", queueLabel: label }
    });
    await this.finalize("queued", { taskOutcome: "ok", taskStatus: "done" });
    return this.result("queued", { message: `enqueued with label ${label}` });
  }

  /** direct_merge: GitHub merge, with a single conflict-resolver retry. */
  async directMerge(): Promise<MergeForRunResult> {
    const { eventStore, probe } = this.deps;
    await eventStore.append({
      ...this.base(),
      eventType: "merge.queued",
      payload: { ...this.prFields(), integration: "direct_merge" }
    });
    let merge = await probe.merge();
    if (!merge.merged && merge.conflict) {
      const retried = await this.tryResolveConflict(merge);
      if (retried !== undefined) {
        merge = retried;
      }
    }
    if (merge.merged) {
      await eventStore.append({
        ...this.base(),
        eventType: "merge.completed",
        payload: { ...this.prFields(), integration: "direct_merge", mergeSha: merge.mergeSha }
      });
      await this.finalize("merged", { taskOutcome: "ok", taskStatus: "done" });
      return this.result("merged", { mergeSha: merge.mergeSha });
    }
    if (merge.conflict) {
      return this.emitConflict(merge.message);
    }
    await eventStore.append({
      ...this.base(),
      eventType: "merge.failed",
      payload: { ...this.prFields(), integration: "direct_merge", message: merge.message }
    });
    await this.finalize("failed", { taskOutcome: "failed", taskStatus: "failed", failureKind: "merge_failed" });
    return this.result("failed", { message: merge.message });
  }

  private async tryResolveConflict(merge: MergePullRequestResult): Promise<MergePullRequestResult | undefined> {
    const { input, context, pr, probe } = this.deps;
    const resolver = input.resolveConflict ?? noopConflictResolver;
    const outcome = await resolver({
      runId: context.runId,
      prUrl: context.prUrl,
      prNumber: pr.pullNumber,
      baseBranch: context.baseBranch,
      message: merge.message
    });
    return outcome.resolved ? await probe.merge() : undefined;
  }

  /** Emit the recoverable conflict outcome (the resolver-scaffolding hook). */
  private async emitConflict(message: string): Promise<MergeForRunResult> {
    const { eventStore, context } = this.deps;
    await eventStore.append({
      ...this.base(),
      eventType: "merge.conflict",
      payload: { ...this.prFields(), integration: "direct_merge", baseBranch: context.baseBranch, message }
    });
    // A conflict is recoverable, not a hard failure: leave the task running so
    // the P2B-0008 recovery surface can pick it up.
    await this.finalize("conflict", { taskOutcome: "pending", taskStatus: "running" });
    return this.result("conflict", { message });
  }

  private async finalize(
    _outcome: MergeOutcomeKind,
    state: { taskOutcome: "ok" | "failed" | "pending"; taskStatus: "done" | "failed" | "running"; failureKind?: string }
  ): Promise<void> {
    const { input, taskId, eventStore, integration } = this.deps;
    if (state.taskStatus === "done") {
      await input.pool.query("UPDATE tasks SET status = 'done', outcome = $2, ended_at = now() WHERE task_id = $1", [taskId, "ok"]);
      await eventStore.append({ ...this.base(), eventType: "task.completed", payload: { taskKind: "merge", status: integration } });
      return;
    }
    if (state.taskStatus === "failed") {
      await input.pool.query(
        "UPDATE tasks SET status = 'failed', outcome = 'failed', failure_kind = $2, ended_at = now() WHERE task_id = $1",
        [taskId, state.failureKind ?? "merge_failed"]
      );
      await eventStore.append({
        ...this.base(),
        eventType: "task.failed",
        payload: { taskKind: "merge", failureKind: state.failureKind ?? "merge_failed" }
      });
      return;
    }
    await input.pool.query("UPDATE tasks SET status = 'running', outcome = 'pending', ended_at = NULL WHERE task_id = $1", [taskId]);
  }

  private result(outcome: MergeOutcomeKind, extra: { mergeSha?: string; message?: string } = {}): MergeForRunResult {
    const { context, taskId, integration, pr } = this.deps;
    return {
      runId: context.runId,
      taskId,
      integration,
      outcome,
      prUrl: context.prUrl,
      prNumber: pr.pullNumber,
      mergeSha: extra.mergeSha,
      message: extra.message
    };
  }
}

async function buildGitHubProbe(
  input: MergeForRunInput,
  context: ReviewMergeRunContext,
  repo: ReturnType<typeof parseGitHubPullRequestUrl>["repo"],
  pullNumber: number
): Promise<MergeProbe> {
  const resolved = await resolveGithubToken({
    secrets: input.secrets,
    installation: context.installation,
    staticRef: context.staticCredentialRef,
    minter: input.githubAppMinter
  });
  const service = new GitHubReviewMergeService(input.githubHttp);
  return {
    applyQueueLabel: (label) =>
      service.applyQueueLabel({ repo, pullNumber, label, token: resolved.token, refreshToken: resolved.refresh }),
    merge: () =>
      service.mergePullRequest({
        repo,
        pullNumber,
        mergeMethod: input.mergeMethod,
        token: resolved.token,
        refreshToken: resolved.refresh
      })
  };
}

async function ensureMergeTask(pool: RunStateClient, context: ReviewMergeRunContext): Promise<string> {
  const existing = await pool.query(
    "SELECT task_id FROM tasks WHERE run_id = $1 AND kind = 'merge' ORDER BY started_at DESC NULLS LAST, task_id ASC LIMIT 1",
    [context.runId]
  );
  const existingTask = existing.rows[0] as { task_id: string } | undefined;
  if (existingTask !== undefined) {
    await pool.query("UPDATE tasks SET status = 'running', started_at = COALESCE(started_at, now()), ended_at = NULL WHERE task_id = $1", [
      existingTask.task_id
    ]);
    return existingTask.task_id;
  }
  const taskId = `task_${randomUUID()}`;
  await pool.query(
    `INSERT INTO tasks (task_id, run_id, kind, title, status, started_at, agent_kind, cli, model, attempt)
     VALUES ($1, $2, 'merge', 'Merge pull request', 'running', now(), 'system', 'github', NULL, 1)`,
    [taskId, context.runId]
  );
  return taskId;
}
