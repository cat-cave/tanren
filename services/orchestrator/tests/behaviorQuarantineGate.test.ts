// rv-17 — anti-cosplay proofs for quarantine governance. HONEST SCOPE (see the
// behaviorQuarantineGovernance.ts header): the LIVE, production-wired governance effect is the
// rv-16 bisection skip (second describe); the gate-contribution resolver (first describe) is a
// tested-READY reader NOT yet consumed by the native MergeAuthority — the behavior-verdict →
// GateProofBundleV2.runtime_behavior → MergeAuthority binding node is pending. These prove:
//   1. NO LAUNDERING (resolver logic): a flaky/failing quarantined behavior maps to an explicit
//      `quarantined` / `needs_attention` contribution — NEVER `passed`/green.
//   2. LIVE bisection governance: a quarantined behavior is never used to name a culprit.
//   3. JUSTIFICATION: a quarantine can only be justified by a `flaky` classification (loud otherwise).
//   4. LIVE writer logic: the flake-quarantine actuator quarantines ONLY a decisive flaky conflict,
//      is idempotent, and never writes for a not-flaky classification.
import { describe, expect, it, vi } from "vitest";
import {
  assertQuarantineJustified,
  QuarantineNotJustifiedError,
  quarantineGateEffect,
  resolveAcceptanceGate,
  resolveBehaviorGateContribution,
  type QuarantineTransitionRecord,
} from "../src/engine/verification/acceptance/behaviorQuarantineGovernance.js";
import {
  actuateFlakeQuarantine,
  FLAKE_CLASSIFIER_ACTOR,
  type FlakeQuarantineActuatorStore,
} from "../src/engine/verification/acceptance/flakeQuarantineActuator.js";
import type { FlakeClassificationResult } from "../src/engine/verification/acceptance/flakeClassification.js";
import {
  recordRegressionBisections,
  type BisectionResult,
} from "../src/engine/verification/postMergeReproof/regressionBisection.js";

describe("rv-17 quarantine gate-contribution resolver (ready, not-yet-wired) — no laundering", () => {
  it("DECISIVE: a FAILING behavior that is quarantined does NOT become green — it is needs_attention", () => {
    const summary = resolveAcceptanceGate(
      [{ behaviorRevisionId: "br_flaky", outcome: "failed_product" }],
      new Set(["br_flaky"]),
    );
    // The whole point: quarantine can NEVER launder a failing behavior into a passed/green gate.
    expect(summary.status).toBe("needs_attention");
    expect(summary.status).not.toBe("green");
    expect(summary.green).toBe(0);
    expect(summary.quarantined).toBe(1);
    expect(summary.behaviors[0]!.contribution).toBe("quarantined");
  });

  it("a quarantined behavior that happens to pass is STILL excluded from green (surfaced, not silently green)", () => {
    const summary = resolveAcceptanceGate([{ behaviorRevisionId: "br", outcome: "passed" }], new Set(["br"]));
    expect(summary.status).toBe("needs_attention");
    expect(summary.green).toBe(0);
    expect(resolveBehaviorGateContribution("passed", true)).toBe("quarantined");
  });

  it("a genuinely failing NON-quarantined behavior still resolves to blocked", () => {
    const summary = resolveAcceptanceGate([{ behaviorRevisionId: "br", outcome: "failed_product" }], new Set());
    expect(summary.status).toBe("blocked");
    expect(summary.blocked).toBe(1);
  });

  it("all behaviors passed + none quarantined ⇒ green", () => {
    const summary = resolveAcceptanceGate(
      [
        { behaviorRevisionId: "a", outcome: "passed" },
        { behaviorRevisionId: "b", outcome: "passed" },
      ],
      new Set(),
    );
    expect(summary.status).toBe("green");
    expect(summary.green).toBe(2);
  });

  it("a real non-quarantined failure OUTWEIGHS a quarantine — resolves to blocked, not needs_attention", () => {
    const summary = resolveAcceptanceGate(
      [
        { behaviorRevisionId: "flaky", outcome: "failed_product" },
        { behaviorRevisionId: "broken", outcome: "failed_product" },
      ],
      new Set(["flaky"]),
    );
    expect(summary.status).toBe("blocked");
  });

  it("an empty run is never green", () => {
    expect(resolveAcceptanceGate([], new Set()).status).toBe("inconclusive");
  });

  it("quarantine gate_effect is always excluded_from_green (never a green effect); release is restored", () => {
    expect(quarantineGateEffect("quarantine")).toBe("excluded_from_green");
    expect(quarantineGateEffect("release")).toBe("restored");
  });

  it("a quarantine is only justified by a flaky classification — every other classification fails loud", () => {
    expect(() => assertQuarantineJustified("flaky")).not.toThrow();
    for (const c of ["stable", "consistent_failure", "insufficient_observation"] as const) {
      expect(() => assertQuarantineJustified(c)).toThrow(QuarantineNotJustifiedError);
    }
  });
});

describe("rv-17/mq-7 quarantine changes rv-16 bisection — a quarantined behavior never names a culprit", () => {
  // The observed epoch these verdicts were recorded at (mq-7 epoch-scoping key).
  const NEW_EPOCH = `sha256:${"a".repeat(64)}`;
  const OLD_EPOCH = `sha256:${"b".repeat(64)}`;
  const result = {
    decision: "recorded" as const,
    artifactDigest: NEW_EPOCH,
    verdicts: [{ behaviorRevisionId: "br_flaky", verdictId: "v_reg", outcome: "failed_product" as const }],
  };
  const job = { orgId: "org", projectId: "proj", releaseInstanceId: "ri_live" };

  it("WITHOUT quarantine: a regressed verdict triggers a bisection", async () => {
    const bisect = vi
      .fn<() => Promise<BisectionResult>>()
      .mockResolvedValue({ status: "inconclusive" } as BisectionResult);
    const results = await recordRegressionBisections({ bisect }, result, job);
    expect(bisect).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ status: "inconclusive" });
  });

  it("DECISIVE (same epoch): a behavior quarantined IN THIS epoch is SKIPPED — no bisection, no scapegoat", async () => {
    const bisect = vi
      .fn<() => Promise<BisectionResult>>()
      .mockResolvedValue({ status: "inconclusive" } as BisectionResult);
    // Epoch-comparing fake: quarantined only in NEW_EPOCH (its own, current generation).
    const quarantineReader = {
      isQuarantinedInEpoch: vi
        .fn<(scope: unknown, br: string, epoch: string) => Promise<boolean>>()
        .mockImplementation((_scope, _br, epoch) => Promise.resolve(epoch === NEW_EPOCH)),
    };
    const results = await recordRegressionBisections({ bisect }, result, job, quarantineReader);
    expect(quarantineReader.isQuarantinedInEpoch).toHaveBeenCalledWith(
      { orgId: "org", projectId: "proj" },
      "br_flaky",
      NEW_EPOCH,
    );
    expect(bisect).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("DURABLE ANTI-MASKING: a STALE-epoch quarantine does NOT mask a new-epoch regression — bisection PROCEEDS", async () => {
    const bisect = vi
      .fn<() => Promise<BisectionResult>>()
      .mockResolvedValue({ status: "localized" } as BisectionResult);
    // The behavior is STILL quarantined, but only in an OLDER generation (OLD_EPOCH) — exactly the
    // state when actuateFlakeQuarantine threw/was skipped and NO release row was written. The
    // epoch-scoped reader returns false for the OBSERVED (new) epoch, so the regression is not masked.
    const quarantineReader = {
      isQuarantinedInEpoch: vi
        .fn<(scope: unknown, br: string, epoch: string) => Promise<boolean>>()
        .mockImplementation((_scope, _br, epoch) => Promise.resolve(epoch === OLD_EPOCH)),
    };
    const results = await recordRegressionBisections({ bisect }, result, job, quarantineReader);
    // Queried for the NEW epoch (the generation the regression was observed in), not the stale one.
    expect(quarantineReader.isQuarantinedInEpoch).toHaveBeenCalledWith(
      { orgId: "org", projectId: "proj" },
      "br_flaky",
      NEW_EPOCH,
    );
    expect(bisect).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ status: "localized" }]);
  });

  it("a NON-quarantined regressed behavior still bisects even when a reader is wired", async () => {
    const bisect = vi
      .fn<() => Promise<BisectionResult>>()
      .mockResolvedValue({ status: "localized" } as BisectionResult);
    const quarantineReader = { isQuarantinedInEpoch: vi.fn<() => Promise<boolean>>().mockResolvedValue(false) };
    const results = await recordRegressionBisections({ bisect }, result, job, quarantineReader);
    expect(bisect).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ status: "localized" }]);
  });
});

const ACTUATOR_INPUT = {
  orgId: "org",
  projectId: "proj",
  behaviorRevisionId: "br",
  artifactDigest: `sha256:${"a".repeat(64)}`,
  purpose: "post_merge_production",
  contextHash: `sha256:${"d".repeat(64)}`,
  actor: FLAKE_CLASSIFIER_ACTOR,
};

// A DIFFERENT (older) generation than ACTUATOR_INPUT.artifactDigest — the epoch a stale
// quarantine was proven in, so re-evaluation sees an epoch rollover.
const OLD_EPOCH = `sha256:${"b".repeat(64)}`;

/** A classification result carrying representative evidence for the given class. */
function evidenceOf(classification: FlakeClassificationResult["classification"]): FlakeClassificationResult {
  if (classification === "flaky") {
    return {
      classification,
      evidence: [
        { verdictId: "v_pass", outcome: "passed" },
        { verdictId: "v_fail", outcome: "failed_product" },
      ],
      decisiveCount: 2,
    };
  }
  if (classification === "consistent_failure") {
    return { classification, evidence: [{ verdictId: "v_fail", outcome: "failed_product" }], decisiveCount: 2 };
  }
  if (classification === "stable") {
    return { classification, evidence: [{ verdictId: "v_pass", outcome: "passed" }], decisiveCount: 2 };
  }
  return { classification, evidence: [], decisiveCount: 0 };
}

function fakeActuatorStore(
  classification: FlakeClassificationResult,
  active?: { readonly epoch: string },
): { store: FlakeQuarantineActuatorStore; recorded: QuarantineTransitionRecord[] } {
  const recorded: QuarantineTransitionRecord[] = [];
  const store: FlakeQuarantineActuatorStore = {
    classifyBehaviorFlake: vi.fn<() => Promise<FlakeClassificationResult>>().mockResolvedValue(classification),
    readActiveQuarantine: vi.fn<() => Promise<{ readonly epoch: string } | undefined>>().mockResolvedValue(active),
    recordTransition: vi.fn<(record: QuarantineTransitionRecord) => Promise<string>>(async (record) => {
      recorded.push(record);
      return "quarantine_id_1";
    }),
  };
  return { store, recorded };
}

describe("rv-17 flake-quarantine actuator — the LIVE writer decision logic", () => {
  const input = ACTUATOR_INPUT;

  it("DECISIVE: a flaky classification that is NOT already quarantined ⇒ persists a quarantine with evidence", async () => {
    const evidence = [
      { verdictId: "v_pass", outcome: "passed" as const },
      { verdictId: "v_fail", outcome: "failed_product" as const },
    ];
    const { store, recorded } = fakeActuatorStore({ classification: "flaky", evidence, decisiveCount: 2 });
    const outcome = await actuateFlakeQuarantine(store, input);
    expect(outcome.action).toBe("quarantined");
    expect(outcome.quarantineId).toBe("quarantine_id_1");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      behaviorRevisionId: "br",
      transition: "quarantine",
      classification: "flaky",
      actor: FLAKE_CLASSIFIER_ACTOR,
      contextHash: input.contextHash,
      evidence,
      // mq-7: stamped with the epoch (artifact_digest) it was proven in.
      epoch: input.artifactDigest,
    });
  });

  it("IDEMPOTENT (same epoch): a flaky behavior already quarantined in THIS epoch ⇒ no second write", async () => {
    const { store, recorded } = fakeActuatorStore(
      { classification: "flaky", evidence: [{ verdictId: "v", outcome: "passed" }], decisiveCount: 2 },
      { epoch: input.artifactDigest },
    );
    const outcome = await actuateFlakeQuarantine(store, input);
    expect(outcome.action).toBe("already_quarantined");
    expect(recorded).toHaveLength(0);
  });

  it("NO FALSE WRITE: a non-flaky classification on a NOT-quarantined behavior ⇒ never quarantines", async () => {
    for (const classification of ["stable", "consistent_failure", "insufficient_observation"] as const) {
      const { store, recorded } = fakeActuatorStore({ classification, evidence: [], decisiveCount: 1 });
      const outcome = await actuateFlakeQuarantine(store, input);
      expect(outcome.action).toBe("not_flaky");
      expect(recorded).toHaveLength(0);
    }
  });
});

// mq-7 — epoch re-evaluation of an ALREADY-quarantined behavior on a NEW code generation. The
// active quarantine was proven in OLD_EPOCH; the actuator now observes NEW_EPOCH and re-classifies
// against that generation's OWN verdicts. The gravest failure — a genuine regression hidden behind a
// stale quarantine — is structurally impossible: a deterministic failure in the new epoch RELEASES.
describe("mq-7 flake-quarantine actuator — epoch re-evaluation (never masks a real regression)", () => {
  // observed epoch = ACTUATOR_INPUT.artifactDigest
  const input = ACTUATOR_INPUT;

  it("GRAVEST-FAILURE GUARD: a quarantined behavior that now CONSISTENTLY FAILS in a new epoch is RELEASED (regression unmasked)", async () => {
    const { store, recorded } = fakeActuatorStore(evidenceOf("consistent_failure"), { epoch: OLD_EPOCH });
    const outcome = await actuateFlakeQuarantine(store, input);
    // The quarantine is NOT silently kept — it is released so the deterministic failure reaches the gate.
    expect(outcome.action).toBe("released_regression");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      transition: "release",
      classification: "consistent_failure",
      epoch: input.artifactDigest,
    });
    // A release can NEVER carry a green/excluded effect that would launder the failure.
    expect(recorded[0]!.classification).not.toBe("flaky");
  });

  it("RECOVERY: a quarantined behavior that is STABLE in a new epoch is RELEASED (the flake is gone)", async () => {
    const { store, recorded } = fakeActuatorStore(evidenceOf("stable"), { epoch: OLD_EPOCH });
    const outcome = await actuateFlakeQuarantine(store, input);
    expect(outcome.action).toBe("released_recovered");
    expect(recorded[0]).toMatchObject({ transition: "release", classification: "stable", epoch: input.artifactDigest });
  });

  it("REAFFIRM: a quarantined behavior STILL flaky in a new epoch is re-quarantined, re-stamped to the new epoch", async () => {
    const { store, recorded } = fakeActuatorStore(evidenceOf("flaky"), { epoch: OLD_EPOCH });
    const outcome = await actuateFlakeQuarantine(store, input);
    expect(outcome.action).toBe("reaffirmed");
    expect(recorded[0]).toMatchObject({
      transition: "quarantine",
      classification: "flaky",
      epoch: input.artifactDigest,
    });
  });

  it("DEFER: a quarantined behavior with NO decisive evidence in the new epoch is held (no write) — nothing decisive is masked", async () => {
    const { store, recorded } = fakeActuatorStore(evidenceOf("insufficient_observation"), { epoch: OLD_EPOCH });
    const outcome = await actuateFlakeQuarantine(store, input);
    expect(outcome.action).toBe("deferred");
    expect(recorded).toHaveLength(0);
  });

  it("SAME EPOCH: an already-quarantined behavior observed again in its OWN epoch holds (no re-evaluation, no write)", async () => {
    const { store, recorded } = fakeActuatorStore(evidenceOf("consistent_failure"), { epoch: input.artifactDigest });
    // Even a consistent_failure in the SAME epoch it was quarantined in does not release: same
    // generation, no new evidence — the release only fires when a NEW generation shows the failure.
    const outcome = await actuateFlakeQuarantine(store, input);
    expect(outcome.action).toBe("already_quarantined");
    expect(recorded).toHaveLength(0);
  });
});
