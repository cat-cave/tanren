import { describe, expect, it } from "vitest";
import type { RecoveryPreparationOutcome } from "../src/engine/contracts/recoveryPreparation.js";
import { SpecStatusGateReworkRouter } from "../src/engine/workflow/reviewMerge/conflictResolver/gateReworkRouter.js";
import {
  gateErrorSignature,
  type ReplanEnqueuer,
} from "../src/engine/workflow/reviewMerge/conflictResolver/replanRouter.js";

const SPEC = "spec_b";
const DEFAULT_OUTCOME: RecoveryPreparationOutcome = {
  kind: "owned",
  newlyPrepared: true,
  receipt: {
    kind: "writer_rework",
    specId: SPEC,
    run: { kind: "enqueued", replanRunId: "run_new", plannerTaskId: "task_new" },
  },
};

class Enqueuer implements ReplanEnqueuer {
  calls: Parameters<ReplanEnqueuer["enqueue"]>[0][] = [];
  constructor(private readonly outcome: RecoveryPreparationOutcome = DEFAULT_OUTCOME) {}
  async enqueue(input: Parameters<ReplanEnqueuer["enqueue"]>[0]) {
    this.calls.push(input);
    return this.outcome;
  }
}

function router(enqueuer: ReplanEnqueuer, prior: string[] = []) {
  return new SpecStatusGateReworkRouter({
    orgId: "org_test",
    runId: "run_old",
    projectId: "project_test",
    prNumber: 9,
    enqueuer,
    priorReworks: () => Promise.resolve(prior),
  });
}

describe("SpecStatusGateReworkRouter atomic preparation", () => {
  it("passes exact regate routing bytes to the preparation authority", async () => {
    const enqueuer = new Enqueuer();
    const gateError = "tier-2 test failed";
    await expect(router(enqueuer).routeGateFailToRework({ specId: SPEC, gateError })).resolves.toMatchObject({
      kind: "owned",
    });
    expect(enqueuer.calls[0]).toMatchObject({
      specId: SPEC,
      oldRunId: "run_old",
      reopenStatus: "open",
      route: { kind: "regate_writer_rework", prNumber: 9, gateError, priorReworks: 0 },
    });
    expect(enqueuer.calls[0]?.steeringNote).toContain(gateError);
  });

  it("continues while gate signatures change and stops before a fixed point write", async () => {
    const progressing = new Enqueuer();
    await router(
      progressing,
      ["a", "b"].map((error) => gateErrorSignature(error)),
    ).routeGateFailToRework({
      specId: SPEC,
      gateError: "c",
    });
    expect(progressing.calls).toHaveLength(1);

    const stuck = new Enqueuer();
    const signature = gateErrorSignature("same");
    const outcome = await router(stuck, [signature, signature]).routeGateFailToRework({
      specId: SPEC,
      gateError: "same",
    });
    expect(outcome.kind).toBe("parking_required");
    expect(stuck.calls).toHaveLength(0);
  });

  it("retains preparation uncertainty", async () => {
    const result = await router(
      new Enqueuer({ kind: "failure", reason: "transport_failed", message: "readback failed" }),
    ).routeGateFailToRework({ specId: SPEC, gateError: "failed" });
    expect(result).toEqual({ kind: "parking_failed", message: "readback failed" });
  });
});
