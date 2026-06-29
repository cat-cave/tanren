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
import {
  completeHeldMergeTask,
  finalizeDirectSplitDone,
  finalizeDirectSplitFailed,
} from "./mergeTaskTerminalFallback.js";

// Re-export so `mergeDispatch.ts` reaches the speculative-hold helper through the
// dispatcher import (keeping mergeDispatch.ts's file-dependency count under the lint cap).
export { completeHeldMergeTask };
import type { PullRequestMergeability, RepoRef } from "../../contracts/codeHostTypes.js";
import type { ReviewMergeRunContext } from "./context.js";
import type { PostureDecision } from "./governancePosture.js";
import {
  type DispatchedIntegration,
  type MergeForRunInput,
  type MergeForRunResult,
  type MergeOutcomeKind,
  type MergeProbe,
} from "./mergeDispatchTypes.js";
import { landViaAuthority, rebaseBehindBranch, reGateResolvedTree, type LandOps } from "./mergeLandPaths.js";
import { markMergeTaskDoneWithEvent, markMergeTaskFailedWithEvent } from "./mergeTaskTerminal.js";

export interface DispatcherDeps {
  input: MergeForRunInput;
  context: ReviewMergeRunContext;
  eventStore: EventStore;
  taskId: string;
  integration: DispatchedIntegration;
  pr: { repo: RepoRef; pullNumber: number };
  probe: MergeProbe;
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
   * The integration label the directMerge path stamps on its events. `direct_merge` for the
   * immediate-merge mode; `native_queue` when the coordinator DRIVES the SAME path for a queued
   * head — so the events read `native_queue` without a second merge impl. Only these reach here.
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
   * direct_merge / native_queue DRIVE: drive the land through `MergeAuthority` (§5) —
   * the SOLE merge decision. The up-to-date enforcement below (rebase a `behind` branch
   * via the §7 base-shift handler, route a `dirty` branch to the resolver) is a WORKSPACE
   * step, not the decision: it brings the branch to a `clean` mergeability the authority
   * then authorizes (gate + findings/posture + review + mergeability + budget + demo +
   * HITL + conflicts — the fail-closed truth table; the host land is the ff-only CAS).
   */
  async directMerge(): Promise<MergeForRunResult> {
    const { eventStore } = this.deps;
    await eventStore.append({
      ...this.base(),
      eventType: "merge.queued",
      payload: { ...this.prFields(), integration: this.mergeLabel() },
    });
    // up-to-date enforcement BEFORE the land decision: a stale branch is rebased +
    // re-gated; a real conflict routes to the resolver — never stale/broken work lands.
    const freshness = await this.ensureUpToDate();
    if (freshness.kind !== "proceed") {
      return freshness.result;
    }
    return this.driveLand();
  }

  /**
   * The §5 LAND DECISION — the SINGLE point every land flows through (initial pass AND
   * post-conflict-resolution retry). The land is ALWAYS authorized via `MergeAuthority`
   * (the sole, unconditional merge authority): there is NO host-merge path. A MISSING
   * bundle is a FAIL-CLOSED BLOCK (loud, recoverable) — the land is never silently
   * fulfilled by anything other than the guaranteed truth table.
   */
  private async driveLand(): Promise<MergeForRunResult> {
    const { input } = this.deps;
    // The bundle is pre-supplied (a test/out-of-band caller) OR built HERE — only now
    // that the branch is settled, so a conflict-out path never paid for it.
    const bundle = input.mergeAuthority ?? (await input.buildMergeAuthority?.());
    if (bundle === undefined) {
      // FAIL-CLOSED: no authority bundle is available — the land CANNOT be authorized.
      // Hold loudly (recoverable); there is NO fall-through that lands without the
      // guaranteed truth table.
      return this.emitConflict(
        "no merge-authority bundle available — land blocked (the authority is the sole, unconditional land path)",
      );
    }
    return landViaAuthority(this.deps, this, bundle);
  }

  /**
   * Bring the PR branch up to date with its base (a WORKSPACE step that precedes the
   * land decision — it does NOT decide whether to merge; `MergeAuthority` does).
   *   dirty → route to the conflict hook (recoverable); never merged.
   *   behind → rebase via the ONE base-shift handler (§7), re-gate, then continue.
   *   clean / blocked / unknown → no workspace action (NOT a fail-open proceed — the
   *       authority BLOCKS on blocked/unknown; only `clean` clears).
   */
  private async ensureUpToDate(): Promise<{ kind: "proceed" } | { kind: "halt"; result: MergeForRunResult }> {
    const { probe, eventStore, context } = this.deps;
    // §5h: freshness is now a `CodeHost`-derived ANCESTRY signal (`clean`/`behind`/`unknown`),
    // NOT the GitHub `mergeable_state` read. It NEVER reports `dirty`: a `behind` branch routes
    // through the unified `baseShiftRebase` (jj), which surfaces a genuine conflict itself.
    const mergeability = await probe.readFreshness();
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

    // THE ONE BASE-SHIFT HANDLER (§7): the `behind` rebase routes through the unified
    // `BaseShiftCoordinator.rebaseOnto` hook (the SAME path change-percolation uses), not
    // a second server-side update-branch. A `held` is a fail-closed recoverable conflict.
    const updated = await rebaseBehindBranch(this.deps, mergeability);
    if (updated.outcome === "conflict") {
      // A real conflict — route to the intent-preserving resolver, do NOT merge.
      const msg = updated.message ?? "branch conflicts with base";
      return { kind: "halt", result: await this.handleBranchConflict(mergeability, msg) };
    }
    if (updated.outcome === "held") {
      // Fail-closed: the rebase could not settle — hold (recoverable), never merge.
      const msg = updated.message ?? "base-shift rebase held";
      return { kind: "halt", result: await this.emitConflict(msg, mergeability.headBranch || undefined) };
    }
    if (updated.outcome === "up_to_date") {
      // A benign race: it became current between the read and the update.
      return { kind: "proceed" };
    }

    // The branch advanced onto base — its prior green is now stale, so the CI MUST be
    // re-verified before merging. Post-rebase re-gating is REQUIRED: an absent re-gate
    // hook HARD-HOLDS (the recoverable conflict outcome), never laundering an unverified
    // rebase into a merge.
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
    // COMMIT-BINDING (§5): bind the re-gate verdict to the EXACT rebased PR head so
    // `gatedHeadSha === landedHeadSha` holds for the behind path (absent ⇒ workspace HEAD).
    const ci = await reGate(updated.rebasedHeadSha === undefined ? {} : { rebasedHeadSha: updated.rebasedHeadSha });
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
      // A GATE-tier FAILURE on a CLEANLY-rebased branch (#594 extended to the auto-rebase
      // path the in-loop/base-shift fix missed): the rebase succeeded — the code just fails
      // lint/test/build on the new base, which the WRITER can fix. Route to writer rework
      // carrying the gate error as steering (never-discard re-author), then leave the entry
      // RECOVERABLE so the reworked spec re-enters the queue — NEVER a terminal `merge.failed`
      // halt (the old behavior stranded a fixable spec). Escalation on a genuine dead-end is
      // owned by the convergence detector inside the router (a fixed point, no count).
      return { kind: "halt", result: await this.handlePostRebaseGateFail(ci.gateError) };
    }
    if (ci?.status === "pending") {
      // The native re-gate is not yet TERMINAL (still running / infra blip), NOT non-convergence:
      // emit the recoverable, re-drivable `re_gate_pending` hold (see `emitReGatePending`).
      return {
        kind: "halt",
        result: await this.emitReGatePending("native re-gate not yet terminal after auto-rebase"),
      };
    }
    return { kind: "proceed" };
  }

  /**
   * A re-gate FAILED a GATE tier on a cleanly-rebased/advanced branch. Route the spec to WRITER
   * REWORK with the gate error as steering (the #594 never-discard re-author), then emit the
   * RECOVERABLE `conflict` outcome so the entry leaves its slot WHILE the reworked spec re-runs
   * and re-enters the queue — NOT a terminal `merge.failed` that stranded a fixable spec. Absent
   * a rework router (an out-of-band/test caller) ⇒ the recoverable-conflict hold (never a silent
   * merge, never a terminal failure).
   */
  async handlePostRebaseGateFail(gateError: string | undefined): Promise<MergeForRunResult> {
    const { input, context, eventStore } = this.deps;
    const error = gateError ?? "post-rebase pre_merge gate failed (no gate detail reported)";
    if (input.reGateGateRework !== undefined) {
      await input.reGateGateRework.routeGateFailToRework({ specId: context.specId, gateError: error });
      // The spec is now being re-authored on the new base (re-opened + enqueued, OR — at a
      // convergence fixed point — escalated). Emit the recoverable `conflict` so this stale entry
      // leaves the merge slot; the reworked run re-enters the queue (a REAL in-flight recovery).
      await eventStore.append({
        ...this.base(),
        eventType: "merge.conflict",
        payload: {
          ...this.prFields(),
          integration: this.mergeLabel(),
          baseBranch: context.baseBranch,
          message: `post-rebase gate failed — routed to writer rework: ${error}`,
        },
      });
      await this.finalize("conflict", { taskOutcome: "pending", taskStatus: "running" });
      return this.result("conflict", { message: `post-rebase gate failed — routed to writer rework: ${error}` });
    }
    // No rework router wired (out-of-band/test caller): hold recoverably so the recovery surface
    // can re-drive (never a silent merge, never the old terminal failure).
    return this.emitConflict(`post-rebase gate failed: ${error}`);
  }

  /**
   * The re-gate did not reach a TERMINAL verdict (still running / an infra blip) — "not done
   * yet", NOT non-convergence. Emit a RE-DRIVE-RECOVERABLE hold (the coordinator re-runs the gate
   * next tick, unbounded while progressing) rather than the dequeue-and-abandon `conflict` that
   * bricked the live run. Records the recoverable `merge.regate_pending` signal (observable).
   */
  async emitReGatePending(message: string): Promise<MergeForRunResult> {
    const { eventStore } = this.deps;
    await eventStore.append({
      ...this.base(),
      eventType: "merge.regate_pending",
      payload: { ...this.prFields(), integration: this.mergeLabel(), message },
    });
    // RECOVERABLE, RE-DRIVABLE hold (NOT a terminal dequeue): leave the task running so the
    // coordinator re-drives the SAME queued entry — the native gate just needs to finish. The
    // distinct `re_gate_pending` outcome (not `blocked`/`conflict`) tells the coordinator this
    // is a still-running gate to re-poll, never non-convergence to dequeue or cap.
    await this.finalize("re_gate_pending", { taskOutcome: "pending", taskStatus: "running" });
    return this.result("re_gate_pending", { message });
  }

  /**
   * a behind/dirty branch surfaced a real conflict. Route it through the conflict
   * resolver; on resolution, run a FRESH `pre_merge` gate on the resolved tree then
   * re-enter the §5 land decision (`driveLand` → `MergeAuthority`), so the land judges
   * the RESOLVED tree on FRESH gate/mergeability/review/budget/demo state, fail-closed.
   * An unresolved conflict emits the recoverable outcome.
   */
  private async handleBranchConflict(
    mergeability: PullRequestMergeability,
    message: string,
  ): Promise<MergeForRunResult> {
    const resolution = await this.runConflictResolver(message);
    if (resolution.resolved) {
      // §5 land-authoritative gate on the RESOLVED tree: the resolver re-gates with
      // `pre_audit`, but the land reads `pre_merge` (else the stale pre-conflict
      // pre_merge PASS of the OLD tree wins). So run a FRESH `pre_merge` gate on the
      // resolved tree, fail-closed (a failed/pending/absent re-gate HOLDS the land).
      const gated = await reGateResolvedTree(this.deps, this);
      if (gated.kind !== "proceed") {
        return gated.result;
      }
      // Re-enter the authority-gated, transactional land — the §5 finalizer records the
      // `merge.completed` + spec flip transactionally.
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
      // Audit finding #5: the WRITER-PRESENT path uses the doctrine-pure
      // `markMergeTaskDoneWithEvent` (row + `task.completed` in ONE atomic
      // transaction via `updateTaskWithEvent`). Production ALWAYS wires the
      // writer; this is the live land path. The writer-undefined branch below
      // is the TEST-ONLY split-write seam — the merge-stage unit tests that
      // build the dispatcher without a workflow-level writer (e.g. the
      // dispatcher-direct-conflict-authority suites) still need a terminal
      // recording. The HELPER itself has no fallback (writer is required);
      // the dispatcher's split-write here is the bounded compromise the
      // helper-purity refactor preserves until the workflow-driving tests
      // wire a writer too.
      if (writer === undefined) {
        await finalizeDirectSplitDone(input.pool, eventStore, this.base(), integration);
        return;
      }
      await markMergeTaskDoneWithEvent({ writer, base: this.base(), integration });
      return;
    }
    if (state.taskStatus === "failed") {
      const failureKind = state.failureKind ?? "merge_failed";
      if (writer === undefined) {
        await finalizeDirectSplitFailed(input.pool, eventStore, this.base(), failureKind);
        return;
      }
      await markMergeTaskFailedWithEvent({ writer, base: this.base(), failureKind });
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
