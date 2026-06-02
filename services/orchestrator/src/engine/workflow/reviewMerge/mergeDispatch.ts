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
//
// P2a up-to-date enforcement: BEFORE the direct merge, the stage reads the PR
// branch's mergeability (`readMergeability`). A `behind` branch is auto-rebased
// via the server-side update-branch API (`updateBranch`) and its CI is re-polled
// to green (`reGateCi`) before merging — emitting `merge.behind` + `merge.rebased`
// for visibility. A `dirty` branch (or a 422 from update-branch) is routed to the
// conflict-resolver hook + the recoverable `merge.conflict` outcome, NOT merged.
// So a stale/conflicting branch is DETECTED and routed, not discovered as a raw
// 405/409 at merge time.

import type { MergeIntegration } from "../../config/shared.js";
import type { RunStateWriter } from "../../contracts/runStateWriter.js";
import type { SecretStore } from "../../contracts/secretStore.js";
import { ensureSystemTask, routeTaskUpdate } from "../taskWriteRouting.js";
import { type EventStore, PgEventStore } from "../../eventStore.js";
import type { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import type { MergePullRequestResult } from "../../providers/githubReviewMerge.js";
import type {
  PullRequestMergeability,
  PullRequestRef,
  RepoRef,
  UpdateBranchResult,
  VcsProvider,
} from "../../contracts/vcsProvider.js";
import {
  contextOptionsFor,
  loadReviewMergeRunContext,
  type ReviewMergeRunContext,
  type RunStateClient,
} from "./context.js";
import {
  assessExternalChange,
  decidePosture,
  tanrenIdentity,
  type ContributorProbe,
  type PostureDecision,
  type PullRequestContributors,
} from "./governancePosture.js";

/** The integration modes the merge stage actually dispatches to. */
export type DispatchedIntegration = "mergify_queue" | "direct_merge" | "external_reviewer";

/**
 * The outcome of the merge stage. `conflict` is the recoverable branch;
 * `blocked` is the P3-0023 governance-posture outcome — a strict-posture
 * external change held for operator approval, or an audit_only observed change.
 */
export type MergeOutcomeKind = "merged" | "queued" | "handed_off" | "conflict" | "failed" | "blocked";

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
  // Plane-split P3c: route the merge task INSERT/UPDATE through the control plane
  // when wired (remote-writes on); absent, the in-process org-scoped write runs.
  runStateWriter?: RunStateWriter;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  runId: string;
  githubAppMinter?: GithubAppTokenMinter;
  /** Run-resolved GitHub credential ref; see PollReviewForRunInput. */
  resolvedGithubCredentialRef?: string;
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
   * P3-0023 test seam. Resolves the PR's distinct contributor logins for
   * external-change detection. Production omits it → the dispatcher lists the
   * PR commits through the VcsProvider and derives the logins.
   */
  contributorProbe?: ContributorProbe;
  /**
   * P3-0008 conflict-resolver scaffolding. Invoked on a detected merge conflict
   * BEFORE the recoverable `merge.conflict` outcome is emitted. The default is a
   * no-op stub; a future resolver replaces it. Returning `resolved: true` lets
   * the dispatcher retry the merge once.
   */
  resolveConflict?: ConflictResolverHook;
  /**
   * P2a up-to-date enforcement: re-poll the run's CI to a terminal verdict after
   * an auto-rebase advanced the branch (the branch HEAD moved, so the prior
   * green is stale). Production wires this to `pollCiForRun` through the SAME
   * vcsProvider seam; tests inject a scripted re-gate. When omitted, the stage
   * skips the re-poll (it still emits `merge.rebased` with `reGatedCi: false`)
   * and proceeds to let the GitHub merge API gate on required checks — the merge
   * is never forced past protection.
   */
  reGateCi?: ReGateCiHook;
}

/** Injectable merge-operation probe (real GitHub by default; mocked in tests). */
export interface MergeProbe {
  applyQueueLabel(label: string): Promise<void>;
  merge(): Promise<MergePullRequestResult>;
  /** P2a: read the PR branch's up-to-date / mergeability state before merging. */
  readMergeability(): Promise<PullRequestMergeability>;
  /** P2a: bring the PR branch up to date with its base (server-side update). */
  updateBranch(): Promise<UpdateBranchResult>;
}

/**
 * P2a re-gate hook: drive the run's CI back to a terminal verdict after a
 * rebase. Returns the CI status so the stage knows whether to merge (`passed`),
 * fail (`failed`), or hold (`pending` after the budget). Production resolves
 * this to a `pollCiForRun` loop; tests inject a scripted result.
 */
export type ReGateCiHook = () => Promise<{ status: "passed" | "failed" | "pending" }>;

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
  const context = await loadReviewMergeRunContext(input.pool, input.runId, contextOptionsFor(input));
  const eventStore = input.eventStore ?? new PgEventStore(input.pool);
  const prRef = input.vcsProvider.parsePullRequest(context.prUrl);
  const pr = { repo: prRef.repo, pullNumber: prRef.number };
  const integration = dispatchedIntegrationFor(context.mergeIntegration);
  const taskId = await ensureMergeTask(input.pool, context, input.runStateWriter);
  await eventStore.append({
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    taskId,
    eventType: "task.started",
    payload: { taskKind: "merge" },
  });

  const probe = input.mergeProbe ?? (await buildGitHubProbe(input, context, pr.repo, pr.pullNumber));
  const dispatcher = new MergeDispatcher({
    input,
    context,
    eventStore,
    taskId,
    integration,
    pr,
    probe,
  });

  // P3-0023 governance posture gate. Only Tanren-initiated auto-merges
  // (direct_merge / mergify_queue) are governed: a strict-posture external
  // change blocks (operator approval required); an audit_only external change
  // is observed (no merge call). The external_reviewer / not_configured
  // hand-off is already a human-merge path — Tanren is not auto-merging, so
  // there is nothing for the posture to block and the gate is skipped.
  if (integration !== "external_reviewer") {
    const decision = await evaluatePosture(input, context, pr.repo, pr.pullNumber);
    if (decision.kind !== "proceed") {
      return dispatcher.blockByPosture(decision);
    }
  }

  if (integration === "external_reviewer") {
    return dispatcher.handOff();
  }
  if (integration === "mergify_queue") {
    return dispatcher.enqueueMergify();
  }
  return dispatcher.directMerge();
}

/**
 * Resolve the PR contributors and run the posture gate against them. The `open`
 * posture always proceeds regardless of contributors, so we skip the (paid)
 * contributor lookup entirely for it — only `strict` / `audit_only` need to
 * know whether external changes are present.
 */
async function evaluatePosture(
  input: MergeForRunInput,
  context: ReviewMergeRunContext,
  repo: RepoRef,
  pullNumber: number,
): Promise<PostureDecision> {
  if (context.governancePosture === "open") {
    return decidePosture("open", { hasExternalChange: false, externalLogins: [] });
  }
  const probe = input.contributorProbe ?? buildContributorProbe(input, context, repo, pullNumber);
  const contributors = await probe.listContributors();
  const identity = tanrenIdentity(context.tanrenLogins);
  return decidePosture(context.governancePosture, assessExternalChange(contributors, identity));
}

interface DispatcherDeps {
  input: MergeForRunInput;
  context: ReviewMergeRunContext;
  eventStore: EventStore;
  taskId: string;
  integration: DispatchedIntegration;
  pr: { repo: RepoRef; pullNumber: number };
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

  /**
   * P3-0023: a governance posture blocked the merge. Emits the typed
   * `merge.blocked` event with the posture, mode, and external logins, then
   * leaves the task `running` so the operator-approval / audit recovery surface
   * can pick it up (the block is recoverable, not a hard failure — analogous to
   * the conflict branch). No merge call is made.
   */
  async blockByPosture(decision: PostureDecision): Promise<MergeForRunResult> {
    const { eventStore, integration } = this.deps;
    const mode = decision.kind === "block" ? "operator_approval" : "audit_only";
    await eventStore.append({
      ...this.base(),
      eventType: "merge.blocked",
      payload: {
        ...this.prFields(),
        integration,
        posture: decision.posture,
        mode,
        externalLogins: [...decision.externalLogins],
        reason: decision.reason,
      },
    });
    await this.finalize("blocked", { taskOutcome: "pending", taskStatus: "running" });
    return this.result("blocked", { message: decision.reason });
  }

  /** external_reviewer / not_configured: stop at ready, emit the hand-off. */
  async handOff(): Promise<MergeForRunResult> {
    const { eventStore, integration } = this.deps;
    await eventStore.append({
      ...this.base(),
      eventType: "merge.queued",
      payload: { ...this.prFields(), integration },
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
      payload: { ...this.prFields(), integration: "mergify_queue", queueLabel: label },
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
      payload: { ...this.prFields(), integration: "direct_merge" },
    });
    // P2a up-to-date enforcement: BEFORE merging, ensure the PR branch is current
    // with its base. A stale branch is rebased + re-gated here; a real conflict is
    // routed to the resolver hook — so we never discover a 405/409 at merge time
    // and never merge broken work.
    const freshness = await this.ensureUpToDate();
    if (freshness.kind !== "proceed") {
      return freshness.result;
    }
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
        payload: { ...this.prFields(), integration: "direct_merge", mergeSha: merge.mergeSha },
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
      payload: { ...this.prFields(), integration: "direct_merge", message: merge.message },
    });
    await this.finalize("failed", {
      taskOutcome: "failed",
      taskStatus: "failed",
      failureKind: "merge_failed",
    });
    return this.result("failed", { message: merge.message });
  }

  /**
   * P2a: ensure the PR branch is up to date with its base before the merge.
   *
   *   clean / blocked / unknown → proceed (the merge API itself gates on
   *       required checks / protection; `unknown` means GitHub has not computed
   *       freshness yet, so we let the merge attempt surface it rather than
   *       blindly rebasing).
   *   dirty → a real conflict with base: route to the conflict hook + emit
   *       merge.conflict (recoverable) — NEVER merge.
   *   behind → update the branch onto base, re-poll CI to green, then proceed.
   *       If update-branch reports a conflict, route to the conflict hook. If the
   *       re-gated CI fails, fail the stage. The branch never reaches the merge
   *       call stale.
   */
  private async ensureUpToDate(): Promise<{ kind: "proceed" } | { kind: "halt"; result: MergeForRunResult }> {
    const { probe, eventStore, context } = this.deps;
    const mergeability = await probe.readMergeability();
    if (mergeability.state === "dirty") {
      return { kind: "halt", result: await this.handleBranchConflict(mergeability, "branch conflicts with base") };
    }
    if (mergeability.state !== "behind") {
      // clean / blocked / unknown: nothing to rebase here.
      return { kind: "proceed" };
    }

    await eventStore.append({
      ...this.base(),
      eventType: "merge.behind",
      payload: {
        ...this.prFields(),
        integration: "direct_merge",
        baseBranch: mergeability.baseBranch || context.baseBranch,
        headBranch: mergeability.headBranch || undefined,
        mergeableState: mergeability.state,
      },
    });

    const updated = await probe.updateBranch();
    if (updated.outcome === "conflict") {
      // The server-side update hit a real conflict — route to the resolver, do
      // NOT merge. (P2b replaces noopConflictResolver with the real resolver.)
      return { kind: "halt", result: await this.handleBranchConflict(mergeability, updated.message) };
    }
    if (updated.outcome === "up_to_date") {
      // A benign race: it became current between the read and the update.
      return { kind: "proceed" };
    }

    // The branch advanced onto base. Its prior green is now stale, so re-poll CI
    // before merging.
    const reGate = this.deps.input.reGateCi;
    const ci = reGate === undefined ? undefined : await reGate();
    await eventStore.append({
      ...this.base(),
      eventType: "merge.rebased",
      payload: {
        ...this.prFields(),
        integration: "direct_merge",
        baseBranch: mergeability.baseBranch || context.baseBranch,
        headBranch: mergeability.headBranch || undefined,
        reGatedCi: ci !== undefined,
      },
    });
    if (ci?.status === "failed") {
      await eventStore.append({
        ...this.base(),
        eventType: "merge.failed",
        payload: { ...this.prFields(), integration: "direct_merge", message: "CI failed after auto-rebase" },
      });
      await this.finalize("failed", {
        taskOutcome: "failed",
        taskStatus: "failed",
        failureKind: "merge_failed",
      });
      return { kind: "halt", result: this.result("failed", { message: "CI failed after auto-rebase" }) };
    }
    if (ci?.status === "pending") {
      // CI did not converge within the re-gate budget: hold (recoverable), do not
      // merge on an unverified rebase.
      return { kind: "halt", result: await this.emitConflict("CI did not converge after auto-rebase") };
    }
    return { kind: "proceed" };
  }

  /**
   * P2a: a behind/dirty branch surfaced a real conflict (the `dirty` state or a
   * 422 from update-branch). Route it through the SAME conflict-resolver hook as
   * a merge-time conflict; if the resolver resolves it we retry the merge once,
   * otherwise emit the recoverable merge.conflict outcome — never a raw merge.
   */
  private async handleBranchConflict(
    mergeability: PullRequestMergeability,
    message: string,
  ): Promise<MergeForRunResult> {
    const { probe } = this.deps;
    const resolution = await this.runConflictResolver(message);
    if (resolution.resolved) {
      const merge = await probe.merge();
      if (merge.merged) {
        await this.deps.eventStore.append({
          ...this.base(),
          eventType: "merge.completed",
          payload: { ...this.prFields(), integration: "direct_merge", mergeSha: merge.mergeSha },
        });
        await this.finalize("merged", { taskOutcome: "ok", taskStatus: "done" });
        return this.result("merged", { mergeSha: merge.mergeSha });
      }
    }
    return this.emitConflict(message, mergeability.headBranch || undefined);
  }

  /** Invoke the conflict-resolution hook (noop default until P2b) for a message. */
  private async runConflictResolver(message: string): Promise<{ resolved: boolean }> {
    const { input, context, pr } = this.deps;
    // arch-allow: pending P2b — noopConflictResolver is the TEMPORARY default until the
    // intent-preserving conflict resolver lands. P8a §8a.
    const resolver = input.resolveConflict ?? noopConflictResolver;
    return resolver({
      runId: context.runId,
      prUrl: context.prUrl,
      prNumber: pr.pullNumber,
      baseBranch: context.baseBranch,
      message,
    });
  }

  private async tryResolveConflict(merge: MergePullRequestResult): Promise<MergePullRequestResult | undefined> {
    const { probe } = this.deps;
    const outcome = await this.runConflictResolver(merge.message);
    return outcome.resolved ? await probe.merge() : undefined;
  }

  /** Emit the recoverable conflict outcome (the resolver-scaffolding hook). */
  private async emitConflict(message: string, headBranch?: string): Promise<MergeForRunResult> {
    const { eventStore, context } = this.deps;
    await eventStore.append({
      ...this.base(),
      eventType: "merge.conflict",
      payload: {
        ...this.prFields(),
        integration: "direct_merge",
        baseBranch: context.baseBranch,
        ...(headBranch !== undefined && { headBranch }),
        message,
      },
    });
    // A conflict is recoverable, not a hard failure: leave the task running so
    // the P2B-0008 recovery surface can pick it up.
    await this.finalize("conflict", { taskOutcome: "pending", taskStatus: "running" });
    return this.result("conflict", { message });
  }

  private async finalize(
    _outcome: MergeOutcomeKind,
    state: {
      taskOutcome: "ok" | "failed" | "pending";
      taskStatus: "done" | "failed" | "running";
      failureKind?: string;
    },
  ): Promise<void> {
    const { input, taskId, eventStore, integration } = this.deps;
    const writer = input.runStateWriter;
    if (state.taskStatus === "done") {
      await routeTaskUpdate(
        writer,
        input.pool,
        { taskId, transition: "done", outcome: "ok" },
        "UPDATE tasks SET status = 'done', outcome = $2, ended_at = now() WHERE task_id = $1",
        [taskId, "ok"],
      );
      await eventStore.append({
        ...this.base(),
        eventType: "task.completed",
        payload: { taskKind: "merge", status: integration },
      });
      return;
    }
    if (state.taskStatus === "failed") {
      const failureKind = state.failureKind ?? "merge_failed";
      await routeTaskUpdate(
        writer,
        input.pool,
        { taskId, transition: "failed_with_kind", failureKind },
        "UPDATE tasks SET status = 'failed', outcome = 'failed', failure_kind = $2, ended_at = now() WHERE task_id = $1",
        [taskId, failureKind],
      );
      await eventStore.append({
        ...this.base(),
        eventType: "task.failed",
        payload: { taskKind: "merge", failureKind },
      });
      return;
    }
    await routeTaskUpdate(
      writer,
      input.pool,
      { taskId, transition: "running_pending" },
      "UPDATE tasks SET status = 'running', outcome = 'pending', ended_at = NULL WHERE task_id = $1",
      [taskId],
    );
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
      message: extra.message,
    };
  }
}

async function buildGitHubProbe(
  input: MergeForRunInput,
  context: ReviewMergeRunContext,
  repo: RepoRef,
  pullNumber: number,
): Promise<MergeProbe> {
  const provider = input.vcsProvider;
  const resolved = await provider.resolveToken({
    secrets: input.secrets,
    installation: context.installation,
    staticRef: context.staticCredentialRef,
    minter: input.githubAppMinter,
  });
  const pr: PullRequestRef = { repo, number: pullNumber };
  return {
    applyQueueLabel: (label) => provider.applyQueueLabel(pr, label, resolved),
    merge: () => provider.mergePullRequest(pr, resolved, input.mergeMethod),
    readMergeability: () => provider.readMergeability(pr, resolved),
    updateBranch: () => provider.updateBranch(pr, resolved),
  };
}

/**
 * P3-0023 production contributor probe. Lists the PR's commits through the
 * VcsProvider and collects the distinct author + committer logins for the
 * external-change detection in the governance/review-merge decision path. Token
 * resolution is lazy — only paid when the gate actually needs contributors.
 */
function buildContributorProbe(
  input: MergeForRunInput,
  context: ReviewMergeRunContext,
  repo: RepoRef,
  pullNumber: number,
): ContributorProbe {
  const provider = input.vcsProvider;
  return {
    listContributors: async (): Promise<PullRequestContributors> => {
      const resolved = await provider.resolveToken({
        secrets: input.secrets,
        installation: context.installation,
        staticRef: context.staticCredentialRef,
        minter: input.githubAppMinter,
      });
      return provider.listContributors({ repo, number: pullNumber }, resolved);
    },
  };
}

async function ensureMergeTask(
  pool: RunStateClient,
  context: ReviewMergeRunContext,
  writer?: RunStateWriter,
): Promise<string> {
  return ensureSystemTask(pool, { runId: context.runId, kind: "merge", title: "Merge pull request" }, writer);
}
