import { z } from "zod";
import { AFFECTED_TARGET_KINDS } from "../../runtimeVerification/affectedSelection.js";

const AffectedTargetPayload = z
  .object({
    kind: z.enum(AFFECTED_TARGET_KINDS),
    targetRef: z.string().min(1).max(2_000),
  })
  .strict();

const SelectionReasonPayload = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("direct_edge"),
      edgeId: z.string().min(1),
      target: AffectedTargetPayload,
    })
    .strict(),
  z
    .object({
      kind: z.literal("transitive_dependency"),
      edgeId: z.string().min(1),
      dependencyBehaviorRevisionId: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("unknown_target"), target: AffectedTargetPayload }).strict(),
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

/** Durable, replayable affected-selection proof; org/project live on the event row. */
export const BehaviorCoverageSelectionAnalyzedPayload = z
  .object({
    version: z.literal("v1"),
    analysisId: z.string().min(1),
    mode: z.enum(["targeted", "expanded_unknown", "no_active_behaviors"]),
    changedTargets: z.array(AffectedTargetPayload).max(500),
    unknownTargets: z.array(AffectedTargetPayload).max(500),
    selected: z.array(
      z
        .object({
          behaviorRevisionId: z.string().min(1),
          reasons: z.array(SelectionReasonPayload).min(1),
        })
        .strict(),
    ),
    excluded: z.array(
      z
        .object({
          behaviorRevisionId: z.string().min(1),
          reason: z.literal("no_reachable_changed_target"),
          inspectedEdgeIds: z.array(z.string().min(1)).min(1),
        })
        .strict(),
    ),
  })
  .strict();

export const runtimeVerificationEventRegistry = {
  "behavior.coverage.selection_analyzed": BehaviorCoverageSelectionAnalyzedPayload,
} as const satisfies Record<string, z.ZodTypeAny>;
