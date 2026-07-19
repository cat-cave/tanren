// mq-10 — RespecPacketV1: the FROZEN typed contract the merge-queue autonomous-repair
// router emits when an isolated member is at a PROVEN fixed point (the writer keeps
// producing the SAME audit findings with no magnitude reduction across generations).
//
// A RespecPacket is a STRUCTURED re-spec REQUEST — not a free-form retry. It routes the
// stuck spec to a DIFFERENT agent that may revise acceptance-criteria clarity, split the
// spec, or revise DAG dependencies. It can NEVER waive policy: `policyWaiverForbidden` is a
// literal `true` and the allowed revisions are an explicit closed set. The packet identity
// is a canonical content hash (`sha256:...`), matching the `respec_routes.packet_hash`
// column and the `RespecPacketV1.json` exportable artifact.

import { createHash } from "node:crypto";
import { z } from "zod";

export const RESPEC_PACKET_SCHEMA_VERSION = "respec_packet.v1" as const;

/**
 * The structured revisions a re-spec agent MAY make. It can revise the SPEC (clarify the
 * acceptance criteria, split it into smaller specs, or revise its DAG dependencies) — it can
 * NEVER waive a policy signal (an audit finding, a review gate, a budget cap). Policy is the
 * merge authority's, not the writer's, and a respec is a spec revision, not a policy bypass.
 */
export const RespecRevisionKindSchema = z.enum([
  "clarify_acceptance_criteria",
  "split_spec",
  "revise_dag_dependencies",
]);
export type RespecRevisionKind = z.infer<typeof RespecRevisionKindSchema>;

/** The proven-fixed-point evidence that justifies escalating from in-place repair to respec. */
const FixedPointEvidenceSchema = z
  .object({
    /** The stable failure signature (canonical reason codes + finding ids) that recurred. */
    failureSignature: z.string().min(1),
    /**
     * The recurring signatures across the attempt history that PROVE the fixed point — at
     * least two occurrences of the same non-shrinking state (a single failure is not a fixed
     * point; the convergence detector requires a recurrence across an intervening attempt).
     */
    repeatedSignatures: z.array(z.string().min(1)).min(2),
    findingIds: z.array(z.string().min(1)),
    reasonCodes: z.array(z.string().min(1)).min(1),
    /** The non-shrinking magnitude (finding count) — it did not converge toward zero. */
    magnitude: z.number().int().nonnegative(),
  })
  .strict();

export const RespecPacketV1Schema = z
  .object({
    version: z.literal(1),
    schemaVersion: z.literal(RESPEC_PACKET_SCHEMA_VERSION),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    /** The stuck spec whose intent survives — the respec re-authors a replacement of it. */
    sourceSpecId: z.string().min(1),
    /** The merge-queue evaluation group + evaluation that isolated the member. */
    groupId: z.string().min(1),
    evaluationId: z.string().min(1),
    /** The respec generation this packet mints (>= 1: the first respec is generation 1). */
    generation: z.number().int().positive(),
    /** The agent/model route that kept failing in place. */
    priorAgentRoute: z.string().min(1),
    /** A DIFFERENT agent/model route — the whole point of a respec is a fresh perspective. */
    nextAgentRoute: z.string().min(1),
    fixedPoint: FixedPointEvidenceSchema,
    /** The closed set of revisions the re-spec agent is authorized to make. */
    allowedRevisions: z.array(RespecRevisionKindSchema).min(1),
    /** A respec revises the spec; it can NEVER waive policy. */
    policyWaiverForbidden: z.literal(true),
    /** The exact counterexample / proof delta the re-spec agent must resolve. */
    counterexample: z.string().min(1),
  })
  .strict()
  .superRefine((packet, ctx) => {
    if (packet.priorAgentRoute === packet.nextAgentRoute) {
      ctx.addIssue({
        code: "custom",
        path: ["nextAgentRoute"],
        message: "a respec must route to a DIFFERENT agent than the one that reached the fixed point",
      });
    }
  });

export type RespecPacketV1 = z.infer<typeof RespecPacketV1Schema>;

/** Recursively key-sort a JSON value so the content hash is stable regardless of key order. */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((element) => canonicalValue(element));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalValue(v)]));
  }
  return value;
}

/** The stable `sha256:<hex>` content identity of a validated packet (= `respec_routes.packet_hash`). */
export function respecPacketHash(packet: RespecPacketV1): string {
  const bytes = JSON.stringify(canonicalValue(packet));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
