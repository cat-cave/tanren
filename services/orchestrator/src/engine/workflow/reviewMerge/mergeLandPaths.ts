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
import type { AuditEnvelope } from "../../events/schemas/audit.js";
import type { MergePullRequestResult } from "../../providers/githubReviewMerge.js";
import type { MergeAuthorityBundle, MergeForRunResult, MergeOutcomeKind } from "./mergeDispatchTypes.js";
import type { DispatcherDeps } from "./mergeDispatcher.js";

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
