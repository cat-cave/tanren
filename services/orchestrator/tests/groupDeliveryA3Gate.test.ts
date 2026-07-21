import { describe, expect, it } from "vitest";
import type { DeliveryBindingSetSealer } from "../src/engine/postMerge/delivery/deliveryBindingSet.js";
import type { DeliverySignals } from "../src/engine/postMerge/delivery/deliverySignals.js";
import {
  ProductionGroupDeliveryA3Gate,
  type GroupDeliveryA3CoordinateStore,
} from "../src/engine/postMerge/landGroupDelivery/groupDeliveryA3Gate.js";
import type { GroupDeliveryPlan } from "../src/engine/postMerge/landGroupDelivery/groupDeliveryCore.js";

const PLAN: GroupDeliveryPlan = {
  orgId: "org-a3",
  projectId: "project-a3",
  landGroupId: "group-a3",
  mainSha: "a".repeat(40),
  tailRunId: "run-tail",
  tailSpecId: "spec-tail",
  deliveryRunId: "delivery-decision-a3",
  memberRunIds: ["run-member", "run-tail"],
  memberSpecIds: ["spec-member", "spec-tail"],
};

function setup(input: { sealed: boolean; required: number; confirmed: number }) {
  const calls: string[] = [];
  const payloads: unknown[] = [];
  const store: GroupDeliveryA3CoordinateStore = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async claimExact(request) {
      calls.push(`claim:${request.deliveryRunId}`);
      return {
        id: request.deliveryRunId,
        projectId: request.projectId,
        mergeSha: request.mergeSha,
        authorityDecisionId: "decision-a3",
        token: "delivery-fence",
      };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async markCompleted() {
      calls.push("complete");
      return true;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async markDegraded(_orgId, _deliveryRunId, _token, classification) {
      calls.push(`degrade:${classification}`);
      return true;
    },
  };
  const bindingSetSealer: DeliveryBindingSetSealer = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async seal(request) {
      calls.push(`seal:${request.deliveryRunId}`);
      return input.sealed ? { kind: "sealed", count: 1 } : { kind: "unavailable", detail: "binding is not sealed" };
    },
  };
  const signals = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async releaseRequiredA3Count(_lineage, deliveryRunId) {
      calls.push(`observe:${deliveryRunId}`);
      return { required: input.required, confirmed: input.confirmed };
    },
  } as DeliverySignals;
  const gate = new ProductionGroupDeliveryA3Gate({
    store,
    bindingSetSealer,
    runtimeAttachmentRecorder: { record: async () => {} },
    signals,
    integrationEvidenceAttester: { attest: async () => ({ kind: "sealed", count: 1 }) },
    evidence: {
      eventStore: {
        // eslint-disable-next-line @typescript-eslint/require-await
        async append(payload: unknown) {
          payloads.push(payload);
        },
      } as never,
      signer: { sign: () => "sha256:signature" },
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    completionEvidenceExists: async () => false,
  });
  return { gate, calls, payloads };
}

describe("ProductionGroupDeliveryA3Gate", () => {
  it("seals the grouped member coordinate, observes exact A3 evidence, and completes it", async () => {
    const { gate, calls, payloads } = setup({ sealed: true, required: 1, confirmed: 1 });
    await expect(gate.seal(PLAN)).resolves.toEqual({ kind: "confirmed" });
    await expect(gate.complete({ plan: PLAN, deploymentId: "deployment-a3" })).resolves.toEqual({ kind: "confirmed" });
    expect(calls).toEqual([
      `claim:${PLAN.deliveryRunId}`,
      `seal:${PLAN.deliveryRunId}`,
      `claim:${PLAN.deliveryRunId}`,
      `seal:${PLAN.deliveryRunId}`,
      `observe:${PLAN.deliveryRunId}`,
      "complete",
    ]);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      eventType: "delivery.completed",
      payload: { deliveryRunId: PLAN.deliveryRunId, observedEffect: "demo_observed" },
    });
  });

  it("negative control: an unsealed required binding blocks before the A3 observation", async () => {
    const { gate, calls, payloads } = setup({ sealed: false, required: 1, confirmed: 0 });
    await expect(gate.seal(PLAN)).resolves.toMatchObject({ kind: "blocked" });
    expect(calls).toEqual([
      `claim:${PLAN.deliveryRunId}`,
      `seal:${PLAN.deliveryRunId}`,
      "degrade:release_binding_set_unconfirmed",
    ]);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ eventType: "delivery.degraded" });
  });

  it("negative control: absent observed effect blocks and never marks the group coordinate complete", async () => {
    const { gate, calls, payloads } = setup({ sealed: true, required: 1, confirmed: 0 });
    await expect(gate.complete({ plan: PLAN, deploymentId: "deployment-a3" })).resolves.toMatchObject({
      kind: "blocked",
    });
    expect(calls).toEqual([
      `claim:${PLAN.deliveryRunId}`,
      `seal:${PLAN.deliveryRunId}`,
      `observe:${PLAN.deliveryRunId}`,
      "degrade:product_integration_effect_unconfirmed",
    ]);
    expect(calls).not.toContain("complete");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ eventType: "delivery.degraded" });
  });
});
