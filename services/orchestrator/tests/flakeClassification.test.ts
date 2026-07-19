// rv-17 — the flake classifier is REAL (computed from conflicting recorded verdicts) and
// FAIL-CLOSED (absence/insufficient never launders into flaky OR into a default stable+pass).
import { describe, expect, it } from "vitest";
import { classifyFlake } from "../src/engine/verification/acceptance/flakeClassification.js";

describe("rv-17 flake classification", () => {
  it("REAL: a decisive pass + a decisive product-fail on the same behavior ⇒ flaky, with both ids as evidence", () => {
    const result = classifyFlake([
      { verdictId: "v_pass", outcome: "passed" },
      { verdictId: "v_fail", outcome: "failed_product" },
    ]);
    expect(result.classification).toBe("flaky");
    expect(result.evidence.map((e) => e.verdictId).sort()).toEqual(["v_fail", "v_pass"]);
    // The evidence cites the actual conflicting outcomes — not a fabricated marker.
    expect(new Set(result.evidence.map((e) => e.outcome))).toEqual(new Set(["passed", "failed_product"]));
  });

  it("failed_visual counts as a decisive failure for the flake conflict", () => {
    const result = classifyFlake([
      { verdictId: "v_pass", outcome: "passed" },
      { verdictId: "v_vis", outcome: "failed_visual" },
    ]);
    expect(result.classification).toBe("flaky");
  });

  it("CONSISTENT: all-passed ⇒ stable (never flaky)", () => {
    const result = classifyFlake([
      { verdictId: "v1", outcome: "passed" },
      { verdictId: "v2", outcome: "passed" },
    ]);
    expect(result.classification).toBe("stable");
  });

  it("CONSISTENT: all decisive failures ⇒ consistent_failure (a genuinely-broken behavior is NOT flaky)", () => {
    const result = classifyFlake([
      { verdictId: "v1", outcome: "failed_product" },
      { verdictId: "v2", outcome: "failed_product" },
    ]);
    expect(result.classification).toBe("consistent_failure");
  });

  it("FAIL-CLOSED: a passed + an inconclusive is NOT a flake conflict (inconclusive is not a decisive fail)", () => {
    const result = classifyFlake([
      { verdictId: "v_pass", outcome: "passed" },
      { verdictId: "v_infra", outcome: "inconclusive_infrastructure" },
    ]);
    // Only one decisive observation (the pass) ⇒ stable, never laundered to flaky off an infra blip.
    expect(result.classification).toBe("stable");
    expect(result.decisiveCount).toBe(1);
  });

  it("FAIL-CLOSED: a passed + a coverage failure (failed_verification_contract) is NOT flaky", () => {
    const result = classifyFlake([
      { verdictId: "v_pass", outcome: "passed" },
      { verdictId: "v_contract", outcome: "failed_verification_contract" },
    ]);
    expect(result.classification).toBe("stable");
  });

  it("FAIL-CLOSED: no decisive observation at all ⇒ insufficient_observation (never stable-by-default)", () => {
    const result = classifyFlake([
      { verdictId: "v_infra", outcome: "inconclusive_infrastructure" },
      { verdictId: "v_ext", outcome: "inconclusive_external" },
    ]);
    expect(result.classification).toBe("insufficient_observation");
    expect(result.evidence).toEqual([]);
  });

  it("FAIL-CLOSED: an empty history ⇒ insufficient_observation", () => {
    expect(classifyFlake([]).classification).toBe("insufficient_observation");
  });
});
