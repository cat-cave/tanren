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
    baseSha: z.string().regex(/^[0-9a-f]{40}$/u),
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

function fixedCodeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function targetKey(target: z.infer<typeof AffectedTargetSchema>): string {
  return `${target.kind}\u0000${target.targetRef}`;
}

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
    const changedTargets = new Set(selection.changedTargets.map(targetKey));
    const unknownTargets = new Set(selection.unknownTargets.map(targetKey));
    if (selected.size !== selection.selected.length || excluded.size !== selection.excluded.length) {
      context.addIssue({ code: "custom", message: "behavior identities must be unique" });
    }
    if (
      changedTargets.size !== selection.changedTargets.length ||
      unknownTargets.size !== selection.unknownTargets.length
    ) {
      context.addIssue({ code: "custom", message: "target identities must be unique" });
    }
    if ([...selected].some((id) => excluded.has(id))) {
      context.addIssue({ code: "custom", message: "selected and excluded sets must be disjoint" });
    }
    if ([...unknownTargets].some((target) => !changedTargets.has(target))) {
      context.addIssue({
        code: "custom",
        path: ["unknownTargets"],
        message: "unknown targets must be changed targets",
      });
    }

    const edgeOwners = new Map<string, string>();
    const edgeClaims = new Map<string, string>();
    const directTargets = new Set<string>();
    let wideningReasonCount = 0;
    for (const [rowIndex, row] of selection.selected.entries()) {
      const reasonKeys = new Set<string>();
      for (const [reasonIndex, reason] of row.reasons.entries()) {
        const path: PropertyKey[] = ["selected", rowIndex, "reasons", reasonIndex];
        const key = JSON.stringify(reason);
        if (reasonKeys.has(key)) context.addIssue({ code: "custom", path, message: "duplicate selection reason" });
        reasonKeys.add(key);
        if (
          reason.kind === "direct_edge" ||
          reason.kind === "transitive_dependency" ||
          reason.kind === "dangling_dependency"
        ) {
          const owner = edgeOwners.get(reason.edgeId);
          const claim = JSON.stringify(reason);
          if (owner !== undefined && owner !== row.behaviorRevisionId) {
            context.addIssue({ code: "custom", path, message: "edge identity belongs to another behavior" });
          }
          if (edgeClaims.has(reason.edgeId) && edgeClaims.get(reason.edgeId) !== claim) {
            context.addIssue({ code: "custom", path, message: "edge identity has contradictory reason evidence" });
          }
          edgeOwners.set(reason.edgeId, row.behaviorRevisionId);
          edgeClaims.set(reason.edgeId, claim);
        }
        if (reason.kind === "direct_edge") {
          const target = targetKey(reason.target);
          directTargets.add(target);
          if (!changedTargets.has(target) || unknownTargets.has(target)) {
            context.addIssue({ code: "custom", path, message: "direct edge target contradicts target sets" });
          }
        } else if (reason.kind === "transitive_dependency") {
          if (
            !selected.has(reason.dependencyBehaviorRevisionId) ||
            reason.dependencyBehaviorRevisionId === row.behaviorRevisionId
          ) {
            context.addIssue({
              code: "custom",
              path,
              message: "transitive dependency must name another selected behavior",
            });
          }
        } else if (reason.kind === "unknown_target") {
          wideningReasonCount += 1;
          if (!unknownTargets.has(targetKey(reason.target))) {
            context.addIssue({ code: "custom", path, message: "unknown reason target is not declared unknown" });
          }
        } else if (reason.kind === "no_changed_targets") {
          wideningReasonCount += 1;
          if (selection.changedTargets.length > 0) {
            context.addIssue({ code: "custom", path, message: "no-target reason contradicts changed targets" });
          }
        } else {
          wideningReasonCount += 1;
        }
      }
    }
    for (const [rowIndex, row] of selection.excluded.entries()) {
      const uniqueEdges = new Set(row.inspectedEdgeIds);
      if (uniqueEdges.size !== row.inspectedEdgeIds.length) {
        context.addIssue({
          code: "custom",
          path: ["excluded", rowIndex],
          message: "inspected edge identities must be unique",
        });
      }
      for (const edgeId of uniqueEdges) {
        const owner = edgeOwners.get(edgeId);
        if (owner !== undefined && owner !== row.behaviorRevisionId) {
          context.addIssue({
            code: "custom",
            path: ["excluded", rowIndex],
            message: "edge identity crosses behavior rows",
          });
        }
        edgeOwners.set(edgeId, row.behaviorRevisionId);
      }
    }

    if (selection.mode === "targeted") {
      if (selection.changedTargets.length === 0 || selection.unknownTargets.length > 0 || wideningReasonCount > 0) {
        context.addIssue({
          code: "custom",
          path: ["mode"],
          message: "targeted mode requires sealed, non-widened targets",
        });
      }
      if (selection.selected.length === 0 || [...changedTargets].some((target) => !directTargets.has(target))) {
        context.addIssue({
          code: "custom",
          path: ["selected"],
          message: "every targeted change needs direct-edge evidence",
        });
      }
    } else if (selection.mode === "expanded_unknown") {
      if (selection.selected.length === 0 || selection.excluded.length > 0 || wideningReasonCount === 0) {
        context.addIssue({
          code: "custom",
          path: ["mode"],
          message: "expanded mode must widen every active behavior with evidence",
        });
      }
      for (const [rowIndex, row] of selection.selected.entries()) {
        const rowUnknowns = new Set(
          row.reasons.filter((reason) => reason.kind === "unknown_target").map((reason) => targetKey(reason.target)),
        );
        if ([...unknownTargets].some((target) => !rowUnknowns.has(target))) {
          context.addIssue({
            code: "custom",
            path: ["selected", rowIndex],
            message: "unknown target did not widen this behavior",
          });
        }
        if (
          selection.changedTargets.length === 0 &&
          !row.reasons.some((reason) => reason.kind === "no_changed_targets")
        ) {
          context.addIssue({
            code: "custom",
            path: ["selected", rowIndex],
            message: "empty-target expansion lacks its reason",
          });
        }
      }
    } else {
      if (selection.selected.length > 0 || selection.excluded.length > 0) {
        context.addIssue({ code: "custom", path: ["mode"], message: "no-active mode cannot contain behaviors" });
      }
      if (
        changedTargets.size !== unknownTargets.size ||
        [...changedTargets].some((target) => !unknownTargets.has(target))
      ) {
        context.addIssue({
          code: "custom",
          path: ["unknownTargets"],
          message: "no-active mode treats every change as unknown",
        });
      }
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
        .sort(fixedCodeUnitCompare);
      const claimed = [...graph.uncoveredBehaviorRevisionIds].sort(fixedCodeUnitCompare);
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
