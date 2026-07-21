// DB-free unit tests for the durable delivery DAG (in-17). Cover the fail-closed arms —
// the pure stage-outcome mappers, the signed-evidence builder, the stage executors (with a
// fake signal port + fake seams), and the resume/degrade/complete plan orchestration — so
// the gravest fail-open (reporting complete without the observed effect) is provably
// impossible without a database.

import { describe, expect, it } from "vitest";
import {
  buildDeliveryEvidence,
  contentAddressedEvidenceSigner,
  hmacEvidenceSigner,
} from "../src/engine/postMerge/delivery/deliveryEvidence.js";
import type { DemoReach } from "../src/engine/postMerge/delivery/deliverySignals.js";
import {
  DeliveryStages,
  newDriveMemo,
  observedEffectFor,
  outcomeForDemoStage,
  outcomeForDeployStage,
} from "../src/engine/postMerge/delivery/deliveryStages.js";
import { DELIVERY_STAGES, stageOrdinal, type DeliveryStage } from "../src/engine/postMerge/delivery/stageModel.js";
import { fakeRunner, fakeSignals, lineage, stagesDeps } from "./helpers/deliveryDagFakes.js";

describe("delivery stage model", () => {
  it("has the nine 0043 stages in dependency order (bind before deploy before observe)", () => {
    expect([...DELIVERY_STAGES]).toEqual([
      "reconcile_binding",
      "mint_lease",
      "materialize_env",
      "attach_runtime",
      "deploy",
      "verify_deploy",
      "stimulate",
      "observe",
      "record_evidence",
    ]);
    expect(stageOrdinal("attach_runtime")).toBeLessThan(stageOrdinal("deploy"));
    expect(stageOrdinal("deploy")).toBeLessThan(stageOrdinal("verify_deploy"));
    expect(stageOrdinal("observe")).toBeLessThan(stageOrdinal("record_evidence"));
  });
});

describe("deploy-cluster outcome mapping", () => {
  it("confirms every cluster stage as a no-op when no deploy is configured", () => {
    for (const s of ["materialize_env", "attach_runtime", "deploy", "verify_deploy"] as DeliveryStage[]) {
      expect(outcomeForDeployStage(s, "none").kind).toBe("confirmed");
    }
  });
  it("confirms only through the reached stage and degrades the first unconfirmed one", () => {
    expect(outcomeForDeployStage("materialize_env", "attached").kind).toBe("confirmed");
    expect(outcomeForDeployStage("attach_runtime", "attached").kind).toBe("confirmed");
    expect(outcomeForDeployStage("deploy", "attached").kind).toBe("degraded");
    expect(outcomeForDeployStage("deploy", "triggered").kind).toBe("confirmed");
    expect(outcomeForDeployStage("verify_deploy", "triggered").kind).toBe("degraded");
    expect(outcomeForDeployStage("verify_deploy", "verified").kind).toBe("confirmed");
    expect(outcomeForDeployStage("materialize_env", "expected").kind).toBe("degraded");
  });
});

describe("demo-cluster outcome mapping", () => {
  const cases: Array<[DemoReach, "confirmed" | "degraded", "confirmed" | "degraded"]> = [
    ["none", "confirmed", "confirmed"],
    ["observed", "confirmed", "confirmed"],
    // stimulate ran; effect NOT observed
    ["failed", "confirmed", "degraded"],
    ["expected", "degraded", "degraded"],
  ];
  it.each(cases)("reach %s → stimulate %s, observe %s", (reach, stimulate, observe) => {
    expect(outcomeForDemoStage("stimulate", reach).kind).toBe(stimulate);
    expect(outcomeForDemoStage("observe", reach).kind).toBe(observe);
  });
});

describe("observed effect derivation", () => {
  it("prefers the independently-observed demo, then a verified deploy, then none", () => {
    expect(observedEffectFor("verified", "observed")).toBe("demo_observed");
    expect(observedEffectFor("verified", "expected")).toBe("deploy_verified");
    expect(observedEffectFor("none", "none")).toBe("none");
  });
});

describe("signed delivery evidence", () => {
  const input = {
    lineage,
    deliveryRunId: "d-1",
    observedEffect: "demo_observed" as const,
    deploymentId: "dep-9",
    stagesConfirmed: ["observe"],
  };
  it("is deterministic and content-addressed", () => {
    const a = buildDeliveryEvidence(input, contentAddressedEvidenceSigner);
    const b = buildDeliveryEvidence(input, contentAddressedEvidenceSigner);
    expect(a.evidenceDigest).toBe(b.evidenceDigest);
    expect(a.evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(a.signature).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
  it("changes digest when the observed effect changes", () => {
    const a = buildDeliveryEvidence(input, contentAddressedEvidenceSigner);
    const b = buildDeliveryEvidence({ ...input, observedEffect: "deploy_verified" }, contentAddressedEvidenceSigner);
    expect(a.evidenceDigest).not.toBe(b.evidenceDigest);
  });
  it("signs with an HMAC when a key is provided", () => {
    const signed = buildDeliveryEvidence(input, hmacEvidenceSigner("k"));
    expect(signed.signature).toMatch(/^hmac-sha256:[0-9a-f]{64}$/u);
  });
});

describe("reconcile_binding stage", () => {
  it("confirms when the saga converged", async () => {
    const { deps } = stagesDeps();
    expect(
      (await new DeliveryStages(deps).run("reconcile_binding", lineage, "d-1", newDriveMemo(), "claim-1")).kind,
    ).toBe("confirmed");
  });
  it("degrades on an unresolved reconcile (state_unknown / needs_attention)", async () => {
    const { deps } = stagesDeps({ saga: { driveForOrg: async () => ({ stateUnknown: 1, needsAttention: 0 }) } });
    const out = await new DeliveryStages(deps).run("reconcile_binding", lineage, "d-1", newDriveMemo(), "claim-1");
    expect(out.kind).toBe("degraded");
  });
  it("FAIL-CLOSED: does not advance when the exact release binding set cannot be sealed", async () => {
    const { deps } = stagesDeps({
      bindingSetSealer: { seal: async () => ({ kind: "unavailable", detail: "missing generation" }) },
    });
    const out = await new DeliveryStages(deps).run("reconcile_binding", lineage, "d-1", newDriveMemo(), "claim-1");
    expect(out).toMatchObject({ kind: "degraded", classification: "release_binding_set_unconfirmed" });
  });
});

describe("mint_lease stage (fail-closed on unavailable scoped-lease backend)", () => {
  it("no-ops when there are no provisioned production secrets", async () => {
    const { deps } = stagesDeps();
    expect((await new DeliveryStages(deps).run("mint_lease", lineage, "d-1", newDriveMemo(), "claim-1")).kind).toBe(
      "confirmed",
    );
  });
  it("degrades fail-closed when product secrets exist but no minter is available", async () => {
    const { deps } = stagesDeps({ signals: fakeSignals({ provisionedProductionSecretRefs: async () => ["ref/a"] }) });
    const out = await new DeliveryStages(deps).run("mint_lease", lineage, "d-1", newDriveMemo(), "claim-1");
    expect(out).toMatchObject({ kind: "degraded", classification: "scoped_lease_backend_unavailable" });
  });
  it("mints the activation-scoped lease over exactly the project secret refs", async () => {
    const minted: string[][] = [];
    const { deps } = stagesDeps({
      signals: fakeSignals({ provisionedProductionSecretRefs: async () => ["ref/a", "ref/b"] }),
      minter: {
        mintScopedRunToken: async (i) => {
          minted.push([...i.credentialRefPaths]);
          return {
            token: "t",
            policyName: "p",
            refPaths: [...i.credentialRefPaths],
            writableRefPaths: [],
            ttlSeconds: i.ttlSeconds,
            numUses: i.numUses,
          };
        },
      },
    });
    expect((await new DeliveryStages(deps).run("mint_lease", lineage, "d-1", newDriveMemo(), "claim-1")).kind).toBe(
      "confirmed",
    );
    expect(minted).toEqual([["ref/a", "ref/b"]]);
  });
  it("degrades when the mint throws (never a silent pass)", async () => {
    const { deps } = stagesDeps({
      signals: fakeSignals({ provisionedProductionSecretRefs: async () => ["ref/a"] }),
      minter: {
        mintScopedRunToken: async () => {
          throw new Error("vault down");
        },
      },
    });
    const out = await new DeliveryStages(deps).run("mint_lease", lineage, "d-1", newDriveMemo(), "claim-1");
    expect(out).toMatchObject({ kind: "degraded", classification: "scoped_lease_mint_failed" });
  });
});

describe("deploy + demo cluster stages drive the idempotent runners once", () => {
  it("invokes the deploy runner exactly once across the four deploy stages", async () => {
    const deployRunner = fakeRunner();
    const { deps } = stagesDeps({ deployRunner, signals: fakeSignals({ deployReach: async () => "verified" }) });
    const stages = new DeliveryStages(deps);
    const memo = newDriveMemo();
    for (const s of ["materialize_env", "attach_runtime", "deploy", "verify_deploy"] as DeliveryStage[]) {
      expect((await stages.run(s, lineage, "d-1", memo, "claim-1")).kind).toBe("confirmed");
    }
    expect(deployRunner.calls).toEqual(["run-1"]);
  });
  it("folds a deploy-runner throw into an 'expected' reach that degrades materialize_env", async () => {
    let threwSeen = false;
    const deployRunner = fakeRunner(async () => {
      throw new Error("proof gate blocked");
    });
    const { deps } = stagesDeps({
      deployRunner,
      signals: fakeSignals({
        deployReach: async (_l, threw) => {
          threwSeen = threw;
          return threw ? "expected" : "none";
        },
      }),
    });
    const out = await new DeliveryStages(deps).run("materialize_env", lineage, "d-1", newDriveMemo(), "claim-1");
    expect(threwSeen).toBe(true);
    expect(out.kind).toBe("degraded");
  });
  it("confirms the demo cluster when the effect was independently observed", async () => {
    const { deps } = stagesDeps({
      signals: fakeSignals({ deployReach: async () => "verified", demoReach: async () => "observed" }),
    });
    const stages = new DeliveryStages(deps);
    const memo = newDriveMemo();
    expect((await stages.run("stimulate", lineage, "d-1", memo, "claim-1")).kind).toBe("confirmed");
    expect((await stages.run("observe", lineage, "d-1", memo, "claim-1")).kind).toBe("confirmed");
  });
});

describe("record_evidence stage (the fail-closed completion gate)", () => {
  it("degrades fail-closed when a release-required A3 effect lacks positive evidence", async () => {
    const { deps, events } = stagesDeps({
      signals: fakeSignals({ releaseRequiredA3Count: async () => ({ required: 1, confirmed: 0 }) }),
    });
    const out = await new DeliveryStages(deps).run("record_evidence", lineage, "d-1", newDriveMemo(), "claim-1");
    expect(out).toMatchObject({ kind: "degraded", classification: "product_integration_effect_unconfirmed" });
    // NEVER a completed attestation without the effect
    expect(events.appended).toHaveLength(0);
  });
  it("records the signed delivery.completed attestation and confirms on the common path", async () => {
    const { deps, events } = stagesDeps({
      signals: fakeSignals({
        deployReach: async () => "verified",
        demoReach: async () => "observed",
        verifiedDeploymentId: async () => "dep-9",
      }),
    });
    const out = await new DeliveryStages(deps).run("record_evidence", lineage, "d-2", newDriveMemo(), "claim-1");
    expect(out.kind).toBe("confirmed");
    expect(events.appended).toHaveLength(1);
    const ev = events.appended[0];
    expect(ev?.eventType).toBe("delivery.completed");
    expect(ev?.payload).toMatchObject({ deliveryRunId: "d-2", observedEffect: "demo_observed", deploymentId: "dep-9" });
  });
  it("does not double-emit on resume when the attestation already exists", async () => {
    const { deps, events } = stagesDeps({ signals: fakeSignals({ deliveryCompletedExists: async () => true }) });
    expect(
      (await new DeliveryStages(deps).run("record_evidence", lineage, "d-1", newDriveMemo(), "claim-1")).kind,
    ).toBe("confirmed");
    expect(events.appended).toHaveLength(0);
  });
});
