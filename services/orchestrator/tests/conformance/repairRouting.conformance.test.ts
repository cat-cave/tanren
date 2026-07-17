// The fake shares `decideRepairRoute` with PgRepairRouter. Its two lookups map
// directly to the SQL predicates in repairRouting.ts: (hypothesis, signature)
// is the replay key, while failure_signature alone is the fixed-point key.

import { describe, expect, it } from "vitest";
import { decideRepairRoute, repairFailureSignature } from "../../src/engine/workflow/repairRouting.js";

type RecordedRoute = { readonly resolutionDecisionId: string; readonly failureSignatureHash: string };

class RepairRoutingConformanceFake {
  private readonly routes: RecordedRoute[] = [];

  public route(input: RecordedRoute): "idempotent" | "fixed_point" | "route" {
    const sameDecisionAlreadyRouted = this.routes.some(
      (route) =>
        route.resolutionDecisionId === input.resolutionDecisionId &&
        route.failureSignatureHash === input.failureSignatureHash,
    );
    const failureSignatureAlreadyRouted = this.routes.some(
      (route) => route.failureSignatureHash === input.failureSignatureHash,
    );
    const decision = decideRepairRoute({
      sameDecisionAlreadyRouted,
      failureSignatureAlreadyRouted,
      mergedLineageAvailable: true,
    });
    if (decision === "route") this.routes.push(input);
    if (decision === "missing_lineage") throw new Error("fixture must supply merged lineage");
    return decision;
  }

  public get count(): number {
    return this.routes.length;
  }
}

function signature(observedHash: string): string {
  return repairFailureSignature({
    contractId: "contract_a",
    contractHash: "sha256:" + "a".repeat(64),
    sourceRevision: "source-revision-a",
    decisionReasons: ["production symptom verification did not pass"],
    assertions: [{ expectedHash: "sha256:" + "b".repeat(64), observedHash, outcome: "failed" }],
  });
}

describe("P0 repair routing SQL-predicate conformance", () => {
  it("routes once per distinct stable failure signature, without an attempt cap", () => {
    const fake = new RepairRoutingConformanceFake();
    const sameFailure = signature("sha256:" + "c".repeat(64));
    const changedEvidence = signature("sha256:" + "d".repeat(64));

    expect(fake.route({ resolutionDecisionId: "rdec_first", failureSignatureHash: sameFailure })).toBe("route");
    expect(fake.route({ resolutionDecisionId: "rdec_first", failureSignatureHash: sameFailure })).toBe("idempotent");
    expect(fake.route({ resolutionDecisionId: "rdec_recurrence", failureSignatureHash: sameFailure })).toBe(
      "fixed_point",
    );
    expect(fake.route({ resolutionDecisionId: "rdec_new_evidence", failureSignatureHash: changedEvidence })).toBe(
      "route",
    );
    expect(fake.count).toBe(2);
  });

  it("does not treat a changed observation as the same failure signature", () => {
    expect(signature("sha256:" + "c".repeat(64))).not.toBe(signature("sha256:" + "d".repeat(64)));
  });
});
