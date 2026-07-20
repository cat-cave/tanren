// cspell:ignore mqeval mqgrp klass
// mq-10 — the PURE autonomous-repair routing decision: exhaustive taxonomy, progress-based
// fixed-point escalation to a RespecPacketV1, and fail-closed on every non-repairable class.
import { describe, expect, it } from "vitest";
import type { AttemptSignature } from "../src/engine/workflow/convergenceDetector.js";
import { RespecPacketV1Schema } from "../src/engine/contracts/respecPacket.js";
import {
  canonicalFailureSignature,
  decideRepairRoute,
  type RepairFailureClassification,
  type RepairRoute,
  type RepairRouteContext,
} from "../src/engine/merge/repairRouteDecision.js";

function ctx(
  classification: RepairFailureClassification,
  findingIds: ReadonlyArray<string>,
  reasonCodes: ReadonlyArray<string> = ["audit_policy"],
): RepairRouteContext {
  return {
    orgId: "org_mq10",
    projectId: "project_mq10",
    sourceSpecId: "spec_stuck",
    runId: "run_stuck",
    groupId: "mqgrp_x",
    evaluationId: "mqeval_x",
    classification,
    findingIds,
    reasonCodes,
    priorAgentRoute: "writer.in_place",
  };
}

const NEXT = "answerer.respec";

describe("decideRepairRoute — the autonomous-repair taxonomy", () => {
  it("routes a first deterministic-policy failure to in-place repair (no history)", () => {
    const route = decideRepairRoute({
      ctx: ctx("deterministic_policy", ["f1"]),
      priorAttempts: [],
      respecGeneration: 1,
      nextAgentRoute: NEXT,
    });
    expect(route.kind).toBe("repair_in_place");
  });

  it("keeps repairing while the finding set shrinks (converging — progress, unbounded)", () => {
    // Larger recurring finding sets, then a smaller one: each attempt is genuine progress.
    const prior: AttemptSignature[] = [
      { failureSignature: canonicalFailureSignature(["audit_policy"], ["f1", "f2", "f3"]), magnitude: 3 },
      { failureSignature: canonicalFailureSignature(["audit_policy"], ["f1", "f2"]), magnitude: 2 },
    ];
    const route = decideRepairRoute({
      ctx: ctx("deterministic_policy", ["f1"]),
      priorAttempts: prior,
      respecGeneration: 1,
      nextAgentRoute: NEXT,
    });
    expect(route.kind).toBe("repair_in_place");
  });

  it("escalates a PROVEN fixed point (same findings recur, no reduction) to a valid RespecPacketV1", () => {
    const sig = canonicalFailureSignature(["audit_policy"], ["f1"]);
    // Two prior identical attempts + the current one = a recurrence across an intervening attempt.
    const prior: AttemptSignature[] = [
      { failureSignature: sig, magnitude: 1 },
      { failureSignature: sig, magnitude: 1 },
    ];
    const route = decideRepairRoute({
      ctx: ctx("deterministic_policy", ["f1"]),
      priorAttempts: prior,
      respecGeneration: 2,
      nextAgentRoute: NEXT,
    });
    expect(route.kind).toBe("respec");
    const packet = (route as Extract<RepairRoute, { kind: "respec" }>).packet;
    // The emitted packet is a valid frozen RespecPacketV1.
    expect(RespecPacketV1Schema.safeParse(packet).success).toBe(true);
    expect(packet.nextAgentRoute).toBe(NEXT);
    expect(packet.nextAgentRoute).not.toBe(packet.priorAgentRoute);
    expect(packet.policyWaiverForbidden).toBe(true);
    expect(packet.generation).toBe(2);
    expect(packet.allowedRevisions).toContain("split_spec");
    expect(packet.fixedPoint.repeatedSignatures.length).toBeGreaterThanOrEqual(2);
  });

  it("fails closed to blocked when a deterministic policy failure is unattributed (no findings)", () => {
    const route = decideRepairRoute({
      ctx: ctx("deterministic_policy", []),
      priorAttempts: [],
      respecGeneration: 1,
      nextAgentRoute: NEXT,
    });
    expect(route.kind).toBe("blocked_needs_attention");
    expect((route as Extract<RepairRoute, { kind: "blocked_needs_attention" }>).reason).toBe("unattributed_policy");
  });

  it("fails closed to blocked for every non-repairable classification (never repair, never respec)", () => {
    const kinds = (["needs_product_decision", "unknown_fail_closed", "transient_infrastructure"] as const).map(
      (klass) =>
        decideRepairRoute({ ctx: ctx(klass, ["f1"]), priorAttempts: [], respecGeneration: 1, nextAgentRoute: NEXT })
          .kind,
    );
    expect(kinds).toEqual(["blocked_needs_attention", "blocked_needs_attention", "blocked_needs_attention"]);
  });
});
