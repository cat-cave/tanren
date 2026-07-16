import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { MergeQueueEntry } from "../src/engine/contracts/mergeCoordinator.js";
import type { RecoveryPreparationOutcome } from "../src/engine/contracts/recoveryPreparation.js";
import { PgBatchGateReworkRouter } from "../src/engine/merge/batchGateReworkRouter.js";
import {
  gateErrorSignature,
  type ReplanEnqueuer,
} from "../src/engine/workflow/reviewMerge/conflictResolver/replanRouter.js";
import { InMemoryRunStateWriter } from "./fixtures/inMemoryRunStateWriter.js";

const CULPRIT: MergeQueueEntry = {
  orgId: "org_test",
  projectId: "project_test",
  queueId: "queue_old",
  runId: "run_old",
  specId: "spec_old",
  prUrl: "https://example.test/pull/7",
  prNumber: 7,
  dependsOn: [],
  priority: "tbd",
  orderKey: 1,
};
const DEFAULT_OUTCOME: RecoveryPreparationOutcome = {
  kind: "owned",
  newlyPrepared: true,
  receipt: {
    kind: "writer_rework",
    specId: CULPRIT.specId,
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
  return new PgBatchGateReworkRouter({
    pool: {} as pg.Pool,
    runStateWriter: new InMemoryRunStateWriter(),
    enqueuer,
    priorReworks: () => Promise.resolve(prior),
    resolveOrg: () => Promise.resolve(CULPRIT.orgId),
  });
}

describe("PgBatchGateReworkRouter atomic preparation", () => {
  it("binds preparation to the exact queue tuple and batch route", async () => {
    const enqueuer = new Enqueuer();
    const gateError = "integrated lint failed";
    await expect(
      router(enqueuer).routeGateFailToRework({ projectId: CULPRIT.projectId, culprit: CULPRIT, gateError }),
    ).resolves.toMatchObject({ kind: "owned" });
    expect(enqueuer.calls[0]).toMatchObject({
      oldRunId: CULPRIT.runId,
      queueId: CULPRIT.queueId,
      route: { kind: "batch_writer_rework", prNumber: 7, gateError, priorReworks: 0 },
    });
  });

  it("stops at a fixed point and retains an uncertain preparation", async () => {
    const stuck = new Enqueuer();
    const signature = gateErrorSignature("same");
    const fixed = await router(stuck, [signature, signature]).routeGateFailToRework({
      projectId: CULPRIT.projectId,
      culprit: CULPRIT,
      gateError: "same",
    });
    expect(fixed.kind).toBe("parking_required");
    expect(stuck.calls).toHaveLength(0);

    const uncertain = await router(
      new Enqueuer({ kind: "failure", reason: "transport_failed", message: "readback unavailable" }),
    ).routeGateFailToRework({ projectId: CULPRIT.projectId, culprit: CULPRIT, gateError: "new" });
    expect(uncertain).toEqual({ kind: "parking_failed", message: "readback unavailable" });
  });
});
