import type { BehaviorRevisionId } from "../contracts/behaviorRevision.js";
import type { BehaviorCoverageEdgeId } from "../contracts/runtimeVerification.js";

export const COVERAGE_EDGE_KINDS = ["spec", "source", "component", "integration", "design", "dependency"] as const;
export type CoverageEdgeKind = (typeof COVERAGE_EDGE_KINDS)[number];

export const AFFECTED_TARGET_KINDS = ["spec", "source", "component", "integration", "design"] as const;
export type AffectedTargetKind = (typeof AFFECTED_TARGET_KINDS)[number];

export interface AffectedTarget {
  readonly kind: AffectedTargetKind;
  readonly targetRef: string;
}

export interface BehaviorCoverageEdge {
  readonly id: BehaviorCoverageEdgeId;
  readonly kind: CoverageEdgeKind;
  readonly targetRef: string;
}

export interface BehaviorCoverageSubject {
  readonly behaviorRevisionId: BehaviorRevisionId;
  readonly title: string;
  readonly edges: readonly BehaviorCoverageEdge[];
}

export interface BehaviorCoverageSnapshot {
  readonly orgId: string;
  readonly projectId: string;
  readonly behaviors: readonly BehaviorCoverageSubject[];
}

export type AffectedSelectionReason =
  | { readonly kind: "direct_edge"; readonly edgeId: BehaviorCoverageEdgeId; readonly target: AffectedTarget }
  | {
      readonly kind: "transitive_dependency";
      readonly edgeId: BehaviorCoverageEdgeId;
      readonly dependencyBehaviorRevisionId: BehaviorRevisionId;
    }
  | { readonly kind: "unknown_target"; readonly target: AffectedTarget }
  | { readonly kind: "uncovered_behavior" }
  | { readonly kind: "dangling_dependency"; readonly edgeId: BehaviorCoverageEdgeId; readonly targetRef: string }
  | { readonly kind: "no_changed_targets" };

export interface SelectedBehaviorRevision {
  readonly behaviorRevisionId: BehaviorRevisionId;
  readonly reasons: readonly AffectedSelectionReason[];
}

export interface ExcludedBehaviorRevision {
  readonly behaviorRevisionId: BehaviorRevisionId;
  readonly reason: "no_reachable_changed_target";
  readonly inspectedEdgeIds: readonly BehaviorCoverageEdgeId[];
}

export interface AffectedSelectionV1 {
  readonly version: "v1";
  readonly analysisId: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly mode: "targeted" | "expanded_unknown" | "no_active_behaviors";
  readonly changedTargets: readonly AffectedTarget[];
  readonly unknownTargets: readonly AffectedTarget[];
  readonly selected: readonly SelectedBehaviorRevision[];
  readonly excluded: readonly ExcludedBehaviorRevision[];
}

export class BehaviorCoverageGraphCorruptError extends Error {
  public override readonly name = "BehaviorCoverageGraphCorruptError";
}

function targetKey(target: AffectedTarget): string {
  return `${target.kind}\u0000${target.targetRef}`;
}

function canonicalTargets(targets: readonly AffectedTarget[]): AffectedTarget[] {
  const byKey = new Map<string, AffectedTarget>();
  for (const target of targets) {
    byKey.set(targetKey(target), target);
  }
  return [...byKey.values()].sort((left, right) => targetKey(left).localeCompare(targetKey(right)));
}

function reasonKey(reason: AffectedSelectionReason): string {
  switch (reason.kind) {
    case "direct_edge":
      return `0:${reason.edgeId}:${targetKey(reason.target)}`;
    case "transitive_dependency":
      return `1:${reason.edgeId}:${reason.dependencyBehaviorRevisionId}`;
    case "unknown_target":
      return `2:${targetKey(reason.target)}`;
    case "uncovered_behavior":
      return "3";
    case "dangling_dependency":
      return `4:${reason.edgeId}:${reason.targetRef}`;
    case "no_changed_targets":
      return "5";
  }
  throw new Error("unreachable affected-selection reason");
}

function addReason(
  selected: Map<BehaviorRevisionId, Map<string, AffectedSelectionReason>>,
  behaviorRevisionId: BehaviorRevisionId,
  reason: AffectedSelectionReason,
): boolean {
  const alreadySelected = selected.has(behaviorRevisionId);
  const reasons = selected.get(behaviorRevisionId) ?? new Map<string, AffectedSelectionReason>();
  reasons.set(reasonKey(reason), reason);
  selected.set(behaviorRevisionId, reasons);
  return !alreadySelected;
}

function assertGraph(snapshot: BehaviorCoverageSnapshot): void {
  const behaviorIds = new Set<string>();
  const edgeOwners = new Map<string, string>();
  for (const behavior of snapshot.behaviors) {
    if (behaviorIds.has(behavior.behaviorRevisionId)) {
      throw new BehaviorCoverageGraphCorruptError(
        `duplicate behavior revision in coverage snapshot: ${behavior.behaviorRevisionId}`,
      );
    }
    behaviorIds.add(behavior.behaviorRevisionId);
    for (const edge of behavior.edges) {
      const owner = edgeOwners.get(edge.id);
      if (owner !== undefined && owner !== behavior.behaviorRevisionId) {
        throw new BehaviorCoverageGraphCorruptError(
          `coverage edge ${edge.id} is attached to both ${owner} and ${behavior.behaviorRevisionId}`,
        );
      }
      edgeOwners.set(edge.id, behavior.behaviorRevisionId);
    }
  }
}

function buildSelected(
  behaviors: readonly BehaviorCoverageSubject[],
  selected: ReadonlyMap<BehaviorRevisionId, ReadonlyMap<string, AffectedSelectionReason>>,
): SelectedBehaviorRevision[] {
  return behaviors
    .filter((behavior) => selected.has(behavior.behaviorRevisionId))
    .map((behavior) => ({
      behaviorRevisionId: behavior.behaviorRevisionId,
      reasons: [...(selected.get(behavior.behaviorRevisionId)?.values() ?? [])].sort((left, right) =>
        reasonKey(left).localeCompare(reasonKey(right)),
      ),
    }));
}

function buildExcluded(
  behaviors: readonly BehaviorCoverageSubject[],
  selected: ReadonlyMap<BehaviorRevisionId, unknown>,
): ExcludedBehaviorRevision[] {
  return behaviors
    .filter((behavior) => !selected.has(behavior.behaviorRevisionId))
    .map((behavior) => {
      const inspectedEdgeIds = [...new Set(behavior.edges.map((edge) => edge.id))].sort();
      if (inspectedEdgeIds.length === 0) {
        throw new BehaviorCoverageGraphCorruptError(
          `selector attempted to exclude uncovered behavior ${behavior.behaviorRevisionId}`,
        );
      }
      return {
        behaviorRevisionId: behavior.behaviorRevisionId,
        reason: "no_reachable_changed_target" as const,
        inspectedEdgeIds,
      };
    });
}

/**
 * Select the exact active behavior-revision set affected by changed targets.
 * Unknown targets expand to the full active set. Uncovered behavior revisions
 * and dangling dependency edges select themselves. A behavior is excluded only
 * with persisted edge ids proving the graph snapshot was actually inspected.
 */
export function selectAffectedBehaviorRevisions(input: {
  readonly analysisId: string;
  readonly snapshot: BehaviorCoverageSnapshot;
  readonly changedTargets: readonly AffectedTarget[];
}): AffectedSelectionV1 {
  assertGraph(input.snapshot);
  const behaviors = [...input.snapshot.behaviors].sort((left, right) =>
    left.behaviorRevisionId.localeCompare(right.behaviorRevisionId),
  );
  const changedTargets = canonicalTargets(input.changedTargets);
  if (behaviors.length === 0) {
    return {
      version: "v1",
      analysisId: input.analysisId,
      orgId: input.snapshot.orgId,
      projectId: input.snapshot.projectId,
      mode: "no_active_behaviors",
      changedTargets,
      unknownTargets: changedTargets,
      selected: [],
      excluded: [],
    };
  }

  const selected = new Map<BehaviorRevisionId, Map<string, AffectedSelectionReason>>();
  if (changedTargets.length === 0) {
    for (const behavior of behaviors) {
      addReason(selected, behavior.behaviorRevisionId, { kind: "no_changed_targets" });
    }
    return {
      version: "v1",
      analysisId: input.analysisId,
      orgId: input.snapshot.orgId,
      projectId: input.snapshot.projectId,
      mode: "expanded_unknown",
      changedTargets,
      unknownTargets: [],
      selected: buildSelected(behaviors, selected),
      excluded: [],
    };
  }

  const matchedTargetKeys = new Set<string>();
  for (const behavior of behaviors) {
    for (const edge of behavior.edges) {
      if (edge.kind === "dependency") continue;
      const matchingTarget = changedTargets.find(
        (target) => target.kind === edge.kind && target.targetRef === edge.targetRef,
      );
      if (matchingTarget === undefined) continue;
      matchedTargetKeys.add(targetKey(matchingTarget));
      addReason(selected, behavior.behaviorRevisionId, {
        kind: "direct_edge",
        edgeId: edge.id,
        target: matchingTarget,
      });
    }
  }

  const unknownTargets = changedTargets.filter((target) => !matchedTargetKeys.has(targetKey(target)));
  if (unknownTargets.length > 0) {
    for (const behavior of behaviors) {
      for (const target of unknownTargets) {
        addReason(selected, behavior.behaviorRevisionId, { kind: "unknown_target", target });
      }
    }
  }

  const activeIds = new Set(behaviors.map((behavior) => behavior.behaviorRevisionId));
  let expandedForGraphUnknown = unknownTargets.length > 0;
  for (const behavior of behaviors) {
    if (behavior.edges.length === 0) {
      expandedForGraphUnknown = true;
      addReason(selected, behavior.behaviorRevisionId, { kind: "uncovered_behavior" });
    }
    for (const edge of behavior.edges) {
      if (edge.kind !== "dependency") continue;
      const dependencyBehaviorRevisionId = edge.targetRef as BehaviorRevisionId;
      if (activeIds.has(dependencyBehaviorRevisionId)) continue;
      expandedForGraphUnknown = true;
      addReason(selected, behavior.behaviorRevisionId, {
        kind: "dangling_dependency",
        edgeId: edge.id,
        targetRef: edge.targetRef,
      });
    }
  }

  let grew = true;
  while (grew) {
    grew = false;
    for (const behavior of behaviors) {
      for (const edge of behavior.edges) {
        if (edge.kind !== "dependency") continue;
        const dependencyBehaviorRevisionId = edge.targetRef as BehaviorRevisionId;
        if (!selected.has(dependencyBehaviorRevisionId)) continue;
        grew =
          addReason(selected, behavior.behaviorRevisionId, {
            kind: "transitive_dependency",
            edgeId: edge.id,
            dependencyBehaviorRevisionId,
          }) || grew;
      }
    }
  }

  const excluded = buildExcluded(behaviors, selected);
  return {
    version: "v1",
    analysisId: input.analysisId,
    orgId: input.snapshot.orgId,
    projectId: input.snapshot.projectId,
    mode: expandedForGraphUnknown ? "expanded_unknown" : "targeted",
    changedTargets,
    unknownTargets,
    selected: buildSelected(behaviors, selected),
    excluded,
  };
}
