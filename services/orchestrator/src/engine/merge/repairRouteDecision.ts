// cspell:ignore respecs
// mq-10 — the PURE autonomous-repair routing decision. Given an isolated member's failure
// classification + its prior repair-attempt history, decide EXHAUSTIVELY what to do:
//
//   - `repair_in_place`        — a deterministic content failure the writer can still fix in
//                                place (attributed findings, and NOT yet at a fixed point).
//   - `respec`                 — the SAME failure recurred with no magnitude reduction across
//                                an intervening attempt (a PROVEN fixed point per the
//                                convergence detector): emit a RespecPacketV1 to re-drive spec
//                                authoring on a DIFFERENT agent. NOT a retry cap — a
//                                progress-based fixed-point escalation.
//   - `blocked_needs_attention`— unclassifiable / unattributed / a non-repairable class reached
//                                the repair router: FAIL CLOSED to an explicit needs-attention
//                                disposition. Never a silent drop, never an infinite re-queue.
//
// The switch is EXHAUSTIVE (a `never` guard on the classification) so an unrecognized failure
// class can only fail closed to `blocked_needs_attention`.

import { assessStructuralProgress, type AttemptSignature } from "../workflow/convergenceDetector.js";
import {
  RespecPacketV1Schema,
  RESPEC_PACKET_SCHEMA_VERSION,
  type RespecPacketV1,
  type RespecRevisionKind,
} from "../contracts/respecPacket.js";

/**
 * The failure classes the router may receive. In production the embark only routes a
 * `member_failure` (always `deterministic_policy`) here; the other arms are defensive —
 * a non-repairable class that somehow reaches the repair router fails closed rather than
 * being repaired or respec'd.
 */
export type RepairFailureClassification =
  | "deterministic_policy"
  | "needs_product_decision"
  | "unknown_fail_closed"
  | "transient_infrastructure";

export interface RepairRouteContext {
  readonly orgId: string;
  readonly projectId: string;
  readonly sourceSpecId: string;
  readonly runId: string;
  readonly groupId: string;
  readonly evaluationId: string;
  readonly classification: RepairFailureClassification;
  readonly findingIds: ReadonlyArray<string>;
  readonly reasonCodes: ReadonlyArray<string>;
  /** The agent/model route that produced the failing attempt. */
  readonly priorAgentRoute: string;
}

export type RepairRoute =
  | { readonly kind: "repair_in_place"; readonly failureSignature: string; readonly magnitude: number }
  | { readonly kind: "respec"; readonly packet: RespecPacketV1; readonly failureSignature: string }
  | { readonly kind: "blocked_needs_attention"; readonly reason: string; readonly failureSignature: string };

/** Every revision a respec agent is authorized to make (it can never waive policy). */
const RESPEC_ALLOWED_REVISIONS: ReadonlyArray<RespecRevisionKind> = [
  "clarify_acceptance_criteria",
  "split_spec",
  "revise_dag_dependencies",
];

/**
 * The STABLE failure signature for a member attempt: the canonical (sorted, de-duped) reason
 * codes + finding ids. `Finding.id` is stable across re-audits, so the SAME defect recurring
 * yields the SAME signature; a writer that retires findings shrinks the id set (progress).
 */
export function canonicalFailureSignature(
  reasonCodes: ReadonlyArray<string>,
  findingIds: ReadonlyArray<string>,
): string {
  const rc = [...new Set(reasonCodes)].sort();
  const fi = [...new Set(findingIds)].sort();
  return `rc:${rc.join(",")}|fi:${fi.join(",")}`;
}

export interface RepairDecisionInput {
  readonly ctx: RepairRouteContext;
  /** Prior attempt signatures for this source spec, oldest → newest (NOT including current). */
  readonly priorAttempts: ReadonlyArray<AttemptSignature>;
  /** The respec generation this decision would mint if it escalates (= prior respecs + 1). */
  readonly respecGeneration: number;
  /** A route to a DIFFERENT agent than `ctx.priorAgentRoute` (asserted by the packet schema). */
  readonly nextAgentRoute: string;
}

/**
 * THE pure routing decision — no I/O, no clock, deterministic + unit-testable. The magnitude
 * is the finding count (a shrinking count is convergence → keep repairing, UNBOUNDED); a
 * recurring non-shrinking signature is a fixed point → respec.
 */
export function decideRepairRoute(input: RepairDecisionInput): RepairRoute {
  const { ctx } = input;
  const signature = canonicalFailureSignature(ctx.reasonCodes, ctx.findingIds);
  switch (ctx.classification) {
    case "deterministic_policy": {
      // A deterministic policy failure with NO attributed findings is unattributed — fail closed.
      if (ctx.findingIds.length === 0) {
        return { kind: "blocked_needs_attention", reason: "unattributed_policy", failureSignature: signature };
      }
      const magnitude = ctx.findingIds.length;
      const current: AttemptSignature = { failureSignature: signature, magnitude };
      const history: ReadonlyArray<AttemptSignature> = [...input.priorAttempts, current];
      if (assessStructuralProgress(history) !== "fixed_point") {
        return { kind: "repair_in_place", failureSignature: signature, magnitude };
      }
      const repeated = history.filter((a) => a.failureSignature === signature).map((a) => a.failureSignature);
      const packet: RespecPacketV1 = RespecPacketV1Schema.parse({
        version: 1,
        schemaVersion: RESPEC_PACKET_SCHEMA_VERSION,
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        sourceSpecId: ctx.sourceSpecId,
        groupId: ctx.groupId,
        evaluationId: ctx.evaluationId,
        generation: input.respecGeneration,
        priorAgentRoute: ctx.priorAgentRoute,
        nextAgentRoute: input.nextAgentRoute,
        fixedPoint: {
          failureSignature: signature,
          repeatedSignatures: repeated,
          findingIds: [...new Set(ctx.findingIds)].sort(),
          reasonCodes: [...new Set(ctx.reasonCodes)].sort(),
          magnitude,
        },
        allowedRevisions: [...RESPEC_ALLOWED_REVISIONS],
        policyWaiverForbidden: true,
        counterexample:
          `Member ${ctx.sourceSpecId} reached a fixed point: findings ${[...new Set(ctx.findingIds)].sort().join(", ")} ` +
          `(${magnitude}) recurred across attempts without reduction under reason codes ` +
          `${[...new Set(ctx.reasonCodes)].sort().join(", ")}. In-place repair did not converge.`,
      });
      return { kind: "respec", packet, failureSignature: signature };
    }
    case "needs_product_decision":
      return { kind: "blocked_needs_attention", reason: "needs_product_decision", failureSignature: signature };
    case "unknown_fail_closed":
      return { kind: "blocked_needs_attention", reason: "unknown_fail_closed", failureSignature: signature };
    case "transient_infrastructure":
      // Transient infra is not a repairable content failure; the embark holds+retries it before
      // the repair router is ever consulted. If it reaches here, fail closed rather than repair.
      return {
        kind: "blocked_needs_attention",
        reason: "transient_infrastructure_not_repairable",
        failureSignature: signature,
      };
    default: {
      const exhaustive: never = ctx.classification;
      return {
        kind: "blocked_needs_attention",
        reason: `unclassified_failure:${String(exhaustive)}`,
        failureSignature: signature,
      };
    }
  }
}
