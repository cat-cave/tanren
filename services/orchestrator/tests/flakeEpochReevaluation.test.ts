// mq-7 — the epoch re-evaluation decision table + its NEGATIVE controls. The gravest failure this
// node forbids is a genuine regression hidden behind a stale flake quarantine; these lock that a
// new generation's deterministic failure ALWAYS releases (unmasks), and that no other outcome
// silently extends the quarantine on the strength of the flaky label.
import { describe, expect, it } from "vitest";
import {
  isRelease,
  reevaluateQuarantineOnEpoch,
  type QuarantineReevaluation,
} from "../src/engine/verification/acceptance/flakeEpochReevaluation.js";
import type { FlakeClassification } from "../src/engine/verification/acceptance/flakeClassification.js";

const OLD = `sha256:${"b".repeat(64)}`;
const NEW = `sha256:${"a".repeat(64)}`;

describe("mq-7 reevaluateQuarantineOnEpoch — anti-masking decision table", () => {
  it("GRAVEST-FAILURE GUARD: a new epoch that CONSISTENTLY FAILS releases the quarantine (regression unmasked)", () => {
    const decision = reevaluateQuarantineOnEpoch({
      quarantinedEpoch: OLD,
      observedEpoch: NEW,
      observedClassification: "consistent_failure",
    });
    expect(decision).toBe("release_regression");
    expect(isRelease(decision)).toBe(true);
  });

  it("a new epoch that is STABLE releases the quarantine (recovered)", () => {
    const decision = reevaluateQuarantineOnEpoch({
      quarantinedEpoch: OLD,
      observedEpoch: NEW,
      observedClassification: "stable",
    });
    expect(decision).toBe("release_recovered");
    expect(isRelease(decision)).toBe(true);
  });

  it("a new epoch that is STILL flaky reaffirms (stays quarantined, re-stamped)", () => {
    const decision = reevaluateQuarantineOnEpoch({
      quarantinedEpoch: OLD,
      observedEpoch: NEW,
      observedClassification: "flaky",
    });
    expect(decision).toBe("reaffirm");
    expect(isRelease(decision)).toBe(false);
  });

  it("a new epoch with NO decisive evidence defers (held one more generation) — nothing decisive is masked", () => {
    const decision = reevaluateQuarantineOnEpoch({
      quarantinedEpoch: OLD,
      observedEpoch: NEW,
      observedClassification: "insufficient_observation",
    });
    expect(decision).toBe("defer");
    expect(isRelease(decision)).toBe(false);
  });

  it("NEGATIVE CONTROL: the SAME epoch never re-evaluates — it holds for EVERY classification (no same-generation release)", () => {
    for (const c of ["flaky", "consistent_failure", "stable", "insufficient_observation"] as const) {
      const decision: QuarantineReevaluation = reevaluateQuarantineOnEpoch({
        quarantinedEpoch: NEW,
        observedEpoch: NEW,
        observedClassification: c as FlakeClassification,
      });
      expect(decision).toBe("hold_same_epoch");
      expect(isRelease(decision)).toBe(false);
    }
  });
});
