// cspell:ignore quickxplain Xplain

/**
 * MQ-3 safe-subset proposal algorithm.
 *
 * This module is deliberately a pure proposal layer. It consumes MQ-2's typed
 * evaluation, uses an injected deterministic oracle for exact subset probes, and
 * never calls MergeAuthority, lands a node, mutates queue state, emits an event, or
 * performs I/O. MergeAuthority remains the only component that can authorize land.
 */

import type { LandMemberDisposition } from "../contracts/mergeAuthority.js";
import { ddmin } from "./ddmin.js";
import { quickXPlain } from "./quickXplain.js";
import type { MultiMemberAuthorityEvaluation, MultiMemberAuthorityMemberOutcome } from "./multiMemberAuthorityTypes.js";

export interface SafeSubsetMember {
  readonly specId: string;
  /** Dependencies represented in the candidate group; already-merged ancestors may be omitted. */
  readonly dependsOn: ReadonlyArray<string>;
  /** Larger values win when multiple safe subsets are available. Defaults to 1. */
  readonly weight?: number;
}

export type SafeSubsetSignalKind = "interaction_failure" | "flake_observation" | "transient_infrastructure";

/** The small read-side projection shape needed for durable interaction/flake probes. */
export interface SafeSubsetProjectedEvaluation {
  readonly kind: "interaction_failure" | "flake_observation";
  readonly eligibleMemberIds: ReadonlyArray<string>;
  readonly members: ReadonlyArray<Pick<MultiMemberAuthorityMemberOutcome, "specId" | "disposition">>;
}

export type SafeSubsetEvaluation = MultiMemberAuthorityEvaluation | SafeSubsetProjectedEvaluation;

export interface SafeSubsetSolverInput {
  readonly evaluation: MultiMemberAuthorityEvaluation;
  readonly members: ReadonlyArray<SafeSubsetMember>;
  /**
   * Exact, deterministic subset oracle. The solver never assumes a result for one
   * subset applies to another. Omitting it produces a proposal that still reflects
   * direct MQ-2 attribution but requires exact re-evaluation before authorization.
   */
  readonly probe?: (memberIds: ReadonlyArray<string>) => SafeSubsetEvaluation;
  /** Read-side signal label when the initial MQ-2 value is projected elsewhere. */
  readonly signalKind?: SafeSubsetSignalKind;
  /** Initial k-way split for ddmin; defaults to four where possible. */
  readonly interactionSplitFactor?: number;
  /** Safety bound for exact subset probes. Defaults to 65,536 closed candidates. */
  readonly maxSubsetCandidates?: number;
}

export interface SafeSubsetFailureConstraint {
  readonly kind: "direct_member" | "interaction";
  readonly memberIds: ReadonlyArray<string>;
  readonly source: "mq2_direct_attribution" | "preflight" | "ddmin" | "quickxplain";
}

export interface SafeSubsetSolverResult {
  /** The solver's proposed member set; this is not an authorization or land payload. */
  readonly proposedMemberIds: ReadonlyArray<string>;
  /** Only these members were directly blamed by a deterministic member-local signal. */
  readonly excludedMemberIds: ReadonlyArray<string>;
  /** DAG descendants held because their dependency was directly excluded. */
  readonly heldMemberIds: ReadonlyArray<string>;
  /** Flakes and transient infrastructure are intentionally absent from this list. */
  readonly failureConstraints: ReadonlyArray<SafeSubsetFailureConstraint>;
  readonly interactionSets: ReadonlyArray<ReadonlyArray<string>>;
  readonly probes: number;
  readonly dependencyClosed: boolean;
  readonly provenByExactProbe: boolean;
  readonly status: "maximal_safe" | "candidate_requires_authorization" | "deferred_no_constraint" | "unresolved";
  readonly exactEvaluation?: SafeSubsetEvaluation;
}

type ProbeVerdict = "safe" | "direct_failure" | "interaction_failure" | "no_constraint" | "fail_closed";

function stableUnique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}

function canonical(ids: ReadonlyArray<string>, order: ReadonlyArray<string>): string[] {
  const selected = new Set(ids);
  return order.filter((id) => selected.has(id));
}

function key(ids: ReadonlyArray<string>): string {
  return [...ids].sort().join("\0");
}

function signalKindOf(
  evaluation: SafeSubsetEvaluation,
  inherited?: SafeSubsetSignalKind,
): SafeSubsetSignalKind | undefined {
  if (evaluation.kind === "interaction_failure" || evaluation.kind === "flake_observation") return evaluation.kind;
  if (evaluation.kind === "transient_infrastructure") return "transient_infrastructure";
  if ("w0" in evaluation && evaluation.w0?.classification === "transient_infrastructure") {
    return "transient_infrastructure";
  }
  return inherited;
}

function isNoBlame(evaluation: SafeSubsetEvaluation, inherited?: SafeSubsetSignalKind): boolean {
  const signal = signalKindOf(evaluation, inherited);
  return signal === "flake_observation" || signal === "transient_infrastructure";
}

function isInteraction(evaluation: SafeSubsetEvaluation, inherited?: SafeSubsetSignalKind): boolean {
  return !isNoBlame(evaluation, inherited) && signalKindOf(evaluation, inherited) === "interaction_failure";
}

function directFailures(evaluation: MultiMemberAuthorityEvaluation, inherited?: SafeSubsetSignalKind): string[] {
  if (isNoBlame(evaluation, inherited) || evaluation.kind !== "member_failure") return [];
  const excluded = new Set(
    evaluation.members.filter((member) => member.disposition === "exclude").map((member) => member.specId),
  );
  return stableUnique([...evaluation.failedMemberIds, ...excluded]);
}

function dispositionFor(evaluation: SafeSubsetEvaluation, specId: string): LandMemberDisposition | undefined {
  return evaluation.members.find((member) => member.specId === specId)?.disposition;
}

function isExactAuthorized(evaluation: SafeSubsetEvaluation, ids: ReadonlyArray<string>): boolean {
  if (evaluation.kind !== "authorized_subset") return false;
  const described = evaluation.members.map((member) => member.specId);
  const authorized = new Set(evaluation.authorizedMemberIds);
  const eligible = new Set(evaluation.eligibleMemberIds);
  const selected = new Set(ids);
  return (
    described.length === ids.length &&
    described.every((id) => selected.has(id)) &&
    evaluation.authorizedMemberIds.length === ids.length &&
    evaluation.eligibleMemberIds.length === ids.length &&
    ids.every((id) => authorized.has(id) && eligible.has(id) && dispositionFor(evaluation, id) === "admit")
  );
}

function classifyProbe(
  evaluation: SafeSubsetEvaluation,
  ids: ReadonlyArray<string>,
  inheritedSignal: SafeSubsetSignalKind | undefined,
): ProbeVerdict {
  if (isNoBlame(evaluation, inheritedSignal)) return "no_constraint";
  if (isExactAuthorized(evaluation, ids)) return "safe";
  if (evaluation.kind === "member_failure" && directFailures(evaluation, inheritedSignal).length > 0)
    return "direct_failure";
  if (isInteraction(evaluation, inheritedSignal)) return "interaction_failure";
  return "fail_closed";
}

function validateMembers(members: ReadonlyArray<SafeSubsetMember>): Map<string, SafeSubsetMember> {
  const byId = new Map<string, SafeSubsetMember>();
  for (const member of members) {
    if (member.specId.trim() === "") throw new Error("safe-subset member id must not be empty");
    if (byId.has(member.specId)) throw new Error(`duplicate safe-subset member ${member.specId}`);
    const weight = member.weight ?? 1;
    if (!Number.isFinite(weight) || weight < 0) throw new Error(`invalid safe-subset weight for ${member.specId}`);
    byId.set(member.specId, { ...member, weight });
  }
  for (const member of members) {
    for (const dependency of member.dependsOn) {
      if (dependency === member.specId) throw new Error(`safe-subset dependency cycle at ${member.specId}`);
      if (!byId.has(dependency)) throw new Error(`unknown safe-subset dependency ${dependency}`);
    }
  }
  return byId;
}

function descendantsOf(seed: ReadonlySet<string>, members: ReadonlyMap<string, SafeSubsetMember>): Set<string> {
  const held = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const member of members.values()) {
      if (seed.has(member.specId) || held.has(member.specId)) continue;
      if (member.dependsOn.some((dependency) => seed.has(dependency) || held.has(dependency))) {
        held.add(member.specId);
        changed = true;
      }
    }
  }
  return held;
}

function dependencyClosed(ids: ReadonlyArray<string>, members: ReadonlyMap<string, SafeSubsetMember>): boolean {
  const selected = new Set(ids);
  return [...selected].every(
    (id) => members.get(id)?.dependsOn.every((dependency) => selected.has(dependency)) ?? false,
  );
}

function closeDownward(ids: ReadonlyArray<string>, members: ReadonlyMap<string, SafeSubsetMember>): string[] {
  const selected = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of selected) {
      const member = members.get(id);
      if (member === undefined || member.dependsOn.some((dependency) => !selected.has(dependency))) {
        selected.delete(id);
        changed = true;
      }
    }
  }
  return [...selected];
}

function subsetWeight(ids: ReadonlyArray<string>, members: ReadonlyMap<string, SafeSubsetMember>): number {
  return ids.reduce((total, id) => total + (members.get(id)?.weight ?? 0), 0);
}

function closedSubsets(
  ids: ReadonlyArray<string>,
  members: ReadonlyMap<string, SafeSubsetMember>,
  maxCandidates: number,
): ReadonlyArray<ReadonlyArray<string>> {
  if (ids.length >= 31) throw new Error("safe-subset exact search supports at most 30 candidate members");
  const subsets: string[][] = [];
  const limit = 2 ** ids.length;
  for (let mask = 0; mask < limit; mask += 1) {
    const subset = ids.filter((_, index) => (mask & (2 ** index)) !== 0);
    if (dependencyClosed(subset, members)) subsets.push(subset);
    if (subsets.length > maxCandidates) return [];
  }
  return subsets.sort((left, right) => {
    const weightDelta = subsetWeight(right, members) - subsetWeight(left, members);
    if (weightDelta !== 0) return weightDelta;
    if (right.length !== left.length) return right.length - left.length;
    return key(left).localeCompare(key(right));
  });
}

function directConstraint(
  memberIds: ReadonlyArray<string>,
  source: SafeSubsetFailureConstraint["source"],
): SafeSubsetFailureConstraint | undefined {
  const ids = stableUnique(memberIds);
  return ids.length === 0 ? undefined : { kind: "direct_member", memberIds: ids, source };
}

function interactionConstraint(
  memberIds: ReadonlyArray<string>,
  source: "ddmin" | "quickxplain",
): SafeSubsetFailureConstraint | undefined {
  const ids = stableUnique(memberIds);
  return ids.length === 0 ? undefined : { kind: "interaction", memberIds: ids, source };
}

/**
 * Compute the maximal exact-probe-safe dependency-closed proposal.
 *
 * Direct member-local exclusions are applied first. If the remaining full group
 * has an unattributed interaction failure, singleton preflight runs before k-way
 * ddmin and QuickXPlain. Interaction sets are recorded as evidence only: because
 * the gate may be non-monotone, they are never reused to claim that a different
 * superset or subset passes/fails. The winner is always exact-probed and candidates
 * are ordered by total weight, so the first exact pass is maximal.
 */
export function solveSafeSubset(input: SafeSubsetSolverInput): SafeSubsetSolverResult {
  const membersById = validateMembers(input.members);
  const order = input.members.map((member) => member.specId);
  const allIds = [...order];
  const signal = input.signalKind;
  const initialNoBlame = isNoBlame(input.evaluation, signal);
  const directlyFailed = new Set(directFailures(input.evaluation, signal));
  const failureConstraints: SafeSubsetFailureConstraint[] = [];
  const initialDirect = directConstraint([...directlyFailed], "mq2_direct_attribution");
  if (initialDirect !== undefined && !initialNoBlame) failureConstraints.push(initialDirect);

  const directHeld = descendantsOf(directlyFailed, membersById);
  const initialAdmitted = new Set(input.evaluation.eligibleMemberIds);
  const interactionSearch = isInteraction(input.evaluation, signal);
  const candidateSeed =
    initialNoBlame || interactionSearch
      ? allIds
      : allIds.filter((id) => initialAdmitted.has(id) && !directlyFailed.has(id) && !directHeld.has(id));
  const probeCache = new Map<string, SafeSubsetEvaluation>();
  let probes = 0;

  const exactProbe = (ids: ReadonlyArray<string>): SafeSubsetEvaluation | undefined => {
    if (input.probe === undefined || ids.length === 0) return undefined;
    const subset = canonical(ids, order);
    const subsetKey = key(subset);
    const cached = probeCache.get(subsetKey);
    if (cached !== undefined) return cached;
    const result = input.probe(subset);
    probeCache.set(subsetKey, result);
    probes += 1;
    return result;
  };

  const preflightFailures = new Set<string>();
  if (interactionSearch && !initialNoBlame && input.probe !== undefined) {
    for (const id of candidateSeed) {
      const result = exactProbe([id]);
      if (
        result === undefined ||
        result.kind !== "member_failure" ||
        classifyProbe(result, [id], signal) !== "direct_failure"
      )
        continue;
      for (const failed of directFailures(result, signal)) preflightFailures.add(failed);
    }
  }
  if (preflightFailures.size > 0) {
    for (const id of preflightFailures) directlyFailed.add(id);
    const preflightConstraint = directConstraint([...preflightFailures], "preflight");
    if (preflightConstraint !== undefined) failureConstraints.push(preflightConstraint);
  }

  const held = descendantsOf(directlyFailed, membersById);
  let allowed = candidateSeed.filter((id) => !directlyFailed.has(id) && !held.has(id));
  if (!initialNoBlame && !interactionSearch) allowed = allowed.filter((id) => initialAdmitted.has(id));
  allowed = closeDownward(allowed, membersById);

  const interactionSets: ReadonlyArray<string>[] = [];
  if (interactionSearch && input.probe !== undefined && allowed.length > 0) {
    const isInteractionFailure = (ids: ReadonlyArray<string>): boolean => {
      const result = exactProbe(ids);
      return result !== undefined && classifyProbe(result, ids, signal) === "interaction_failure";
    };
    if (isInteractionFailure(allowed)) {
      const splitFactor = Math.max(2, Math.min(input.interactionSplitFactor ?? 4, allowed.length));
      const ddminResult = ddmin(allowed, isInteractionFailure, { initialGranularity: splitFactor });
      if (ddminResult.minimalFailingSet.length > 0) {
        interactionSets.push(canonical(ddminResult.minimalFailingSet, order));
        const constraint = interactionConstraint(ddminResult.minimalFailingSet, "ddmin");
        if (constraint !== undefined) failureConstraints.push(constraint);
      }

      const qxResult = quickXPlain([], allowed, (ids) => !isInteractionFailure(ids));
      if (qxResult.minimalConflictSet.length > 0) {
        const conflict = canonical(qxResult.minimalConflictSet, order);
        if (!interactionSets.some((set) => key(set) === key(conflict))) interactionSets.push(conflict);
        const constraint = interactionConstraint(conflict, "quickxplain");
        if (constraint !== undefined) failureConstraints.push(constraint);
      }
    }
  }

  if (initialNoBlame) {
    const proposed = canonical(allIds, order);
    return {
      proposedMemberIds: proposed,
      excludedMemberIds: [],
      heldMemberIds: [],
      failureConstraints: [],
      interactionSets: [],
      probes,
      dependencyClosed: dependencyClosed(proposed, membersById),
      provenByExactProbe: false,
      status: "deferred_no_constraint",
    };
  }

  if (input.probe === undefined) {
    const proposed = canonical(allowed, order);
    return {
      proposedMemberIds: proposed,
      excludedMemberIds: canonical([...directlyFailed], order),
      heldMemberIds: canonical([...held], order),
      failureConstraints,
      interactionSets,
      probes,
      dependencyClosed: dependencyClosed(proposed, membersById),
      provenByExactProbe: false,
      status: interactionSearch ? "unresolved" : "candidate_requires_authorization",
    };
  }

  const maxCandidates = input.maxSubsetCandidates ?? 65_536;
  const choices = closedSubsets(allowed, membersById, maxCandidates);
  if (choices.length === 0) {
    return {
      proposedMemberIds: [],
      excludedMemberIds: canonical([...directlyFailed], order),
      heldMemberIds: canonical([...held], order),
      failureConstraints,
      interactionSets,
      probes,
      dependencyClosed: true,
      provenByExactProbe: false,
      status: "unresolved",
    };
  }

  for (const choice of choices) {
    const exactEvaluation = choice.length === 0 ? undefined : exactProbe(choice);
    if (choice.length === 0 || (exactEvaluation !== undefined && isExactAuthorized(exactEvaluation, choice))) {
      return {
        proposedMemberIds: canonical(choice, order),
        excludedMemberIds: canonical([...directlyFailed], order),
        heldMemberIds: canonical([...held], order),
        failureConstraints,
        interactionSets,
        probes,
        dependencyClosed: true,
        provenByExactProbe: choice.length > 0,
        status: "maximal_safe",
        ...(exactEvaluation !== undefined && { exactEvaluation }),
      };
    }
  }

  return {
    proposedMemberIds: [],
    excludedMemberIds: canonical([...directlyFailed], order),
    heldMemberIds: canonical([...held], order),
    failureConstraints,
    interactionSets,
    probes,
    dependencyClosed: true,
    provenByExactProbe: false,
    status: "unresolved",
  };
}
