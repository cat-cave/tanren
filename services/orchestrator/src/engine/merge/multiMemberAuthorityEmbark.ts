// MQ-2 disposition → existing queue settlement. This helper owns no authority and
// cannot drive or land a member; it only decides which already-authorized candidates
// may enter the existing sequential re-authorization path.

import type { BatchAuthorityBinding } from "../contracts/batchMergeCoordinator.js";
import type { CoordinateResult, MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import { settleFailedDrive, type BatchSettleDeps } from "./batchCoordinatorSettle.js";
import { markDequeuedAfterEvent } from "./coordinator.js";
import { settleFromParkOutcome } from "./parkSettle.js";
import type {
  BatchAuthorityEvaluator,
  MultiMemberAuthorityEvaluation,
  MultiMemberAuthorityMemberOutcome,
} from "./multiMemberAuthorityTypes.js";
import type { AutonomousRepairRouter } from "./autonomousRepairRouter.js";
import { confirmQueuePolicyBeforeLand } from "./queuePolicyLandFence.js";

const AUTHORITY_RETRY_AFTER_MS = 3000;

export interface MultiMemberEmbarkDeps extends BatchSettleDeps {
  authorityEvaluator: BatchAuthorityEvaluator;
  /**
   * mq-10 autonomous-repair router. When wired, an isolated deterministic-policy member is
   * classified: an in-place-repairable member goes to the existing writer rework; a member at a
   * PROVEN fixed point emits a RespecPacketV1 (re-drives spec authoring on a different agent) and
   * is retired as superseded; an unclassifiable failure fails closed to needs-attention.
   */
  repairRouter?: AutonomousRepairRouter;
}

export type MultiMemberEmbarkDecision =
  | {
      readonly kind: "continue";
      readonly entries: ReadonlyArray<MergeQueueEntry>;
      readonly evaluation?: MultiMemberAuthorityEvaluation;
      readonly dequeuedSpecId?: string;
    }
  | { readonly kind: "hold"; readonly result: CoordinateResult; readonly evaluation?: MultiMemberAuthorityEvaluation };

/** Complete the pass branch while keeping the capped coordinator a thin caller. */
export async function driveMultiMemberPass(input: {
  readonly deps: MultiMemberEmbarkDeps;
  readonly projectId: string;
  readonly batch: ReadonlyArray<MergeQueueEntry>;
  readonly binding: BatchAuthorityBinding | undefined;
  readonly integrationBranch: string;
  readonly queueDepth: number;
  readonly emitPassed: (batch: ReadonlyArray<MergeQueueEntry>, integrationBranch: string) => Promise<void>;
  readonly drive: (batch: ReadonlyArray<MergeQueueEntry>) => Promise<CoordinateResult>;
}): Promise<CoordinateResult> {
  const embark = await authorizeMultiMemberEmbark(input);
  if (embark.kind === "hold") return embark.result;
  if (
    embark.evaluation?.kind === "authorized_subset" &&
    input.deps.authorityEvaluator.landAuthorizedGroup !== undefined
  ) {
    return landAuthorizedGroup(input, embark.evaluation);
  }
  if (embark.evaluation?.kind !== "member_failure") {
    await input.emitPassed(embark.entries, input.integrationBranch);
  }
  if (embark.entries.length === 0) {
    return {
      projectId: input.projectId,
      queueDepth: input.queueDepth,
      holdReason: "all_blocked",
      ...(embark.dequeuedSpecId !== undefined && { dequeuedSpecId: embark.dequeuedSpecId }),
    };
  }
  const result = await input.drive(embark.entries);
  return embark.dequeuedSpecId === undefined || result.dequeuedSpecId !== undefined
    ? result
    : { ...result, dequeuedSpecId: embark.dequeuedSpecId };
}

/**
 * Claim every member before landing the exact integrated tree. On a CAS race all
 * claims are released and the next event-driven pass re-derives the batch; there
 * is intentionally no fixed retry cap because a changed main SHA is progress.
 */
async function landAuthorizedGroup(
  input: Parameters<typeof driveMultiMemberPass>[0],
  evaluation: Extract<MultiMemberAuthorityEvaluation, { kind: "authorized_subset" }>,
): Promise<CoordinateResult> {
  const claimed: MergeQueueEntry[] = [];
  for (const entry of input.batch) {
    if (!(await input.deps.queue.claim(entry.queueId))) {
      await releaseClaims(input.deps, claimed);
      return holdResult(input, "serialized");
    }
    claimed.push(entry);
    if (input.deps.queue.renewClaim !== undefined && !(await input.deps.queue.renewClaim(entry.queueId))) {
      await releaseClaims(input.deps, claimed);
      return holdResult(input, "serialized");
    }
    await input.deps.events.emitAdvanced({ projectId: input.projectId, entry, queueDepth: input.queueDepth });
  }
  // Re-prove every member immediately at the group-host boundary. A claim that
  // was reclaimed while the queue-advanced events were emitted must not join a
  // group land under its replacement owner's lease.
  for (const entry of claimed) {
    if (input.deps.queue.renewClaim !== undefined && !(await input.deps.queue.renewClaim(entry.queueId))) {
      await releaseClaims(input.deps, claimed);
      return holdResult(input, "serialized");
    }
  }
  // The preflight fence makes every evaluator fail closed, including a legacy
  // implementation that neglects to call the callback below. The PG evaluator
  // invokes the same callback again immediately before its host CAS, closing the
  // setup-time gap between this point and `authority.land()`.
  const confirmBeforeLand = () => confirmGroupPolicy(input.deps.queue, claimed);
  if (!(await confirmBeforeLand())) {
    await releaseClaims(input.deps, claimed);
    return holdResult(input, "all_blocked");
  }
  const landed = await input.deps.authorityEvaluator.landAuthorizedGroup!({
    projectId: input.projectId,
    entries: input.batch,
    binding: requiredBinding(input.binding),
    evaluation,
    confirmBeforeLand,
  });
  if (landed.kind === "policy_held") {
    await releaseClaims(input.deps, claimed);
    return holdResult(input, "all_blocked");
  }
  if (landed.kind !== "landed") {
    await releaseClaims(input.deps, claimed);
    return holdResult(input, "merge_retry", AUTHORITY_RETRY_AFTER_MS);
  }
  for (const entry of claimed) {
    if (!(await input.deps.queue.markMerged(entry.queueId))) return holdResult(input, "serialized");
  }
  await input.emitPassed(input.batch, input.integrationBranch);
  return { projectId: input.projectId, queueDepth: input.queueDepth, mergedSpecId: input.batch.at(-1)?.specId };
}

async function confirmGroupPolicy(queue: MultiMemberEmbarkDeps["queue"], entries: ReadonlyArray<MergeQueueEntry>) {
  for (const entry of entries) {
    if (!(await confirmQueuePolicyBeforeLand(queue, entry.queueId))) return false;
  }
  return true;
}

function requiredBinding(binding: BatchAuthorityBinding | undefined): BatchAuthorityBinding {
  if (binding === undefined) throw new Error("authorized multi-member land has no exact binding");
  return binding;
}

async function releaseClaims(deps: BatchSettleDeps, entries: ReadonlyArray<MergeQueueEntry>): Promise<void> {
  for (const entry of entries) await deps.queue.releaseClaim(entry.queueId);
}

function holdResult(
  input: Pick<Parameters<typeof driveMultiMemberPass>[0], "projectId" | "queueDepth">,
  holdReason: NonNullable<CoordinateResult["holdReason"]>,
  retryAfterMs?: number,
): CoordinateResult {
  return {
    projectId: input.projectId,
    queueDepth: input.queueDepth,
    holdReason,
    ...(retryAfterMs !== undefined && { retryAfterMs }),
  };
}

/** Evaluate a multi-member pass and settle attributed failures before any merge drive. */
export async function authorizeMultiMemberEmbark(input: {
  readonly deps: MultiMemberEmbarkDeps;
  readonly projectId: string;
  readonly batch: ReadonlyArray<MergeQueueEntry>;
  readonly binding: BatchAuthorityBinding | undefined;
  readonly queueDepth: number;
}): Promise<MultiMemberEmbarkDecision> {
  if (input.batch.length < 2) return { kind: "continue", entries: input.batch };
  if (input.binding === undefined) return hold(input, "all_blocked");

  let evaluation: MultiMemberAuthorityEvaluation;
  try {
    evaluation = await input.deps.authorityEvaluator.evaluate({
      projectId: input.projectId,
      entries: input.batch,
      binding: input.binding,
    });
  } catch {
    return hold(input, "merge_retry", undefined, AUTHORITY_RETRY_AFTER_MS);
  }

  if (evaluation.kind === "authorized_subset") {
    if (!isExactAllAdmit(input.batch, evaluation)) return hold(input, "all_blocked", evaluation);
    return { kind: "continue", entries: input.batch, evaluation };
  }

  if (evaluation.kind === "member_failure") {
    return settleMemberFailure(input, evaluation);
  }

  if (evaluation.kind === "transient_infrastructure") {
    return hold(input, "merge_retry", evaluation, AUTHORITY_RETRY_AFTER_MS);
  }
  return hold(input, "all_blocked", evaluation);
}

function isExactAllAdmit(
  batch: ReadonlyArray<MergeQueueEntry>,
  evaluation: Extract<MultiMemberAuthorityEvaluation, { kind: "authorized_subset" }>,
): boolean {
  if (evaluation.members.length !== batch.length || evaluation.authorizedMemberIds.length !== batch.length)
    return false;
  const authorized = new Set(evaluation.authorizedMemberIds);
  return batch.every(
    (entry, index) =>
      authorized.has(entry.specId) &&
      evaluation.members[index]?.specId === entry.specId &&
      evaluation.members[index]?.runId === entry.runId &&
      evaluation.members[index]?.disposition === "admit",
  );
}

async function settleMemberFailure(
  input: {
    readonly deps: MultiMemberEmbarkDeps;
    readonly projectId: string;
    readonly batch: ReadonlyArray<MergeQueueEntry>;
    readonly queueDepth: number;
  },
  evaluation: Extract<MultiMemberAuthorityEvaluation, { kind: "member_failure" }>,
): Promise<MultiMemberEmbarkDecision> {
  const failed = new Set(evaluation.failedMemberIds);
  const eligible = new Set(evaluation.eligibleMemberIds);
  if (failed.size === 0 || [...failed].some((id) => eligible.has(id))) {
    return hold(input, "all_blocked", evaluation);
  }
  const batchIds = new Set(input.batch.map((entry) => entry.specId));
  if ([...failed, ...eligible].some((id) => !batchIds.has(id))) return hold(input, "all_blocked", evaluation);

  let dequeuedSpecId: string | undefined;
  for (const entry of input.batch) {
    if (!failed.has(entry.specId)) continue;
    const member = evaluation.members.find((candidate) => candidate.specId === entry.specId);
    const reason = isolationReason(member?.reasonCodes);
    const findingIds = [...new Set(member?.findingIds ?? evaluation.findingIds)];
    if (input.deps.queue.isolateMember === undefined) {
      const claimed = await input.deps.queue.claim(entry.queueId);
      if (!claimed) return hold(input, "serialized", evaluation, AUTHORITY_RETRY_AFTER_MS);
    } else {
      const isolated = await input.deps.queue.isolateMember({
        queueId: entry.queueId,
        groupId: evaluation.groupId,
        memberId: entry.specId,
        reason,
        findingIds,
      });
      if (!isolated) return hold(input, "serialized", evaluation, AUTHORITY_RETRY_AFTER_MS);
    }
    const detail =
      `mq-2 member policy evaluation ${evaluation.evaluationId}: ` +
      `findings=${findingIds.join(",") || "unavailable"}`;
    const settled = await routeAndSettleMember(input, evaluation, entry, member, findingIds, detail);
    if (settled === "retained") return hold(input, "merge_retry", evaluation, AUTHORITY_RETRY_AFTER_MS);
    dequeuedSpecId = entry.specId;
  }

  const entries = input.batch.filter(
    (entry) => eligible.has(entry.specId) && entry.dependsOn.every((dependency) => !failed.has(dependency)),
  );
  return {
    kind: "continue",
    entries,
    evaluation,
    ...(dequeuedSpecId !== undefined && { dequeuedSpecId }),
  };
}

/**
 * mq-10: consult the autonomous-repair router (when wired), then retire the isolated member per
 * its decision. `repair_in_place` uses the existing writer-rework path (re-authors the SAME
 * spec); a `respec` or `blocked_needs_attention` routing already recorded its lineage + emitted
 * its event, so the failing member is retired as superseded/needs-attention WITHOUT another
 * in-place rework (the respec's replacement spec drives fresh; a blocked member awaits a human).
 * With no router wired, behavior is unchanged (writer rework).
 */
async function routeAndSettleMember(
  input: { readonly deps: MultiMemberEmbarkDeps; readonly projectId: string },
  evaluation: Extract<MultiMemberAuthorityEvaluation, { kind: "member_failure" }>,
  entry: MergeQueueEntry,
  member: MultiMemberAuthorityMemberOutcome | undefined,
  findingIds: ReadonlyArray<string>,
  detail: string,
): Promise<"dequeued" | "retained"> {
  if (input.deps.repairRouter === undefined) {
    return settleFailedDrive(input.deps, input.projectId, entry, detail);
  }
  const outcome = await input.deps.repairRouter.routeMemberFailure({
    projectId: input.projectId,
    groupId: evaluation.groupId,
    evaluationId: evaluation.evaluationId,
    sourceSpecId: entry.specId,
    runId: entry.runId,
    // A `member_failure`'s W0 is deterministic policy; the router fails closed on anything else.
    classification: evaluation.w0.classification,
    findingIds,
    reasonCodes: member?.reasonCodes ?? [],
  });
  if (outcome.kind === "repair_in_place") {
    return settleFailedDrive(input.deps, input.projectId, entry, detail);
  }
  const retireMessage =
    outcome.kind === "respec"
      ? `mq-10 respec routed (${detail}); superseded by ${outcome.replacementSpecIds.join(",") || "replacement"}`
      : `mq-10 blocked needs attention (${outcome.reason}): ${detail}`;
  return retireRoutedMember(input.deps, input.projectId, entry, retireMessage);
}

/**
 * mq-10: retire an isolated member the autonomous-repair router routed to `respec` or
 * `blocked_needs_attention`. Unlike {@link settleFailedDrive}, this does NOT hand the member to
 * the writer for another in-place rework — a respec already materialized a replacement spec and a
 * blocked member awaits a human. The member is parked (superseded/needs-attention) and dequeued
 * atomically; a park failure retains the entry (fail-closed, never a silent drop).
 */
async function retireRoutedMember(
  deps: BatchSettleDeps,
  projectId: string,
  entry: MergeQueueEntry,
  message: string,
): Promise<"dequeued" | "retained"> {
  const park = await deps.escalator.escalate({ projectId, entry, message });
  const settled = settleFromParkOutcome(park, message);
  if (settled.action === "retain") {
    await deps.queue.releaseClaim(entry.queueId);
    return "retained";
  }
  if (!settled.alreadyDequeued) {
    await markDequeuedAfterEvent({
      queue: deps.queue,
      events: deps.events,
      projectId,
      entry,
      reason: settled.reason,
      message: settled.message,
    });
  }
  await deps.recoverableDriveHolds?.reset(entry.queueId);
  return "dequeued";
}

function isolationReason(
  reasonCodes: ReadonlyArray<string> | undefined,
): "audit_policy" | "member_gate" | "behavior_proof" | "design_proof" {
  if (reasonCodes?.includes("member_gate") === true) return "member_gate";
  if (reasonCodes?.includes("behavior_proof") === true) return "behavior_proof";
  if (reasonCodes?.includes("design_proof") === true) return "design_proof";
  return "audit_policy";
}

function hold(
  input: { readonly projectId: string; readonly queueDepth: number },
  holdReason: NonNullable<CoordinateResult["holdReason"]>,
  evaluation?: MultiMemberAuthorityEvaluation,
  retryAfterMs?: number,
): MultiMemberEmbarkDecision {
  return {
    kind: "hold",
    result: {
      projectId: input.projectId,
      queueDepth: input.queueDepth,
      holdReason,
      ...(retryAfterMs !== undefined && { retryAfterMs }),
    },
    ...(evaluation !== undefined && { evaluation }),
  };
}
