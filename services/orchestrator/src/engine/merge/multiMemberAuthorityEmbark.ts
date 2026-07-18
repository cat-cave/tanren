// MQ-2 disposition → existing queue settlement. This helper owns no authority and
// cannot drive or land a member; it only decides which already-authorized candidates
// may enter the existing sequential re-authorization path.

import type { BatchAuthorityBinding } from "../contracts/batchMergeCoordinator.js";
import type { CoordinateResult, MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import { settleFailedDrive, type BatchSettleDeps } from "./batchCoordinatorSettle.js";
import type { BatchAuthorityEvaluator, MultiMemberAuthorityEvaluation } from "./multiMemberAuthorityTypes.js";

const AUTHORITY_RETRY_AFTER_MS = 3000;

export interface MultiMemberEmbarkDeps extends BatchSettleDeps {
  authorityEvaluator: BatchAuthorityEvaluator;
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
  const landed = await input.deps.authorityEvaluator.landAuthorizedGroup!({
    projectId: input.projectId,
    entries: input.batch,
    binding: requiredBinding(input.binding),
    evaluation,
  });
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
    const settled = await settleFailedDrive(input.deps, input.projectId, entry, detail);
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
