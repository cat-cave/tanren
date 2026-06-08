// the MergeDispatcher — the per-run merge driver, split out of
// mergeDispatch.ts to keep each file under the 500-line architecture cap.
// `mergeForRun` builds the dispatcher and calls one of its mode methods
// (handOff / enqueueNative / directMerge / blockByPosture). directMerge runs
// the up-to-date enforcement (ensureUpToDate) BEFORE the merge: a behind
// branch is rebased + re-gated, a dirty/422 branch is routed to the
// conflict-resolver hook — never merged stale, never merged broken.

import { routeTaskUpdate } from "../taskWriteRouting.js";
import { serviceAuditActor, type AuditEnvelope } from "../../events/schemas/audit.js";
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
import { mergeAuthorityLive } from "../../merge/mergeAuthorityFlag.js";
import { landViaAuthority, landViaHostMerge, type LandOps } from "./mergeLandPaths.js";

export interface DispatcherDeps {
  input: MergeForRunInput;
  context: ReviewMergeRunContext;
  eventStore: EventStore;
  taskId: string;
  integration: DispatchedIntegration;
  pr: { repo: RepoRef; pullNumber: number };
  probe: MergeProbe;
  /**
   * §2c cleanup: the ephemeral integration ref to delete AFTER a
   * speculative dependent merges onto `default_branch`. Present only for a
   * speculative run whose hold cleared; absent for a normal run.
   */
  speculativeCleanup?: string;
}

export class MergeDispatcher implements LandOps {
  constructor(readonly deps: DispatcherDeps) {}

  base() {
    const { context, taskId } = this.deps;
    return { runId: context.runId, specId: context.specId, projectId: context.projectId, taskId };
  }

  prFields() {
    const { context, pr } = this.deps;
    return { prUrl: context.prUrl, prNumber: pr.pullNumber };
  }

  /**
   * AUDIT-EVIDENCE BASELINE: the audit envelope stamped onto the terminal
   * `merge.completed` event. The merge is driven by the autonomous engine, so the
   * INITIATING actor is the service. The APPROVING actor is recorded ONLY when a
   * HUMAN review tier actually gated the merge (`reviewPolicy === "human"`) — a
   * generic `human` approver, the honest "a human verdict was required and given".
   * On the autonomous tiers (`auto`/`simulated`) there is no separate approver, so
   * the field is absent (a true empty state, never a placeholder actor). The policy
   * version is the run's governance config revision.
   */
  auditEnvelope(): AuditEnvelope {
    const humanApproved = this.deps.context.reviewPolicy === "human";
    return {
      policyVersion: this.deps.context.policyVersion,
      initiatingActor: serviceAuditActor,
      ...(humanApproved ? { approvingActor: { kind: "human" as const } } : {}),
    };
  }

  /**
   * The integration label the directMerge path stamps on its events. `direct_merge`
   * for the immediate-merge mode; `native_queue` when the coordinator DRIVES the
   * SAME path for a queued head — so the events read `native_queue` without a
   * second merge implementation. Only these two modes reach directMerge.
   */
  mergeLabel(): "direct_merge" | "native_queue" {
    return this.deps.integration === "native_queue" ? "native_queue" : "direct_merge";
  }

  /**
   * a governance posture blocked the merge. Emits the typed
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

  /**
   * native_queue, first pass: ENTER the run into Tanren's native merge queue
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

  /**
   * direct_merge / native_queue DRIVE: drive the land through `MergeAuthority` (§5)
   * — the SOLE merge decision. The up-to-date enforcement below (rebase a `behind`
   * branch, route a `dirty` branch to the conflict resolver) is a WORKSPACE
   * operation, not the merge decision: it brings the branch to a `clean` mergeability
   * the authority then authorizes. The decision itself — gate + findings/posture +
   * review + mergeability + budget + demo + HITL + conflicts — is the fail-closed
   * truth table, and the host land is `CodeHost.landAuthorizedRef` (the ff-only CAS),
   * NOT the host's "merge PR" API.
   */
  async directMerge(): Promise<MergeForRunResult> {
    const { eventStore } = this.deps;
    await eventStore.append({
      ...this.base(),
      eventType: "merge.queued",
      payload: { ...this.prFields(), integration: this.mergeLabel() },
    });
    // up-to-date enforcement: BEFORE the land decision, ensure the PR branch is
    // current with its base. A stale branch is rebased + re-gated here; a real
    // conflict is routed to the resolver hook — so the branch reaches the authority
    // with a settled mergeability, never stale/broken work.
    const freshness = await this.ensureUpToDate();
    if (freshness.kind !== "proceed") {
      return freshness.result;
    }
    return this.driveLand();
  }

  /**
   * The §5 LAND DECISION — the SINGLE point every land flows through (the initial
   * direct_merge/DRIVE pass AND the post-conflict-resolution retry). With
   * `MERGE_AUTHORITY_LIVE` on (the default) the land is authorized + transactional via
   * `MergeAuthority` (`landViaAuthority` re-reads mergeability + the bundle re-gathers
   * the land-time inputs, so a freshly-resolved conflict is judged on CURRENT state,
   * fail-closed). With the flag OFF (or no bundle) the retained host-merge break-glass
   * runs. There is NO second merge authority — the conflict-resolved path re-enters
   * HERE, never `probe.merge()` + a hand-rolled `merge.completed`.
   */
  private async driveLand(): Promise<MergeForRunResult> {
    // The bundle is pre-supplied (a test/out-of-band caller) OR built lazily HERE —
    // only now that the branch is settled, so a conflict-out path never paid for it.
    const { input } = this.deps;
    if (mergeAuthorityLive()) {
      const bundle = input.mergeAuthority ?? (await input.buildMergeAuthority?.());
      if (bundle !== undefined) {
        return landViaAuthority(this.deps, this, bundle);
      }
    }
    // KILL-SWITCH (MERGE_AUTHORITY_LIVE=0, or no bundle): the retained break-glass
    // host-merge path. NOT the merge authority — kept only to revert the cutover.
    return landViaHostMerge(this.deps, this);
  }

  /**
   * §2c cleanup: delete the ephemeral integration ref after a speculative
   * dependent merged onto `default_branch`. No-op for a normal run (no cleanup
   * ref). Best-effort: a delete failure is logged + swallowed — the merge already
   * landed, so cleanup must never turn a successful merge into a failure. Emits
   * `merge.integration_cleaned` on success for the audit trail.
   */
  async cleanupIntegrationBranch(): Promise<void> {
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
   * Bring the PR branch up to date with its base (a WORKSPACE step that precedes the
   * land decision — it does NOT decide whether to merge; `MergeAuthority` does).
   *
   *   dirty → a real conflict with base: route to the conflict hook + emit
   *       merge.conflict (recoverable) — the resolver engages; never merged.
   *   behind → update the branch onto base, re-poll CI to green, then continue.
   *       If update-branch reports a conflict, route to the conflict hook. If the
   *       re-gated CI fails, fail the stage. The branch never reaches the authority stale.
   *   clean / blocked / unknown → no workspace action. Note: this is NOT a
   *       fail-open "proceed to merge" (the §5-P0 ensureUpToDate hole) — it only
   *       means "nothing to rebase". The AUTHORITY then BLOCKS on `blocked`/`unknown`
   *       mergeability (only `clean` clears), so an uncertain mergeability can never
   *       reach a land. The decision moved to the guaranteed truth table.
   */
  private async ensureUpToDate(): Promise<{ kind: "proceed" } | { kind: "halt"; result: MergeForRunResult }> {
    const { probe, eventStore, context } = this.deps;
    const mergeability = await probe.readMergeability();
    if (mergeability.state === "dirty") {
      return { kind: "halt", result: await this.handleBranchConflict(mergeability, "branch conflicts with base") };
    }
    if (mergeability.state !== "behind") {
      // clean / blocked / unknown: nothing to rebase. The authority decides the land
      // (it blocks on blocked/unknown) — this is no longer a merge-proceed decision.
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

    // The branch advanced onto base. Its prior green is now stale, so the CI MUST
    // be re-verified before merging. Post-rebase re-gating is REQUIRED, not
    // optional: if the re-gate hook is absent we have no way to confirm the rebased
    // branch is green, so we HARD-HOLD (emit the recoverable conflict outcome, do
    // NOT merge) rather than laundering an unverified rebase into a merge. This
    // mirrors how directMerge already throws loudly when its enqueue hook is
    // missing — a missing required hook is a hold, never "merge anyway".
    const reGate = this.deps.input.reGateCi;
    if (reGate === undefined) {
      await eventStore.append({
        ...this.base(),
        eventType: "merge.rebased",
        payload: {
          ...this.prFields(),
          integration: this.mergeLabel(),
          baseBranch: mergeability.baseBranch || context.baseBranch,
          headBranch: mergeability.headBranch || undefined,
          reGatedCi: false,
        },
      });
      return {
        kind: "halt",
        result: await this.emitConflict("post-rebase CI re-gate hook is absent; cannot verify rebased branch"),
      };
    }
    const ci = await reGate();
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
   * a behind/dirty branch surfaced a real conflict (the `dirty` state or a
   * 422 from update-branch). Route it through the SAME conflict-resolver hook as
   * a merge-time conflict; if the resolver resolves it the land RE-ENTERS the
   * §5 land decision (`driveLand` → the SAME `MergeAuthority` path as every other
   * merge), NOT a raw `probe.merge()`. The resolution may have changed the
   * gate/mergeability/conflict state, so `driveLand` re-reads them fail-closed: a
   * conflict that resolves `true` but whose land-time authority state is BLOCKING
   * (stale gate, changes_requested review, over-budget, unverified demo, unknown
   * mergeability) is BLOCKED, not merged — there is no second merge authority. An
   * unresolved conflict emits the recoverable merge.conflict outcome.
   */
  private async handleBranchConflict(
    mergeability: PullRequestMergeability,
    message: string,
  ): Promise<MergeForRunResult> {
    const resolution = await this.runConflictResolver(message);
    if (resolution.resolved) {
      // Re-enter the authority-gated, transactional land — never `probe.merge()` +
      // a hand-rolled `merge.completed`. The §5 finalizer records merge.completed in
      // ONE transaction (merge_state_unknown on a post-land durable-write failure).
      return this.driveLand();
    }
    return this.emitConflict(message, mergeability.headBranch || undefined);
  }

  /**
   * Invoke the intent-preserving conflict-resolution hook. The hook is a
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

  /**
   * The KILL-SWITCH conflict retry: a merge-time conflict on the LEGACY host-merge
   * path. NOT a live-default land path — `tryResolveConflict` is called ONLY by
   * `landViaHostMerge`, which `driveLand` reaches ONLY when `MERGE_AUTHORITY_LIVE` is
   * OFF (or no authority bundle). With the flag ON (the default) the land flows through
   * `landViaAuthority` and this `probe.merge()` is unreachable. So the `probe.merge()`
   * here is the flag-OFF break-glass retry, not a second merge authority that bypasses
   * the §5 truth table. (The DEFAULT-path conflict-resolved land is authority-gated +
   * transactional via `handleBranchConflict` → `driveLand`.)
   */
  async tryResolveConflict(merge: MergePullRequestResult): Promise<MergePullRequestResult | undefined> {
    const { probe } = this.deps;
    const outcome = await this.runConflictResolver(merge.message);
    return outcome.resolved ? await probe.merge() : undefined;
  }

  /** Emit the recoverable conflict outcome (the resolver-scaffolding hook). */
  async emitConflict(message: string, headBranch?: string): Promise<MergeForRunResult> {
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
    // the recovery surface can pick it up.
    await this.finalize("conflict", { taskOutcome: "pending", taskStatus: "running" });
    return this.result("conflict", { message });
  }

  async finalize(
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

  result(outcome: MergeOutcomeKind, extra: { mergeSha?: string; message?: string } = {}): MergeForRunResult {
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
