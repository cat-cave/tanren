import { z } from "zod";

export const CoverageEdgeKindSchema = z.enum(["spec", "source", "component", "integration", "design", "dependency"]);
export const AffectedTargetKindSchema = z.enum(["spec", "source", "component", "integration", "design"]);
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

const AffectedTargetSchema = z
  .object({ kind: AffectedTargetKindSchema, targetRef: z.string().min(1).max(2_000) })
  .strict();
const CoverageEdgeSchema = z
  .object({ id: z.string().min(1), kind: CoverageEdgeKindSchema, targetRef: z.string().min(1).max(2_000) })
  .strict();
const CoverageBehaviorSchema = z
  .object({
    behaviorRevisionId: z.string().min(1),
    contentDigest: DigestSchema,
    title: z.string(),
    edges: z.array(CoverageEdgeSchema),
  })
  .strict();
const CoverageBindingSchema = z
  .object({
    integrationNodeId: z.string().min(1),
    preparedHeadSha: z.string().regex(/^[0-9a-f]{40}$/u),
    treeHash: z.string().min(1),
    memberKey: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

const SelectionReasonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct_edge"), edgeId: z.string().min(1), target: AffectedTargetSchema }).strict(),
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
    .object({ kind: z.literal("dangling_dependency"), edgeId: z.string().min(1), targetRef: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal("no_changed_targets") }).strict(),
]);
const SelectedBehaviorSchema = z
  .object({ behaviorRevisionId: z.string().min(1), reasons: z.array(SelectionReasonSchema).min(1) })
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
    analysisId: DigestSchema,
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    binding: CoverageBindingSchema,
    mode: z.enum(["targeted", "expanded_unknown", "no_active_behaviors"]),
    changedTargets: z.array(AffectedTargetSchema).max(500),
    unknownTargets: z.array(AffectedTargetSchema).max(500),
    selected: z.array(SelectedBehaviorSchema),
    excluded: z.array(ExcludedBehaviorSchema),
  })
  .strict()
  .superRefine((selection, context) => {
    const selected = new Set(selection.selected.map((row) => row.behaviorRevisionId));
    const excluded = new Set(selection.excluded.map((row) => row.behaviorRevisionId));
    if (selected.size !== selection.selected.length || excluded.size !== selection.excluded.length) {
      context.addIssue({ code: "custom", message: "behavior identities must be unique" });
    }
    if ([...selected].some((id) => excluded.has(id))) {
      context.addIssue({ code: "custom", message: "selected and excluded sets must be disjoint" });
    }
    if (selection.mode === "targeted" && selection.unknownTargets.length > 0) {
      context.addIssue({ code: "custom", path: ["mode"], message: "targeted mode cannot contain unknown targets" });
    }
    if (selection.mode === "no_active_behaviors" && (selection.selected.length > 0 || selection.excluded.length > 0)) {
      context.addIssue({ code: "custom", path: ["mode"], message: "no-active mode cannot contain behaviors" });
    }
  });

const GraphStateSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("available"),
      behaviors: z.array(CoverageBehaviorSchema),
      uncoveredBehaviorRevisionIds: z.array(z.string().min(1)),
    })
    .strict()
    .superRefine((graph, context) => {
      const actual = graph.behaviors
        .filter((row) => row.edges.length === 0)
        .map((row) => row.behaviorRevisionId)
        .sort();
      const claimed = [...graph.uncoveredBehaviorRevisionIds].sort();
      if (JSON.stringify(actual) !== JSON.stringify(claimed)) {
        context.addIssue({ code: "custom", path: ["uncoveredBehaviorRevisionIds"], message: "uncovered set mismatch" });
      }
    }),
  z.object({ status: z.literal("unavailable") }).strict(),
]);
const LatestSelectionStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), selection: AffectedSelectionSchema }).strict(),
  z.object({ status: z.literal("none") }).strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
]);

export const BehaviorCoverageOverviewSchema = z
  .object({
    version: z.literal("v1"),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    graph: GraphStateSchema,
    latestSelection: LatestSelectionStateSchema,
  })
  .strict()
  .superRefine((overview, context) => {
    if (
      overview.latestSelection.status === "available" &&
      (overview.latestSelection.selection.orgId !== overview.orgId ||
        overview.latestSelection.selection.projectId !== overview.projectId)
    ) {
      context.addIssue({ code: "custom", path: ["latestSelection"], message: "selection scope mismatch" });
    }
  });

export const AffectedSelectionResponseSchema = z.object({ selection: AffectedSelectionSchema }).strict();
export const AffectedSelectionVerificationSchema = z
  .object({
    verification: z.object({ status: z.enum(["current", "stale"]), analysisId: DigestSchema }).strict(),
  })
  .strict();

export type AffectedTargetKind = z.infer<typeof AffectedTargetKindSchema>;
export type BehaviorCoverageOverview = z.infer<typeof BehaviorCoverageOverviewSchema>;
export type AffectedSelection = z.infer<typeof AffectedSelectionSchema>;

export interface AffectedSelectionWriteResult {
  readonly ok: boolean;
  readonly status: number;
  readonly selection?: AffectedSelection;
}

export interface AffectedSelectionVerifyResult {
  readonly ok: boolean;
  readonly status: number;
  readonly verification?: z.infer<typeof AffectedSelectionVerificationSchema>["verification"];
}
