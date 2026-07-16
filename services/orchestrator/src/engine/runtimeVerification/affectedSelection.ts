import type { BehaviorRevisionId } from "../contracts/behaviorRevision.js";
import { canonicalJson, contentDigestOf, parseDigest, type CanonicalBody, type Digest } from "../contracts/cas.js";
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
  readonly contentDigest: Digest;
  readonly title: string;
  readonly edges: readonly BehaviorCoverageEdge[];
}

export interface BehaviorCoverageSnapshot {
  readonly orgId: string;
  readonly projectId: string;
  readonly behaviors: readonly BehaviorCoverageSubject[];
}

export interface CoverageIntegrationBinding {
  readonly integrationNodeId: string;
  readonly baseSha: string;
  readonly preparedHeadSha: string;
  readonly treeHash: string;
  readonly memberKey: string;
}

export interface BoundBehaviorCoverageSnapshot {
  readonly binding: CoverageIntegrationBinding;
  readonly snapshot: BehaviorCoverageSnapshot;
  readonly authorityFingerprint: string;
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

export interface AffectedSelectionResultV1 {
  readonly version: "v1";
  readonly mode: "targeted" | "expanded_unknown" | "no_active_behaviors";
  readonly changedTargets: readonly AffectedTarget[];
  readonly unknownTargets: readonly AffectedTarget[];
  readonly selected: readonly SelectedBehaviorRevision[];
  readonly excluded: readonly ExcludedBehaviorRevision[];
}

export interface AffectedSelectionV1 extends AffectedSelectionResultV1 {
  readonly analysisId: Digest;
  readonly orgId: string;
  readonly projectId: string;
  readonly binding: CoverageIntegrationBinding;
}

export class BehaviorCoverageGraphCorruptError extends Error {
  public override readonly name = "BehaviorCoverageGraphCorruptError";
}

function assertNever(value: never): never {
  throw new Error(`unreachable affected-selection variant: ${String(value)}`);
}

function targetKey(target: AffectedTarget): string {
  return `${target.kind}\u0000${target.targetRef}`;
}

export function fixedCodeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalTargets(targets: readonly AffectedTarget[]): AffectedTarget[] {
  const byKey = new Map<string, AffectedTarget>();
  for (const target of targets) byKey.set(targetKey(target), target);
  return [...byKey.values()].sort((left, right) => fixedCodeUnitCompare(targetKey(left), targetKey(right)));
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
  return assertNever(reason);
}

function addReason(
  selected: Map<BehaviorRevisionId, Map<string, AffectedSelectionReason>>,
  behaviorRevisionId: BehaviorRevisionId,
  reason: AffectedSelectionReason,
): boolean {
  const isNew = !selected.has(behaviorRevisionId);
  const reasons = selected.get(behaviorRevisionId) ?? new Map<string, AffectedSelectionReason>();
  reasons.set(reasonKey(reason), reason);
  selected.set(behaviorRevisionId, reasons);
  return isNew;
}

function canonicalBehaviors(snapshot: BehaviorCoverageSnapshot): BehaviorCoverageSubject[] {
  const behaviorIds = new Set<string>();
  const edgeIds = new Set<string>();
  const behaviors = [...snapshot.behaviors]
    .sort((left, right) => fixedCodeUnitCompare(left.behaviorRevisionId, right.behaviorRevisionId))
    .map((behavior) => {
      if (behaviorIds.has(behavior.behaviorRevisionId)) {
        throw new BehaviorCoverageGraphCorruptError(
          `duplicate behavior revision in coverage snapshot: ${behavior.behaviorRevisionId}`,
        );
      }
      behaviorIds.add(behavior.behaviorRevisionId);
      const edges = [...behavior.edges].sort((left, right) =>
        fixedCodeUnitCompare(
          `${left.kind}\u0000${left.targetRef}\u0000${left.id}`,
          `${right.kind}\u0000${right.targetRef}\u0000${right.id}`,
        ),
      );
      for (const edge of edges) {
        if (edgeIds.has(edge.id)) {
          throw new BehaviorCoverageGraphCorruptError(`duplicate coverage edge id: ${edge.id}`);
        }
        edgeIds.add(edge.id);
      }
      return { ...behavior, edges };
    });
  return behaviors;
}

const COVERAGE_AUTHORITY_FINGERPRINT_PREFIX = "rv4.coverage-authority.v1";
const COVERAGE_AUTHORITY_FINGERPRINT_PATTERN = new RegExp(
  `^${COVERAGE_AUTHORITY_FINGERPRINT_PREFIX.replaceAll(".", "\\.")}\\|(sha256:[0-9a-f]{64})\\|(sha256:[0-9a-f]{64})\\|(sha256:[0-9a-f]{64})$`,
  "u",
);

interface CoverageAuthorityDigests {
  readonly targetProvenanceDigest: Digest;
  readonly coverageGenerationDigest: Digest;
  readonly sealDigest: Digest;
}

function bindingBody(binding: CoverageIntegrationBinding): CanonicalBody {
  return {
    baseSha: binding.baseSha,
    integrationNodeId: binding.integrationNodeId,
    memberKey: binding.memberKey,
    preparedHeadSha: binding.preparedHeadSha,
    treeHash: binding.treeHash,
  };
}

function contentAddress(body: CanonicalBody): Digest {
  return contentDigestOf(new TextEncoder().encode(canonicalJson(body)));
}

function targetProvenanceDigest(input: {
  readonly binding: CoverageIntegrationBinding;
  readonly snapshot: BehaviorCoverageSnapshot;
  readonly changedTargets: readonly AffectedTarget[];
}): Digest {
  return contentAddress({
    version: "behavior_coverage_target_provenance.v1",
    orgId: input.snapshot.orgId,
    projectId: input.snapshot.projectId,
    binding: bindingBody(input.binding),
    changedTargets: canonicalTargets(input.changedTargets).map((target) => ({ ...target })),
  });
}

function coverageGenerationDigest(input: {
  readonly binding: CoverageIntegrationBinding;
  readonly snapshot: BehaviorCoverageSnapshot;
}): Digest {
  const snapshot = canonicalCoverageSnapshot(input.snapshot);
  return contentAddress({
    version: "behavior_coverage_generation.v1",
    orgId: snapshot.orgId,
    projectId: snapshot.projectId,
    binding: bindingBody(input.binding),
    behaviors: snapshot.behaviors.map((behavior) => ({
      behaviorRevisionId: behavior.behaviorRevisionId,
      contentDigest: behavior.contentDigest,
      title: behavior.title,
      edges: behavior.edges.map((edge) => ({ ...edge })),
    })),
  });
}

function authoritySealDigest(input: {
  readonly binding: CoverageIntegrationBinding;
  readonly snapshot: BehaviorCoverageSnapshot;
  readonly targetProvenanceDigest: Digest;
  readonly coverageGenerationDigest: Digest;
}): Digest {
  return contentAddress({
    version: "behavior_coverage_authority_seal.v1",
    orgId: input.snapshot.orgId,
    projectId: input.snapshot.projectId,
    binding: bindingBody(input.binding),
    targetProvenanceDigest: input.targetProvenanceDigest,
    coverageGenerationDigest: input.coverageGenerationDigest,
  });
}

function authorityDigests(input: {
  readonly binding: CoverageIntegrationBinding;
  readonly snapshot: BehaviorCoverageSnapshot;
  readonly changedTargets: readonly AffectedTarget[];
}): CoverageAuthorityDigests {
  const targetDigest = targetProvenanceDigest(input);
  const graphDigest = coverageGenerationDigest(input);
  return {
    targetProvenanceDigest: targetDigest,
    coverageGenerationDigest: graphDigest,
    sealDigest: authoritySealDigest({
      binding: input.binding,
      snapshot: input.snapshot,
      targetProvenanceDigest: targetDigest,
      coverageGenerationDigest: graphDigest,
    }),
  };
}

/** Only an integration-node materializer may stamp this affected fingerprint. */
export function buildCoverageAuthorityFingerprint(input: {
  readonly binding: CoverageIntegrationBinding;
  readonly snapshot: BehaviorCoverageSnapshot;
  readonly changedTargets: readonly AffectedTarget[];
}): string {
  const digests = authorityDigests(input);
  return [
    COVERAGE_AUTHORITY_FINGERPRINT_PREFIX,
    digests.targetProvenanceDigest,
    digests.coverageGenerationDigest,
    digests.sealDigest,
  ].join("|");
}

function parseAuthorityFingerprint(value: string): CoverageAuthorityDigests | undefined {
  const match = COVERAGE_AUTHORITY_FINGERPRINT_PATTERN.exec(value);
  if (match === null) return undefined;
  return {
    targetProvenanceDigest: parseDigest(match[1]!),
    coverageGenerationDigest: parseDigest(match[2]!),
    sealDigest: parseDigest(match[3]!),
  };
}

function evaluateCoverageAuthority(input: {
  readonly bound: BoundBehaviorCoverageSnapshot;
  readonly changedTargets: readonly AffectedTarget[];
}): { readonly targetProvenanceSealed: boolean; readonly coverageGenerationSealed: boolean } {
  const claimed = parseAuthorityFingerprint(input.bound.authorityFingerprint);
  if (claimed === undefined) return { targetProvenanceSealed: false, coverageGenerationSealed: false };
  const claimedSeal = authoritySealDigest({
    binding: input.bound.binding,
    snapshot: input.bound.snapshot,
    targetProvenanceDigest: claimed.targetProvenanceDigest,
    coverageGenerationDigest: claimed.coverageGenerationDigest,
  });
  if (claimedSeal !== claimed.sealDigest) {
    return { targetProvenanceSealed: false, coverageGenerationSealed: false };
  }
  const expected = authorityDigests({
    binding: input.bound.binding,
    snapshot: input.bound.snapshot,
    changedTargets: input.changedTargets,
  });
  return {
    targetProvenanceSealed: claimed.targetProvenanceDigest === expected.targetProvenanceDigest,
    coverageGenerationSealed: claimed.coverageGenerationDigest === expected.coverageGenerationDigest,
  };
}

export function canonicalCoverageSnapshot(snapshot: BehaviorCoverageSnapshot): BehaviorCoverageSnapshot {
  if (snapshot.orgId === "" || snapshot.projectId === "") {
    throw new BehaviorCoverageGraphCorruptError("coverage snapshot scope must be non-empty");
  }
  return { orgId: snapshot.orgId, projectId: snapshot.projectId, behaviors: canonicalBehaviors(snapshot) };
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
        fixedCodeUnitCompare(reasonKey(left), reasonKey(right)),
      ),
    }));
}

function expandedSelection(
  behaviors: readonly BehaviorCoverageSubject[],
  selected: ReadonlyMap<BehaviorRevisionId, ReadonlyMap<string, AffectedSelectionReason>>,
  changedTargets: readonly AffectedTarget[],
  unknownTargets: readonly AffectedTarget[],
): AffectedSelectionResultV1 {
  return {
    version: "v1",
    mode: "expanded_unknown",
    changedTargets,
    unknownTargets,
    selected: buildSelected(behaviors, selected),
    excluded: [],
  };
}

function buildExcluded(
  behaviors: readonly BehaviorCoverageSubject[],
  selected: ReadonlyMap<BehaviorRevisionId, unknown>,
): ExcludedBehaviorRevision[] {
  return behaviors
    .filter((behavior) => !selected.has(behavior.behaviorRevisionId))
    .map((behavior) => {
      const inspectedEdgeIds = [...new Set(behavior.edges.map((edge) => edge.id))].sort(fixedCodeUnitCompare);
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

/** Unknown impact expands; every omission carries sealed edge evidence. */
export function selectAffectedBehaviorRevisions(input: {
  readonly bound: BoundBehaviorCoverageSnapshot;
  readonly changedTargets: readonly AffectedTarget[];
}): AffectedSelectionResultV1 {
  const snapshot = canonicalCoverageSnapshot(input.bound.snapshot);
  const behaviors = snapshot.behaviors;
  const changedTargets = canonicalTargets(input.changedTargets);
  if (behaviors.length === 0) {
    return {
      version: "v1",
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
    return expandedSelection(behaviors, selected, changedTargets, []);
  }

  const authority = evaluateCoverageAuthority({ bound: { ...input.bound, snapshot }, changedTargets });
  if (!authority.targetProvenanceSealed) {
    for (const behavior of behaviors) {
      for (const target of changedTargets) {
        addReason(selected, behavior.behaviorRevisionId, { kind: "unknown_target", target });
      }
    }
    return expandedSelection(behaviors, selected, changedTargets, changedTargets);
  }
  if (!authority.coverageGenerationSealed) {
    for (const behavior of behaviors) {
      addReason(selected, behavior.behaviorRevisionId, { kind: "uncovered_behavior" });
    }
    return expandedSelection(behaviors, selected, changedTargets, []);
  }

  const activeIds = new Set(behaviors.map((behavior) => behavior.behaviorRevisionId));
  let graphIncomplete = false;
  for (const behavior of behaviors) {
    if (behavior.edges.length === 0) {
      graphIncomplete = true;
      addReason(selected, behavior.behaviorRevisionId, { kind: "uncovered_behavior" });
    }
    for (const edge of behavior.edges) {
      if (edge.kind !== "dependency" || activeIds.has(edge.targetRef as BehaviorRevisionId)) continue;
      graphIncomplete = true;
      addReason(selected, behavior.behaviorRevisionId, {
        kind: "dangling_dependency",
        edgeId: edge.id,
        targetRef: edge.targetRef,
      });
    }
  }
  if (graphIncomplete) {
    for (const behavior of behaviors) {
      for (const target of changedTargets) {
        addReason(selected, behavior.behaviorRevisionId, { kind: "unknown_target", target });
      }
    }
    return expandedSelection(behaviors, selected, changedTargets, changedTargets);
  }

  const targetByKey = new Map(changedTargets.map((target) => [targetKey(target), target]));
  const matchedTargetKeys = new Set<string>();
  for (const behavior of behaviors) {
    for (const edge of behavior.edges) {
      if (edge.kind === "dependency") continue;
      const key = targetKey({ kind: edge.kind, targetRef: edge.targetRef });
      const target = targetByKey.get(key);
      if (target === undefined) continue;
      matchedTargetKeys.add(key);
      addReason(selected, behavior.behaviorRevisionId, { kind: "direct_edge", edgeId: edge.id, target });
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

  let grew = true;
  while (grew) {
    grew = false;
    for (const behavior of behaviors) {
      for (const edge of behavior.edges) {
        if (edge.kind !== "dependency" || !selected.has(edge.targetRef as BehaviorRevisionId)) continue;
        grew =
          addReason(selected, behavior.behaviorRevisionId, {
            kind: "transitive_dependency",
            edgeId: edge.id,
            dependencyBehaviorRevisionId: edge.targetRef as BehaviorRevisionId,
          }) || grew;
      }
    }
  }

  return {
    version: "v1",
    mode: unknownTargets.length > 0 ? "expanded_unknown" : "targeted",
    changedTargets,
    unknownTargets,
    selected: buildSelected(behaviors, selected),
    excluded: buildExcluded(behaviors, selected),
  };
}

export function boundCoverageSnapshotsEqual(
  left: BoundBehaviorCoverageSnapshot,
  right: BoundBehaviorCoverageSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
