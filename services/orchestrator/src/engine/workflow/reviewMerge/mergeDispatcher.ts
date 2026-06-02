// P2a: the MergeDispatcher — the per-run merge driver, split out of
// mergeDispatch.ts to keep each file under the 500-line architecture cap.
// `mergeForRun` builds the dispatcher and calls one of its mode methods
// (handOff / enqueueMergify / directMerge / blockByPosture). directMerge runs
// the P2a up-to-date enforcement (ensureUpToDate) BEFORE the merge: a behind
// branch is rebased + re-gated, a dirty/422 branch is routed to the
// conflict-resolver hook — never merged stale, never merged broken.

import { routeTaskUpdate } from "../taskWriteRouting.js";
import type { EventStore } from "../../eventStore.js";
import type { MergePullRequestResult } from "../../providers/githubReviewMerge.js";
import type { PullRequestMergeability, RepoRef } from "../../contracts/vcsProvider.js";
import type { ReviewMergeRunContext } from "./context.js";
import type { PostureDecision } from "./governancePosture.js";
import {
  type DispatchedIntegration,
  type MergeForRunInput,
  type MergeForRunResult,
  type MergeOutcomeKind,
  type MergeProbe,
} from "./mergeDispatchTypes.js";

export interface DispatcherDeps {
  input: MergeForRunInput;
  context: ReviewMergeRunContext;
  eventStore: EventStore;
  taskId: string;
  integration: DispatchedIntegration;
  pr: { repo: RepoRef; pullNumber: number };
  probe: MergeProbe;
  /**
   * P2c-1 (§2c cleanup): the ephemeral integration ref to delete AFTER a
   * speculative dependent merges onto `default_branch`. Present only for a
   * speculative run whose hold cleared; absent for a normal run.
   */
  speculativeCleanup?: string;
}

export class MergeDispatcher {
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
   * The integration label the directMerge path stamps on its events. `direct_merge`
   * for the immediate-merge mode; `native_queue` when the coordinator DRIVES the
   * SAME path for a queued head (P2d) — so the events read `native_queue` without a
   * second merge implementation. Only these two modes reach directMerge.
   */
  private mergeLabel(): "direct_merge" | "native_queue" {
    return this.deps.integration === "native_queue" ? "native_queue" : "direct_merge";
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

  /**
   * P2d (native_queue, first pass): ENTER the run into Tanren's native merge queue
   * instead of merging now. Persists the queue entry (idempotent — a re-pass does
   * not double-queue), emits merge.queued exactly once (on creation), and finalizes
   * the run as `queued` (done) so the run loop returns + frees its slot. The native
   * MergeCoordinator later selects this entry in DAG order and DRIVES the actual
   * merge (a second mergeForRun with `queueDrive: true` → directMerge). A run
   * already queued/merging is not re-queued (no double-queue, no double-merge).
   */
  async enqueueNative(): Promise<MergeForRunResult> {
    const { eventStore, input, context, pr } = this.deps;
    const enqueue = input.enqueueNativeQueue;
    if (enqueue === undefined) {
      throw new Error("native_queue merge requires an enqueueNativeQueue hook (the MergeQueueModel-backed enqueuer)");
    }
    const { created } = await enqueue({
      projectId: context.projectId,
      runId: context.runId,
      specId: context.specId,
      prUrl: context.prUrl,
      prNumber: pr.pullNumber,
    });
    if (created) {
      await eventStore.append({
        ...this.base(),
        eventType: "merge.queued",
        payload: { ...this.prFields(), integration: "native_queue" },
      });
    }
    await this.finalize("queued", { taskOutcome: "ok", taskStatus: "done" });
    return this.result("queued", { message: created ? "entered native merge queue" : "already in native merge queue" });
  }

  /** direct_merge: GitHub merge, with a single conflict-resolver retry. */
  async directMerge(): Promise<MergeForRunResult> {
    const { eventStore, probe } = this.deps;
    await eventStore.append({
      ...this.base(),
      eventType: "merge.queued",
      payload: { ...this.prFields(), integration: this.mergeLabel() },
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
        payload: { ...this.prFields(), integration: this.mergeLabel(), mergeSha: merge.mergeSha },
      });
      // P2c-1 (§2c cleanup): the dependent merged onto `default_branch`; delete its
      // ephemeral integration ref. Best-effort — a cleanup failure never undoes the
      // merge (the merge already landed), so it is logged and swallowed.
      await this.cleanupIntegrationBranch();
      await this.finalize("merged", { taskOutcome: "ok", taskStatus: "done" });
      return this.result("merged", { mergeSha: merge.mergeSha });
    }
    if (merge.conflict) {
      return this.emitConflict(merge.message);
    }
    await eventStore.append({
      ...this.base(),
      eventType: "merge.failed",
      payload: { ...this.prFields(), integration: this.mergeLabel(), message: merge.message },
    });
    await this.finalize("failed", {
      taskOutcome: "failed",
      taskStatus: "failed",
      failureKind: "merge_failed",
    });
    return this.result("failed", { message: merge.message });
  }

  /**
   * P2c-1 (§2c cleanup): delete the ephemeral integration ref after a speculative
   * dependent merged onto `default_branch`. No-op for a normal run (no cleanup
   * ref). Best-effort: a delete failure is logged + swallowed — the merge already
   * landed, so cleanup must never turn a successful merge into a failure. Emits
   * `merge.integration_cleaned` on success for the audit trail.
   */
  private async cleanupIntegrationBranch(): Promise<void> {
    const { speculativeCleanup, probe, eventStore, integration } = this.deps;
    if (speculativeCleanup === undefined) {
      return;
    }
    try {
      await probe.deleteIntegrationBranch(speculativeCleanup);
      await eventStore.append({
        ...this.base(),
        eventType: "merge.integration_cleaned",
        payload: { ...this.prFields(), integration, integrationBranch: speculativeCleanup },
      });
    } catch (error) {
      console.warn(
        `[merge] integration-ref cleanup of ${speculativeCleanup} failed (merge already landed, ignoring):`,
        error,
      );
    }
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
        integration: this.mergeLabel(),
        baseBranch: mergeability.baseBranch || context.baseBranch,
        headBranch: mergeability.headBranch || undefined,
        mergeableState: mergeability.state,
      },
    });

    const updated = await probe.updateBranch();
    if (updated.outcome === "conflict") {
      // The server-side update hit a real conflict — route to the intent-
      // preserving resolver, do NOT merge.
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
        integration: this.mergeLabel(),
        baseBranch: mergeability.baseBranch || context.baseBranch,
        headBranch: mergeability.headBranch || undefined,
        reGatedCi: ci !== undefined,
      },
    });
    if (ci?.status === "failed") {
      await eventStore.append({
        ...this.base(),
        eventType: "merge.failed",
        payload: { ...this.prFields(), integration: this.mergeLabel(), message: "CI failed after auto-rebase" },
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
          payload: { ...this.prFields(), integration: this.mergeLabel(), mergeSha: merge.mergeSha },
        });
        await this.finalize("merged", { taskOutcome: "ok", taskStatus: "done" });
        return this.result("merged", { mergeSha: merge.mergeSha });
      }
    }
    return this.emitConflict(message, mergeability.headBranch || undefined);
  }

  /**
   * Invoke the intent-preserving conflict-resolution hook (P2b). The hook is a
   * REQUIRED merge-stage input — production wires the real
   * `intentPreservingConflictResolver` (built from the run's merge-stage
   * context), tests inject a fake under tests/. There is no noop default: a
   * conflict is always routed to a real resolver that preserves both intents +
   * re-gates, never silently dropped.
   */
  private async runConflictResolver(message: string): Promise<{ resolved: boolean }> {
    const { input, context, pr } = this.deps;
    return input.resolveConflict({
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
        integration: this.mergeLabel(),
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
