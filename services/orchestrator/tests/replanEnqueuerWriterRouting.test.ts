// Unit test for the recovery prepare plane-split: buildReplanEnqueuer routes the
// atomic prepareSpecForRecovery (steering + allowlisted reopen) + createQueuedRun
// through the writer only (single-arg factory; no pool arity).

import { describe, expect, it } from "vitest";
import { buildReplanEnqueuer } from "../src/engine/workflow/reviewMerge/conflictResolver/replanEnqueuerPg.js";
import type {
  CreateQueuedRunInput,
  PrepareSpecForRecoveryInput,
  PrepareSpecForRecoveryResult,
  RunStateWriter,
} from "../src/engine/contracts/runStateWriter.js";
import { SpecNotPreparedForRecoveryError } from "../src/engine/workflow/projectSpecErrors.js";

const ORG = "org_v55_fix";
const PROJECT = "project_v55_fix";

interface Calls {
  prepareSpecForRecovery: PrepareSpecForRecoveryInput[];
  createQueuedRun: CreateQueuedRunInput[];
}

function recordingWriter(
  calls: Calls,
  prepareResult: PrepareSpecForRecoveryResult = { prepared: true, fromStatus: "in_flight" },
): RunStateWriter {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async prepareSpecForRecovery(input: PrepareSpecForRecoveryInput) {
      calls.prepareSpecForRecovery.push(input);
      return prepareResult;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async createQueuedRun(input: CreateQueuedRunInput) {
      calls.createQueuedRun.push(input);
      return {
        runId: `run_${calls.createQueuedRun.length}`,
        plannerTaskId: `task_${calls.createQueuedRun.length}`,
      } as never;
    },
    append: () => Promise.reject(new Error("unexpected append")),
    appendSpecSteering: () => Promise.reject(new Error("unexpected appendSpecSteering")),
    setSpecStatus: () => Promise.reject(new Error("unexpected setSpecStatus")),
    recordCost: () => Promise.reject(new Error("unexpected recordCost")),
    reconcileCost: () => Promise.reject(new Error("unexpected reconcileCost")),
    finalizeRun: () => Promise.reject(new Error("unexpected finalizeRun")),
    setRunStatus: () => Promise.reject(new Error("unexpected setRunStatus")),
    setRunPrUrl: () => Promise.reject(new Error("unexpected setRunPrUrl")),
    setRunAuthRef: () => Promise.reject(new Error("unexpected setRunAuthRef")),
    setSpecMetadata: () => Promise.reject(new Error("unexpected setSpecMetadata")),
    setRunSpeculativeBase: () => Promise.reject(new Error("unexpected setRunSpeculativeBase")),
    setRunPercolationReexecId: () => Promise.reject(new Error("unexpected setRunPercolationReexecId")),
    clearRunPercolationPending: () => Promise.reject(new Error("unexpected clearRunPercolationPending")),
    mergeRunVerifiedAncestorSha: () => Promise.reject(new Error("unexpected mergeRunVerifiedAncestorSha")),
    supersedeQueuedPlannerTask: () => Promise.reject(new Error("unexpected supersedeQueuedPlannerTask")),
    finalizeLand: () => Promise.reject(new Error("unexpected finalizeLand")),
    recordDraftPrCreated: () => Promise.reject(new Error("unexpected recordDraftPrCreated")),
    insertTask: () => Promise.reject(new Error("unexpected insertTask")),
    updateTask: () => Promise.reject(new Error("unexpected updateTask")),
    updateTaskWithEvent: () => Promise.reject(new Error("unexpected updateTaskWithEvent")),
    finalizeRunWithEvent: () => Promise.reject(new Error("unexpected finalizeRunWithEvent")),
    updateSpecWithEvent: () => Promise.reject(new Error("unexpected updateSpecWithEvent")),
    createSpec: () => Promise.reject(new Error("unexpected createSpec")),
    resumePausedRunAtomic: () => Promise.reject(new Error("unexpected resumePausedRunAtomic")),
  } as unknown as RunStateWriter;
}

describe("buildReplanEnqueuer — atomic prepareSpecForRecovery via writer", () => {
  it("routes prepare + createQueuedRun through the writer (writer-only arity)", async () => {
    const calls: Calls = { prepareSpecForRecovery: [], createQueuedRun: [] };
    const enqueuer = buildReplanEnqueuer(recordingWriter(calls));

    const result = await enqueuer.enqueue({
      specId: "spec_rework",
      orgId: ORG,
      projectId: PROJECT,
      steeringNote: "[gate fail] step lint: missing-semicolon at vitest.config.ts:42",
      reopenStatus: "open",
    });

    expect(calls.prepareSpecForRecovery).toEqual([
      {
        specId: "spec_rework",
        orgId: ORG,
        steeringNote: "[gate fail] step lint: missing-semicolon at vitest.config.ts:42",
        reopenStatus: "open",
      },
    ]);
    expect(calls.createQueuedRun).toHaveLength(1);
    expect(calls.createQueuedRun[0]?.input).toEqual({ specId: "spec_rework", trigger: "replan_routed" });
    expect(result.replanRunId).toBe("run_1");
    expect(result.plannerTaskId).toBe("task_1");
  });

  it("does not create a run when prepare refuses a terminal status", async () => {
    const calls: Calls = { prepareSpecForRecovery: [], createQueuedRun: [] };
    const enqueuer = buildReplanEnqueuer(
      recordingWriter(calls, { prepared: false, reason: "not_recoverable", status: "merged" }),
    );

    await expect(
      enqueuer.enqueue({
        specId: "spec_merged",
        orgId: ORG,
        projectId: PROJECT,
        steeringNote: "nope",
        reopenStatus: "open",
      }),
    ).rejects.toBeInstanceOf(SpecNotPreparedForRecoveryError);

    expect(calls.createQueuedRun).toHaveLength(0);
  });

  it("does not create a run when prepare reports missing spec", async () => {
    const calls: Calls = { prepareSpecForRecovery: [], createQueuedRun: [] };
    const enqueuer = buildReplanEnqueuer(recordingWriter(calls, { prepared: false, reason: "missing" }));

    await expect(
      enqueuer.enqueue({
        specId: "spec_gone",
        orgId: ORG,
        projectId: PROJECT,
        steeringNote: "nope",
        reopenStatus: "open",
      }),
    ).rejects.toBeInstanceOf(SpecNotPreparedForRecoveryError);

    expect(calls.createQueuedRun).toHaveLength(0);
  });
});
