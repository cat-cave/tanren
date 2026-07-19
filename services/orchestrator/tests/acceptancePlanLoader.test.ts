// rv-6 A2 loader proof: the stored `behavior_revisions.acceptance` spec compiles
// FAITHFULLY into the executable AcceptancePlan (exact subjects / operators /
// expected / probes), and a malformed spec fails LOUD — it never silently drops
// an assertion or fabricates one.
import { describe, expect, it } from "vitest";
import type { BehaviorRevisionId } from "../src/engine/contracts/behaviorRevision.js";
import { MalformedAcceptanceSpecError, compileAcceptancePlan } from "../src/engine/verification/acceptance/index.js";

function revision(acceptance: Readonly<Record<string, unknown>>) {
  return { id: "br_loader_rv6" as BehaviorRevisionId, acceptance };
}

const FAITHFUL_SPEC = {
  version: "v1",
  httpProbes: [{ probeId: "p1", method: "GET", path: "/health" }],
  assertions: [
    { assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 },
    { assertionId: "a2", subject: "p1.body.count", comparisonOperator: "greater_than", expected: 1 },
  ],
} as const;

describe("compileAcceptancePlan — faithful compilation", () => {
  it("compiles every stored assertion into the exact plan assertion", () => {
    const plan = compileAcceptancePlan(revision(FAITHFUL_SPEC));
    expect(plan.behaviorRevisionId).toBe("br_loader_rv6");
    expect(plan.requiredSurfaces).toEqual(["api"]);
    expect(plan.httpProbes).toEqual([{ probeId: "p1", method: "GET", path: "/health" }]);
    expect(plan.assertions).toEqual([
      { assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 },
      { assertionId: "a2", subject: "p1.body.count", comparisonOperator: "greater_than", expected: 1 },
    ]);
    // The plan id is a stable content hash, not a fabricated placeholder.
    expect(plan.planId).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(compileAcceptancePlan(revision(FAITHFUL_SPEC)).planId).toBe(plan.planId);
  });

  it("preserves an explicit requiredSurfaces and a rv-12 causal assertion", () => {
    const plan = compileAcceptancePlan(
      revision({
        requiredSurfaces: ["api"],
        httpProbes: [{ probeId: "p1", method: "POST", path: "/orders", body: { sku: "x" } }],
        causes: [{ causeId: "c1", surface: "api", action: "place-order" }],
        assertions: [
          { assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 201 },
          {
            assertionId: "a2",
            subject: "effect-count",
            comparisonOperator: "has_cardinality",
            expected: 1,
            correlation: { causeId: "c1", observer: "slack", provider: "slack", requireCorrelationId: true },
          },
        ],
      }),
    );
    expect(plan.causes).toEqual([{ causeId: "c1", surface: "api", action: "place-order" }]);
    expect(plan.httpProbes?.[0]?.body).toEqual({ sku: "x" });
    expect(plan.assertions[1]?.correlation?.causeId).toBe("c1");
  });

  it("LOUD: an empty spec (no assertions) throws rather than compiling an empty plan", () => {
    expect(() => compileAcceptancePlan(revision({}))).toThrow(MalformedAcceptanceSpecError);
  });

  it("LOUD: an unknown comparison operator is rejected, not silently defaulted", () => {
    expect(() =>
      compileAcceptancePlan(
        revision({
          httpProbes: [{ probeId: "p1", method: "GET", path: "/h" }],
          assertions: [{ assertionId: "a1", subject: "p1.status", comparisonOperator: "totally_bogus", expected: 1 }],
        }),
      ),
    ).toThrow(MalformedAcceptanceSpecError);
  });

  it("LOUD: a non-causal assertion referencing no declared probe fails loud", () => {
    expect(() =>
      compileAcceptancePlan(
        revision({
          httpProbes: [{ probeId: "p1", method: "GET", path: "/h" }],
          assertions: [{ assertionId: "a1", subject: "p2.status", comparisonOperator: "equals", expected: 200 }],
        }),
      ),
    ).toThrow(/references no declared http probe/u);
  });

  it("LOUD: duplicate probe ids are rejected", () => {
    expect(() =>
      compileAcceptancePlan(
        revision({
          httpProbes: [
            { probeId: "p1", method: "GET", path: "/a" },
            { probeId: "p1", method: "GET", path: "/b" },
          ],
          assertions: [{ assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 }],
        }),
      ),
    ).toThrow(/duplicate probe id/u);
  });
});
