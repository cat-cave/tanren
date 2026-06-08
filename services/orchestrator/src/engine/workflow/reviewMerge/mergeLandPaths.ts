// The two LAND paths the merge stage's `directMerge` dispatches to (§5 cutover),
// extracted from `MergeDispatcher` to keep each file under the 500-line cap:
//   - `landViaAuthority` — the GUARANTEED land: run the fail-closed `MergeAuthority`
//     truth table, land the authorized commit via `CodeHost.landAuthorizedRef` (the
//     ff-only CAS), and map the disposition onto the merge stage's event vocabulary.
//   - `landViaHostMerge` — the retained KILL-SWITCH (`MERGE_AUTHORITY_LIVE=0`) host
//     merge break-glass: NOT the merge authority, kept only to revert the cutover.
//
// Both operate on the dispatcher's `DispatcherDeps` + a small {@link LandOps} surface
// (the shared event/finalize/result helpers the dispatcher owns), so the land logic
// is one cohesive module without duplicating those helpers.

import { runAuthorityLand } from "../../merge/mergeAuthorityGate.js";
import { evaluatePostureGate } from "../../forge/audits/postureGate.js";
import type { AuditEnvelope } from "../../events/schemas/audit.js";
import type { PullRequestMergeability } from "../../contracts/vcsProvider.js";
import type { MergePullRequestResult } from "../../providers/githubReviewMerge.js";
import type { MergeAuthorityBundle, MergeForRunResult, MergeOutcomeKind } from "./mergeDispatchTypes.js";
import type { DispatcherDeps } from "./mergeDispatcher.js";

/**
 * THE ONE BASE-SHIFT HANDLER (tanren-owns-the-engine.md §7): rebase a `behind` branch
 * onto its base through the unified `baseShiftRebase` hook (`BaseShiftCoordinator.rebaseOnto`
 * — the SAME path change-percolation uses; the two divergent base-shift handlers collapse
 * into ONE). Absent ⇒ the pre-fold server-side `probe.updateBranch()` (retained through
 * S2 so a not-yet-wired caller still rebases — never a silent skip), with its `updated`
 * mapped onto the unified `rebased`. Extracted as a free function to keep the dispatcher
 * under the 500-line cap.
 */
export async function rebaseBehindBranch(
  deps: DispatcherDeps,
  mergeability: PullRequestMergeability,
): Promise<{ outcome: "rebased" | "up_to_date" | "conflict" | "held"; message?: string }> {
  const { input, context, probe } = deps;
  if (input.baseShiftRebase !== undefined) {
    const head = mergeability.headBranch;
    return input.baseShiftRebase({
      runId: context.runId,
      baseBranch: mergeability.baseBranch || context.baseBranch,
      ...(head !== "" && head !== undefined && { headBranch: head }),
    });
  }
  const updated = await probe.updateBranch();
  const outcome = updated.outcome === "updated" ? "rebased" : updated.outcome;
  return { outcome, ...(updated.message !== undefined && { message: updated.message }) };
}

/**
 * The shared dispatcher operations the land paths reuse (the event base, the PR
 * fields, the audit envelope, the integration label, the task finalize, the result
 * shape, the recoverable-conflict emit, the ephemeral-ref cleanup, and the host-merge
 * conflict retry). Implemented by `MergeDispatcher`; passed to the extracted paths so
 * they do not re-derive any of it.
 */
export interface LandOps {
  base(): { runId: string; specId: string; projectId: string; taskId: string };
  prFields(): { prUrl: string; prNumber: number };
  auditEnvelope(): AuditEnvelope;
  mergeLabel(): "direct_merge" | "native_queue";
  finalize(
    outcome: MergeOutcomeKind,
    state: {
      taskOutcome: "ok" | "failed" | "pending";
      taskStatus: "done" | "failed" | "running";
      failureKind?: string;
    },
  ): Promise<void>;
  result(outcome: MergeOutcomeKind, extra?: { mergeSha?: string; message?: string }): MergeForRunResult;
  emitConflict(message: string, headBranch?: string): Promise<MergeForRunResult>;
  cleanupIntegrationBranch(): Promise<void>;
  tryResolveConflict(merge: MergePullRequestResult): Promise<MergePullRequestResult | undefined>;
}

/**
 * The GUARANTEED land (§5): read the dispatcher-owned mergeability, run the authority
 * truth table + host CAS land, then map the disposition onto the merge stage's
 * outcomes — `merged` finalizes the task (the LandFinalizer already recorded
 * `merge.completed` + the spec flip transactionally); `needs_attention`/`blocked` hold
 * recoverably (the recovery surface re-drives / escalates); a benign CAS race re-drives;
 * `merge_state_unknown` holds LOUDLY for reconciliation (never a silent inconsistency).
 */
export async function landViaAuthority(
  deps: DispatcherDeps,
  ops: LandOps,
  bundle: MergeAuthorityBundle,
): Promise<MergeForRunResult> {
  const { context, pr } = deps;
  const mergeability = await deps.probe.readMergeability();
  const disposition = await runAuthorityLand({
    bundle,
    mergeability,
    context: {
      repo: { owner: pr.repo.owner, name: pr.repo.name },
      intoMain: context.baseBranch,
      runId: context.runId,
      specId: context.specId,
      projectId: context.projectId,
      taskId: deps.taskId,
      prUrl: context.prUrl,
      prNumber: pr.pullNumber,
    },
    integration: ops.mergeLabel(),
    auditEnvelope: ops.auditEnvelope(),
  });

  switch (disposition.kind) {
    case "merged": {
      await ops.cleanupIntegrationBranch();
      await ops.finalize("merged", { taskOutcome: "ok", taskStatus: "done" });
      // The merge was NOT blocked — so any residual (below-`blockReviewAt`) P2/P3
      // findings are handled per the project posture (§4): route-to-dag emits
      // them as new DAG specs; fix-if-idle carries them forward (the land just merged,
      // so the spec is no longer idle-awaiting-review). Record the disposition.
      await recordPostureRouting(deps, ops, bundle);
      return ops.result("merged", { mergeSha: disposition.mainSha });
    }
    case "needs_attention": {
      // A genuine human decision (HITL pending / changes_requested at merge time).
      // Surface `blocked` — the planner/coordinator route it to spec `needs_attention`.
      await emitAuthorityBlocked(deps, ops, disposition.reasons);
      await ops.finalize("blocked", { taskOutcome: "pending", taskStatus: "running" });
      return ops.result("blocked", { message: disposition.reasons.join("; ") });
    }
    case "blocked": {
      await emitAuthorityBlocked(deps, ops, disposition.reasons);
      return ops.emitConflict(`land blocked by authority: ${disposition.reasons.join("; ")}`);
    }
    case "cas_rejected":
      // Main raced ahead — a benign retryable race (no land happened).
      return ops.emitConflict(`land CAS rejected (main advanced): ${disposition.reason}`);
    case "merge_state_unknown": {
      // The host advanced `main` but the durable record FAILED — NEVER a silent
      // inconsistency: hold loudly for reconciliation.
      await deps.eventStore.append({
        ...ops.base(),
        eventType: "merge.failed",
        payload: {
          ...ops.prFields(),
          integration: ops.mergeLabel(),
          message: `merge_state_unknown (reconcile ${disposition.reconcileToken}): ${disposition.reason}`,
        },
      });
      await ops.finalize("conflict", { taskOutcome: "pending", taskStatus: "running" });
      return ops.result("conflict", { message: disposition.reason });
    }
  }
}

/**
 * Record the posture-gate's residual P2/P3 disposition after a merge (§4). The merge
 * already CLEARED the block decision, so these findings are below `blockReviewAt`; the
 * project posture decides their fate: `route-to-dag` ⇒ each becomes a new DAG spec;
 * `fix-if-idle` ⇒ carried forward (the spec just merged, so it is NOT idle-awaiting-
 * review). The `auditor.findings_routed` event is the durable audit trail of that
 * disposition — the SAME `evaluatePostureGate` policy that drives the block, now wired
 * into the live merge flow. Emitted only when there ARE residual findings.
 */
async function recordPostureRouting(deps: DispatcherDeps, ops: LandOps, bundle: MergeAuthorityBundle): Promise<void> {
  // The land just merged, so the spec is not idle-awaiting-review ⇒ fix-if-idle residuals
  // carry forward rather than spawning mid-run fix work.
  const result = evaluatePostureGate(bundle.findings, bundle.auditPosture, { idleAwaitingReview: false });
  const routed = result.dispositions.filter((d) => d.action === "route").map((d) => refOf(d));
  const fixedInPlace = result.dispositions.filter((d) => d.action === "fix").map((d) => refOf(d));
  const carriedForward = result.dispositions.filter((d) => d.action === "carryForward").map((d) => refOf(d));
  if (routed.length === 0 && fixedInPlace.length === 0 && carriedForward.length === 0) {
    return;
  }
  await deps.eventStore.append({
    ...ops.base(),
    eventType: "auditor.findings_routed",
    payload: {
      runId: deps.context.runId,
      p2p3Handling: bundle.auditPosture.p2p3Handling,
      routed,
      fixedInPlace,
      carriedForward,
    },
  });
}

/** Project a posture disposition's finding onto the routed-finding-ref event shape. */
function refOf(d: { finding: { id: string; severity: string; title: string } }): {
  id: string;
  severity: "P2" | "P3";
  title: string;
} {
  // The posture gate's residuals are below `blockReviewAt` — P2/P3 by construction.
  return { id: d.finding.id, severity: d.finding.severity as "P2" | "P3", title: d.finding.title };
}

/** Emit the authority's fail-closed hold as a `merge.blocked` event (recovery surface). */
async function emitAuthorityBlocked(deps: DispatcherDeps, ops: LandOps, reasons: ReadonlyArray<string>): Promise<void> {
  await deps.eventStore.append({
    ...ops.base(),
    eventType: "merge.blocked",
    payload: {
      ...ops.prFields(),
      integration: deps.integration,
      posture: deps.context.governancePosture,
      mode: "operator_approval",
      externalLogins: [],
      reason: reasons.join("; "),
    },
  });
}

/**
 * KILL-SWITCH (`MERGE_AUTHORITY_LIVE=0`): the retained host-merge break-glass. NOT
 * the merge authority — none of the §5 guarantees — kept solely to revert the cutover.
 * A single conflict-resolver retry, as before the cutover.
 */
export async function landViaHostMerge(deps: DispatcherDeps, ops: LandOps): Promise<MergeForRunResult> {
  const { eventStore, probe } = deps;
  let merge = await probe.merge();
  if (!merge.merged && merge.conflict) {
    const retried = await ops.tryResolveConflict(merge);
    if (retried !== undefined) {
      merge = retried;
    }
  }
  if (merge.merged) {
    await eventStore.append({
      ...ops.base(),
      eventType: "merge.completed",
      payload: { ...ops.prFields(), integration: ops.mergeLabel(), mergeSha: merge.mergeSha, ...ops.auditEnvelope() },
    });
    await ops.cleanupIntegrationBranch();
    await ops.finalize("merged", { taskOutcome: "ok", taskStatus: "done" });
    return ops.result("merged", { mergeSha: merge.mergeSha });
  }
  if (merge.conflict) {
    return ops.emitConflict(merge.message);
  }
  await eventStore.append({
    ...ops.base(),
    eventType: "merge.failed",
    payload: { ...ops.prFields(), integration: ops.mergeLabel(), message: merge.message },
  });
  await ops.finalize("failed", { taskOutcome: "failed", taskStatus: "failed", failureKind: "merge_failed" });
  return ops.result("failed", { message: merge.message });
}

/**
 * Run a FRESH `pre_merge` gate on the RESOLVED tree (§5) before the land authority
 * judges it — so the land authority's gate verdict is a `pre_merge` gate on the EXACT
 * tree being landed (post-resolution), not the stale pre-conflict pre_merge pass. The
 * resolver re-gates with the `pre_audit` tier; the land reads only `pre_merge`, so a
 * fresh `pre_merge` gate MUST run on the resolved tree here. REQUIRED + fail-closed: an
 * ABSENT re-gate hook, a FAILED gate, or a PENDING (non-converged) gate all HOLD
 * (recoverable) — the resolved tree is never landed on an unverified or stale gate.
 * `reGateCi` runs `runNativeMergeGate` (`pre_merge`), emitting a fresh `pre_merge`
 * gate.verdict the land reader (`resolveLandTimeSignals`) then picks up.
 */
export async function reGateResolvedTree(
  deps: DispatcherDeps,
  ops: LandOps,
): Promise<{ kind: "proceed" } | { kind: "halt"; result: MergeForRunResult }> {
  const reGate = deps.input.reGateCi;
  if (reGate === undefined) {
    return {
      kind: "halt",
      result: await ops.emitConflict(
        "resolved-tree pre_merge re-gate hook is absent; cannot verify the resolved tree — land held",
      ),
    };
  }
  const ci = await reGate();
  if (ci.status === "failed") {
    await deps.eventStore.append({
      ...ops.base(),
      eventType: "merge.failed",
      payload: { ...ops.prFields(), integration: ops.mergeLabel(), message: "pre_merge gate failed on resolved tree" },
    });
    await ops.finalize("failed", { taskOutcome: "failed", taskStatus: "failed", failureKind: "merge_failed" });
    return { kind: "halt", result: ops.result("failed", { message: "pre_merge gate failed on resolved tree" }) };
  }
  if (ci.status === "pending") {
    return { kind: "halt", result: await ops.emitConflict("pre_merge gate did not converge on the resolved tree") };
  }
  return { kind: "proceed" };
}
