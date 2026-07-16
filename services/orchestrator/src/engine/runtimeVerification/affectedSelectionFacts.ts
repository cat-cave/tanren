import { z } from "zod";
import type { BehaviorRevisionId } from "../contracts/behaviorRevision.js";
import { canonicalJson, parseDigest, type CanonicalBody, type CasByteStore, type Digest } from "../contracts/cas.js";
import type { BehaviorCoverageEdgeId } from "../contracts/runtimeVerification.js";
import type { EventStore } from "../eventStore.js";
import type { EventPayload } from "../events/index.js";
import {
  AFFECTED_TARGET_KINDS,
  boundCoverageSnapshotsEqual,
  canonicalCoverageSnapshot,
  COVERAGE_EDGE_KINDS,
  selectAffectedBehaviorRevisions,
  type AffectedSelectionV1,
  type BoundBehaviorCoverageSnapshot,
} from "./affectedSelection.js";

export const AFFECTED_SELECTION_FACT_MEDIA_TYPE = "application/vnd.tanren.behavior-coverage-selection.v1+json";

const DigestSchema = z.string().transform((value, context) => {
  try {
    return parseDigest(value);
  } catch {
    context.addIssue({ code: "custom", message: "expected sha256 digest" });
    return z.NEVER;
  }
});
const BehaviorRevisionIdSchema = z
  .string()
  .min(1)
  .transform((value) => value as BehaviorRevisionId);
const CoverageEdgeIdSchema = z
  .string()
  .min(1)
  .transform((value) => value as BehaviorCoverageEdgeId);
const AffectedTargetSchema = z
  .object({ kind: z.enum(AFFECTED_TARGET_KINDS), targetRef: z.string().min(1).max(2_000) })
  .strict();
const CoverageEdgeSchema = z
  .object({
    id: CoverageEdgeIdSchema,
    kind: z.enum(COVERAGE_EDGE_KINDS),
    targetRef: z.string().min(1).max(2_000),
  })
  .strict();
const CoverageSubjectSchema = z
  .object({
    behaviorRevisionId: BehaviorRevisionIdSchema,
    contentDigest: DigestSchema,
    title: z.string(),
    edges: z.array(CoverageEdgeSchema),
  })
  .strict();
const CoverageSnapshotSchema = z
  .object({
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    behaviors: z.array(CoverageSubjectSchema),
  })
  .strict();
const IntegrationBindingSchema = z
  .object({
    integrationNodeId: z.string().min(1),
    preparedHeadSha: z.string().regex(/^[0-9a-f]{40}$/u),
    treeHash: z.string().min(1),
    memberKey: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

const SelectionReasonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct_edge"), edgeId: CoverageEdgeIdSchema, target: AffectedTargetSchema }).strict(),
  z
    .object({
      kind: z.literal("transitive_dependency"),
      edgeId: CoverageEdgeIdSchema,
      dependencyBehaviorRevisionId: BehaviorRevisionIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("unknown_target"), target: AffectedTargetSchema }).strict(),
  z.object({ kind: z.literal("uncovered_behavior") }).strict(),
  z
    .object({
      kind: z.literal("dangling_dependency"),
      edgeId: CoverageEdgeIdSchema,
      targetRef: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("no_changed_targets") }).strict(),
]);
const SelectionResultSchema = z
  .object({
    version: z.literal("v1"),
    mode: z.enum(["targeted", "expanded_unknown", "no_active_behaviors"]),
    changedTargets: z.array(AffectedTargetSchema).max(500),
    unknownTargets: z.array(AffectedTargetSchema).max(500),
    selected: z.array(
      z
        .object({
          behaviorRevisionId: BehaviorRevisionIdSchema,
          reasons: z.array(SelectionReasonSchema).min(1),
        })
        .strict(),
    ),
    excluded: z.array(
      z
        .object({
          behaviorRevisionId: BehaviorRevisionIdSchema,
          reason: z.literal("no_reachable_changed_target"),
          inspectedEdgeIds: z.array(CoverageEdgeIdSchema).min(1),
        })
        .strict(),
    ),
  })
  .strict();

export const AffectedSelectionFactSchema = z
  .object({
    factVersion: z.literal("behavior_coverage_selection_fact.v1"),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    binding: IntegrationBindingSchema,
    snapshot: CoverageSnapshotSchema,
    selection: SelectionResultSchema,
  })
  .strict();

export type AffectedSelectionFactV1 = z.infer<typeof AffectedSelectionFactSchema>;

export class AffectedSelectionFactCorruptError extends Error {
  public override readonly name = "AffectedSelectionFactCorruptError";
}

function canonicalBody(value: unknown): CanonicalBody {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AffectedSelectionFactCorruptError("non-finite canonical number");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalBody(item));
  if (typeof value === "object") {
    const result: Record<string, CanonicalBody> = {};
    for (const [key, item] of Object.entries(value)) result[key] = canonicalBody(item);
    return result;
  }
  throw new AffectedSelectionFactCorruptError(`unsupported canonical value: ${typeof value}`);
}

function assertFactConsistent(fact: AffectedSelectionFactV1): AffectedSelectionFactV1 {
  if (fact.orgId !== fact.snapshot.orgId || fact.projectId !== fact.snapshot.projectId) {
    throw new AffectedSelectionFactCorruptError("fact scope does not match graph scope");
  }
  const canonicalSnapshot = canonicalCoverageSnapshot(fact.snapshot);
  const bound = { binding: fact.binding, snapshot: fact.snapshot };
  if (!boundCoverageSnapshotsEqual(bound, { binding: fact.binding, snapshot: canonicalSnapshot })) {
    throw new AffectedSelectionFactCorruptError("fact graph is not canonical");
  }
  const expected = selectAffectedBehaviorRevisions({
    snapshot: canonicalSnapshot,
    changedTargets: fact.selection.changedTargets,
  });
  if (canonicalJson(canonicalBody(expected)) !== canonicalJson(canonicalBody(fact.selection))) {
    throw new AffectedSelectionFactCorruptError("selection does not derive from the bound graph");
  }
  return fact;
}

export function buildAffectedSelectionFact(input: {
  readonly bound: BoundBehaviorCoverageSnapshot;
  readonly selection: ReturnType<typeof selectAffectedBehaviorRevisions>;
}): AffectedSelectionFactV1 {
  const parsed = AffectedSelectionFactSchema.parse({
    factVersion: "behavior_coverage_selection_fact.v1",
    orgId: input.bound.snapshot.orgId,
    projectId: input.bound.snapshot.projectId,
    binding: input.bound.binding,
    snapshot: input.bound.snapshot,
    selection: input.selection,
  });
  return assertFactConsistent(parsed);
}

export function encodeAffectedSelectionFact(fact: AffectedSelectionFactV1): Uint8Array {
  const parsed = assertFactConsistent(AffectedSelectionFactSchema.parse(fact));
  return new TextEncoder().encode(canonicalJson(canonicalBody(parsed)));
}

export function decodeAffectedSelectionFact(bytes: Uint8Array): AffectedSelectionFactV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new AffectedSelectionFactCorruptError("fact bytes are not canonical UTF-8 JSON");
  }
  const parsed = AffectedSelectionFactSchema.safeParse(raw);
  if (!parsed.success) throw new AffectedSelectionFactCorruptError("fact JSON violates the v1 schema");
  const fact = assertFactConsistent(parsed.data);
  if (canonicalJson(canonicalBody(fact)) !== new TextDecoder().decode(bytes)) {
    throw new AffectedSelectionFactCorruptError("fact bytes are not in canonical JSON form");
  }
  return fact;
}

function materializeSelection(fact: AffectedSelectionFactV1, analysisId: Digest): AffectedSelectionV1 {
  return {
    ...fact.selection,
    analysisId,
    orgId: fact.orgId,
    projectId: fact.projectId,
    binding: fact.binding,
  };
}

export async function persistAffectedSelectionFact(
  cas: CasByteStore,
  fact: AffectedSelectionFactV1,
): Promise<AffectedSelectionV1> {
  const artifact = await cas.put({
    orgId: fact.orgId,
    bytes: encodeAffectedSelectionFact(fact),
    mediaType: AFFECTED_SELECTION_FACT_MEDIA_TYPE,
  });
  if (artifact.mediaType !== AFFECTED_SELECTION_FACT_MEDIA_TYPE) {
    throw new AffectedSelectionFactCorruptError("CAS digest is already bound to another media type");
  }
  return materializeSelection(fact, artifact.digest);
}

export function affectedSelectionEventPayload(
  selection: AffectedSelectionV1,
): EventPayload<"behavior.coverage.selection_analyzed"> {
  return {
    version: selection.version,
    analysisId: selection.analysisId,
    mode: selection.mode,
    changedTargets: selection.changedTargets.map((target) => ({ ...target })),
    unknownTargets: selection.unknownTargets.map((target) => ({ ...target })),
    selected: selection.selected.map((behavior) => ({
      behaviorRevisionId: behavior.behaviorRevisionId,
      reasons: behavior.reasons.map((reason) => {
        if (reason.kind === "direct_edge" || reason.kind === "unknown_target") {
          return { ...reason, target: { ...reason.target } };
        }
        return { ...reason };
      }),
    })),
    excluded: selection.excluded.map((behavior) => ({
      ...behavior,
      inspectedEdgeIds: [...behavior.inspectedEdgeIds],
    })),
  };
}

export async function appendAffectedSelectionEvent(
  events: EventStore,
  selection: AffectedSelectionV1,
  context: { readonly runId?: string; readonly specId?: string } = {},
): Promise<void> {
  await events.append({
    orgId: selection.orgId,
    projectId: selection.projectId,
    ...(context.runId === undefined ? {} : { runId: context.runId }),
    ...(context.specId === undefined ? {} : { specId: context.specId }),
    eventType: "behavior.coverage.selection_analyzed",
    payload: affectedSelectionEventPayload(selection),
  });
}

export function selectionFromFact(fact: AffectedSelectionFactV1, analysisId: Digest): AffectedSelectionV1 {
  return materializeSelection(assertFactConsistent(fact), analysisId);
}
