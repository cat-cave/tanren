// The fake shares `decideRepairRoute` with PgRepairRouter. Its two lookups map
// directly to the SQL predicates in repairRouting.ts: (hypothesis, signature)
// is the replay key, while failure_signature alone is the fixed-point key.

import { describe, expect, it } from "vitest";
import { authorizeProductionResolution } from "../../src/engine/dag/productionResolutionAuthorization.js";
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

function signature(observedStatus: string, noise: Record<string, unknown> = {}): string {
  return repairFailureSignature({
    contractId: "contract_a",
    contractHash: "sha256:" + "a".repeat(64),
    classification: "product_failure",
    assertions: [
      {
        expectedObservation: { body: { status: "fixed" }, status: 200 },
        observedObservation: { body: { status: observedStatus }, status: 200, ...noise },
        outcome: "failed",
      },
    ],
  });
}

describe("P0 repair routing SQL-predicate conformance", () => {
  it("routes once per distinct stable failure signature, without an attempt cap", () => {
    const fake = new RepairRoutingConformanceFake();
    const sameFailure = signature("still_broken");
    const changedEvidence = signature("changed_broken_shape");

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
    expect(signature("still_broken")).not.toBe(signature("changed_broken_shape"));
  });

  it("strips run-scoped probe noise before the fixed-point signature is hashed", () => {
    expect(
      signature("still_broken", {
        probeId: "probe_first",
        timestamp: "2026-01-01T00:00:00Z",
        verificationRunId: "vrun_first",
      }),
    ).toBe(
      signature("still_broken", {
        probeId: "probe_repeat",
        timestamp: "2026-02-02T00:00:00Z",
        verificationRunId: "vrun_repeat",
      }),
    );
  });

  it("never calls the production repair router for authorized or waived decisions", async () => {
    for (const decision of ["authorized", "waived"] as const) {
      let routes = 0;
      await authorizeProductionResolution(
        {
          authorize: async () => ({
            id: `rdec_${decision}`,
            decision,
            inputSnapshotHash: "sha256:" + decision.padEnd(64, "0"),
            reasons: [],
            created: true,
          }),
        },
        { orgId: "org_a", id: `rjob_${decision}`, stage: "production" },
        {
          route: async () => {
            routes += 1;
            throw new Error("non-blocked decisions must not route repairs");
          },
        },
      );
      expect(routes).toBe(0);
    }
  });
});
