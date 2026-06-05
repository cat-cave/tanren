// flaky-detection reducer tests. `deriveFlakyTests` is pure over its
// per-check CI observations, so every assertion is against hand-built fixtures
// — no DB. The CRITICAL SAFETY property is proven here: a CONSISTENTLY-failing
// check is NEVER flagged (so quarantine can never mask a genuinely-broken test),
// and a consistently-passing check is never flagged either. A check is flaky
// ONLY when it both passed AND failed on the SAME head SHA (unchanged code).

import { describe, expect, it } from "vitest";
import { deriveFlakyTests, flattenCiObservations, type CiCheckObservation } from "../src/engine/insights/ciFlaky.js";

const T0 = new Date("2026-05-01T00:00:00Z");
function obs(checkName: string, headSha: string, outcome: "passed" | "failed", offsetMs = 0): CiCheckObservation {
  return { checkName, headSha, outcome, observedAt: new Date(T0.getTime() + offsetMs) };
}

describe("deriveFlakyTests — genuine non-determinism only", () => {
  it("flags a check that BOTH passed and failed on the same head SHA", () => {
    const verdicts = deriveFlakyTests([obs("unit", "sha1", "failed", 0), obs("unit", "sha1", "passed", 1000)]);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.checkName).toBe("unit");
    expect(verdicts[0]!.toggledShaCount).toBe(1);
    expect(verdicts[0]!.observationCount).toBe(2);
    expect(verdicts[0]!.sampleShas).toEqual(["sha1"]);
  });

  it("counts passed-on-retry: failed then later passed on the SAME sha", () => {
    const verdicts = deriveFlakyTests([obs("e2e", "shaA", "failed", 0), obs("e2e", "shaA", "passed", 5000)]);
    expect(verdicts[0]!.passedOnRetryCount).toBe(1);
  });

  it("does NOT count passed-on-retry when the pass preceded the fail", () => {
    const verdicts = deriveFlakyTests([obs("e2e", "shaA", "passed", 0), obs("e2e", "shaA", "failed", 5000)]);
    // still flaky (toggle on one sha) but not a passed-on-retry
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.passedOnRetryCount).toBe(0);
  });
});

describe("deriveFlakyTests — SAFETY: a consistently-failing check is NEVER flaky", () => {
  it("never flags a check that only ever fails across many SHAs", () => {
    const verdicts = deriveFlakyTests([
      obs("broken", "sha1", "failed"),
      obs("broken", "sha2", "failed"),
      obs("broken", "sha3", "failed"),
      obs("broken", "sha3", "failed"),
    ]);
    expect(verdicts).toHaveLength(0);
  });

  it("never flags a check that fails repeatedly on the SAME sha (deterministic fail)", () => {
    const verdicts = deriveFlakyTests([
      obs("broken", "sha1", "failed", 0),
      obs("broken", "sha1", "failed", 1000),
      obs("broken", "sha1", "failed", 2000),
    ]);
    expect(verdicts).toHaveLength(0);
  });

  it("never flags a consistently-passing check", () => {
    const verdicts = deriveFlakyTests([obs("stable", "sha1", "passed"), obs("stable", "sha2", "passed")]);
    expect(verdicts).toHaveLength(0);
  });

  it("does NOT treat pass-on-sha1 + fail-on-sha2 (different code) as flaky", () => {
    // Each SHA has a single, consistent outcome — the difference is the CODE,
    // not non-determinism. This must NOT quarantine.
    const verdicts = deriveFlakyTests([obs("unit", "sha1", "passed"), obs("unit", "sha2", "failed")]);
    expect(verdicts).toHaveLength(0);
  });
});

describe("deriveFlakyTests — minToggledShas bar", () => {
  it("requires the toggle on >= minToggledShas distinct SHAs", () => {
    const observations = [obs("unit", "sha1", "failed"), obs("unit", "sha1", "passed")];
    // one toggling sha — flagged at default (1), suppressed at bar 2.
    expect(deriveFlakyTests(observations, { minToggledShas: 1 })).toHaveLength(1);
    expect(deriveFlakyTests(observations, { minToggledShas: 2 })).toHaveLength(0);
  });

  it("flags at bar 2 when two distinct SHAs each toggle", () => {
    const verdicts = deriveFlakyTests(
      [
        obs("unit", "sha1", "failed"),
        obs("unit", "sha1", "passed"),
        obs("unit", "sha2", "passed"),
        obs("unit", "sha2", "failed"),
      ],
      { minToggledShas: 2 },
    );
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.toggledShaCount).toBe(2);
  });
});

describe("flattenCiObservations — gate.verdict payload → per-step observations", () => {
  it("flattens steps and maps the passed flag to pass/fail", () => {
    const rows = [
      {
        ts: T0,
        payload: {
          headSha: "sha1",
          steps: [
            { name: "unit", tier: "fast", passed: true },
            { name: "lint", tier: "fast", passed: false },
          ],
        },
      },
    ];
    const flat = flattenCiObservations(rows);
    expect(flat).toHaveLength(2);
    expect(flat.find((o) => o.checkName === "unit")!.outcome).toBe("passed");
    expect(flat.find((o) => o.checkName === "lint")!.outcome).toBe("failed");
  });

  it("treats a missing/false passed flag as a failure", () => {
    const rows = [
      {
        ts: T0,
        payload: {
          headSha: "sha1",
          steps: [
            { name: "a", tier: "fast", passed: true },
            { name: "b", tier: "fast", passed: false },
            { name: "c", tier: "slow" },
          ],
        },
      },
    ];
    const flat = flattenCiObservations(rows);
    expect(flat.find((o) => o.checkName === "a")!.outcome).toBe("passed");
    expect(flat.find((o) => o.checkName === "b")!.outcome).toBe("failed");
    expect(flat.find((o) => o.checkName === "c")!.outcome).toBe("failed");
  });

  it("end-to-end: flatten then derive flags only the genuinely-flaky step", () => {
    const rows = [
      // sha1: unit toggles (fail then pass), broken always fails.
      {
        ts: new Date(T0.getTime()),
        payload: {
          headSha: "sha1",
          steps: [
            { name: "unit", tier: "fast", passed: false },
            { name: "broken", tier: "fast", passed: false },
          ],
        },
      },
      {
        ts: new Date(T0.getTime() + 1000),
        payload: {
          headSha: "sha1",
          steps: [
            { name: "unit", tier: "fast", passed: true },
            { name: "broken", tier: "fast", passed: false },
          ],
        },
      },
    ];
    const verdicts = deriveFlakyTests(flattenCiObservations(rows));
    expect(verdicts.map((v) => v.checkName)).toEqual(["unit"]);
  });
});
