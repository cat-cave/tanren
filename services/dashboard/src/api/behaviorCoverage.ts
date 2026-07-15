import { z } from "zod";

export const CoverageEdgeKindSchema = z.enum(["spec", "source", "component", "integration", "design", "dependency"]);
export const AffectedTargetKindSchema = z.enum(["spec", "source", "component", "integration", "design"]);

const AffectedTargetSchema = z
  .object({
    kind: AffectedTargetKindSchema,
    targetRef: z.string().min(1),
  })
  .strict();

const CoverageEdgeSchema = z
  .object({
    id: z.string().min(1),
    kind: CoverageEdgeKindSchema,
    targetRef: z.string().min(1),
  })
  .strict();

const CoverageBehaviorSchema = z
  .object({
    behaviorRevisionId: z.string().min(1),
    title: z.string(),
    edges: z.array(CoverageEdgeSchema),
  })
  .strict();

export const BehaviorCoverageSnapshotSchema = z
  .object({
    version: z.literal("v1"),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    behaviors: z.array(CoverageBehaviorSchema),
    uncoveredBehaviorRevisionIds: z.array(z.string().min(1)),
  })
  .strict();

const SelectionReasonSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("direct_edge"),
      edgeId: z.string().min(1),
      target: AffectedTargetSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("transitive_dependency"),
      edgeId: z.string().min(1),
      dependencyBehaviorRevisionId: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("unknown_target"), target: AffectedTargetSchema }).strict(),
  z.object({ kind: z.literal("uncovered_behavior") }).strict(),
  z
    .object({
      kind: z.literal("dangling_dependency"),
      edgeId: z.string().min(1),
      targetRef: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("no_changed_targets") }).strict(),
]);

const SelectedBehaviorSchema = z
  .object({
    behaviorRevisionId: z.string().min(1),
    reasons: z.array(SelectionReasonSchema).min(1),
  })
  .strict();

const ExcludedBehaviorSchema = z
  .object({
    behaviorRevisionId: z.string().min(1),
    reason: z.literal("no_reachable_changed_target"),
    inspectedEdgeIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const AffectedSelectionSchema = z
  .object({
    version: z.literal("v1"),
    analysisId: z.string().min(1),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    mode: z.enum(["targeted", "expanded_unknown", "no_active_behaviors"]),
    changedTargets: z.array(AffectedTargetSchema),
    unknownTargets: z.array(AffectedTargetSchema),
    selected: z.array(SelectedBehaviorSchema),
    excluded: z.array(ExcludedBehaviorSchema),
  })
  .strict();

export const AffectedSelectionResponseSchema = z.object({ selection: AffectedSelectionSchema }).strict();

export type CoverageEdgeKind = z.infer<typeof CoverageEdgeKindSchema>;
export type AffectedTargetKind = z.infer<typeof AffectedTargetKindSchema>;
export type BehaviorCoverageSnapshot = z.infer<typeof BehaviorCoverageSnapshotSchema>;
export type AffectedSelection = z.infer<typeof AffectedSelectionSchema>;

export interface AffectedSelectionWriteResult {
  ok: boolean;
  status: number;
  selection?: AffectedSelection;
}
