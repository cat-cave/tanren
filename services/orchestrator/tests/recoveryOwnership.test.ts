// Pure + dual-coordinator recovery ownership proofs (audit follow-up).
// SpecNotRunnableError is never ownership; settlement requires RecoveryEvidencePort
// store readback; allowlist of recoverable sources; active-owner run statuses only.

import { describe, expect, it } from "vitest";
import type { ConflictRecoveryReceipt } from "../src/engine/contracts/conflictResolution.js";
import {
  hasStructuralOwnedReceiptShape,
  isActiveOwnerRunStatus,
  isRecoverableSourceSpecStatus,
} from "../src/engine/merge/recoveryOwnership.js";
import { PgRecoveryEvidencePort } from "../src/engine/merge/recoveryEvidencePg.js";
import { EventEmittingMergeCoordinator } from "../src/engine/merge/coordinator.js";
import {
  InMemoryMergeQueueModel,
  RecordingMergeQueueEventEmitter,
  RecordingSpecEscalator,
  ScriptedMergeRunner,
} from "./conformance/fakes/inMemoryMergeQueue.js";
import { RecordingBatchGateReworkRouter } from "./conformance/fakes/inMemoryBatchChecker.js";
import { ScriptedRecoveryEvidencePort } from "./fixtures/scriptedRecoveryEvidence.js";

describe("hasStructuralOwnedReceiptShape — pre-check only (never sufficient alone)", () => {
  const ownedEnqueued = (specId: string, runId = "run_r", taskId = "task_r"): ConflictRecoveryReceipt => ({
    kind: "planner_replan",
    specId,
    run: { kind: "enqueued", replanRunId: runId, plannerTaskId: taskId },
  });

  it("accepts matching non-empty enqueued shape", () => {
    expect(hasStructuralOwnedReceiptShape(ownedEnqueued("spec_a"), "spec_a")).toBe(true);
  });

  it("rejects wrong-spec and empty ids", () => {
    expect(hasStructuralOwnedReceiptShape(ownedEnqueued("spec_other"), "spec_a")).toBe(false);
    expect(hasStructuralOwnedReceiptShape(ownedEnqueued("spec_a", "", "task"), "spec_a")).toBe(false);
  });
});

describe("isRecoverableSourceSpecStatus — fail-closed allowlist", () => {
  it("allows only open / in_flight / review", () => {
    expect(isRecoverableSourceSpecStatus("open")).toBe(true);
    expect(isRecoverableSourceSpecStatus("in_flight")).toBe(true);
    expect(isRecoverableSourceSpecStatus("review")).toBe(true);
  });

  it("rejects terminal-blocked and unknown statuses", () => {
    for (const s of ["merged", "halted", "cancelled", "needs_attention", "blocked", "unknown", ""]) {
      expect(isRecoverableSourceSpecStatus(s)).toBe(false);
    }
  });
});

describe("isActiveOwnerRunStatus — excludes halted", () => {
  it("allows queued/running/paused only", () => {
    expect(isActiveOwnerRunStatus("queued")).toBe(true);
    expect(isActiveOwnerRunStatus("running")).toBe(true);
    expect(isActiveOwnerRunStatus("paused")).toBe(true);
    expect(isActiveOwnerRunStatus("halted")).toBe(false);
    expect(isActiveOwnerRunStatus("completed")).toBe(false);
  });
});

describe("PgRecoveryEvidencePort — store readback", () => {
  function poolWithRows(handlers: Array<{ match: (sql: string) => boolean; rows: unknown[] }>) {
    return {
      async query(sql: string) {
        for (const h of handlers) {
          if (h.match(String(sql))) return { rows: h.rows };
        }
        return { rows: [] };
      },
    };
  }

  it("proves enqueued receipt when run+task bind to expected spec and are active", async () => {
    const port = new PgRecoveryEvidencePort(
      poolWithRows([
        {
          match: (s) => s.includes("FROM runs") && s.includes("run_id"),
          rows: [{ run_id: "run_r", spec_id: "spec_a", status: "queued" }],
        },
        {
          match: (s) => s.includes("FROM tasks"),
          rows: [{ task_id: "task_r" }],
        },
      ]),
    );
    const evidence = await port.verifyOwnedReceipt({
      expectedSpecId: "spec_a",
      receipt: {
        kind: "planner_replan",
        specId: "spec_a",
        run: { kind: "enqueued", replanRunId: "run_r", plannerTaskId: "task_r" },
      },
    });
    expect(evidence).toEqual({
      runId: "run_r",
      specId: "spec_a",
      runStatus: "queued",
      plannerTaskId: "task_r",
    });
  });

  it("rejects halted run status", async () => {
    const port = new PgRecoveryEvidencePort(
      poolWithRows([
        {
          match: (s) => s.includes("FROM runs"),
          rows: [{ run_id: "run_r", spec_id: "spec_a", status: "halted" }],
        },
      ]),
    );
    const evidence = await port.verifyOwnedReceipt({
      expectedSpecId: "spec_a",
      receipt: {
        kind: "planner_replan",
        specId: "spec_a",
        run: { kind: "already_running", runId: "run_r" },
      },
    });
    expect(evidence).toBeUndefined();
  });

  it("rejects run-to-spec mismatch", async () => {
    const port = new PgRecoveryEvidencePort(
      poolWithRows([
        {
          match: (s) => s.includes("FROM runs"),
          rows: [{ run_id: "run_r", spec_id: "spec_other", status: "running" }],
        },
      ]),
    );
    const evidence = await port.verifyOwnedReceipt({
      expectedSpecId: "spec_a",
      receipt: {
        kind: "planner_replan",
        specId: "spec_a",
        run: { kind: "already_running", runId: "run_r" },
      },
    });
    expect(evidence).toBeUndefined();
  });

  it("rejects enqueued receipt when planner task is not bound to the run", async () => {
    const port = new PgRecoveryEvidencePort(
      poolWithRows([
        {
          match: (s) => s.includes("FROM runs"),
          rows: [{ run_id: "run_r", spec_id: "spec_a", status: "queued" }],
        },
        { match: (s) => s.includes("FROM tasks"), rows: [] },
      ]),
    );
    const evidence = await port.verifyOwnedReceipt({
      expectedSpecId: "spec_a",
      receipt: {
        kind: "planner_replan",
        specId: "spec_a",
        run: { kind: "enqueued", replanRunId: "run_r", plannerTaskId: "task_forged" },
      },
    });
    expect(evidence).toBeUndefined();
  });
});

describe("EventEmittingMergeCoordinator — failed-drive parity + evidence", () => {
  const PROJECT = "project_parity";

  it("routes a failed drive to writer rework when gateRework is wired", async () => {
    const queue = new InMemoryMergeQueueModel();
    const runner = new ScriptedMergeRunner();
    const events = new RecordingMergeQueueEventEmitter();
    const escalator = new RecordingSpecEscalator();
    const gateRework = new RecordingBatchGateReworkRouter();
    queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    runner.script("run_a", { kind: "failed", message: "fresh pre_merge failed" });
    const coordinator = new EventEmittingMergeCoordinator({
      queue,
      runner,
      events,
      escalator,
      gateRework,
    });

    const result = await coordinator.coordinate(PROJECT);

    expect(result.dequeuedSpecId).toBe("spec_a");
    expect(gateRework.routed.map((r) => r.specId)).toEqual(["spec_a"]);
    expect(queue.dequeueReasonOf("run_a")).toBe("superseded");
  });

  it("parks conflict without RecoveryEvidencePort even with a well-formed receipt", async () => {
    const queue = new InMemoryMergeQueueModel();
    const runner = new ScriptedMergeRunner();
    const events = new RecordingMergeQueueEventEmitter();
    const escalator = new RecordingSpecEscalator();
    queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    runner.script("run_a", {
      kind: "conflict",
      message: "typed receipt",
      recovery: {
        kind: "planner_replan",
        specId: "spec_a",
        run: { kind: "enqueued", replanRunId: "r", plannerTaskId: "t" },
      },
    });
    const coordinator = new EventEmittingMergeCoordinator({ queue, runner, events, escalator });

    await coordinator.coordinate(PROJECT);

    expect(queue.dequeueReasonOf("run_a")).toBe("needs_attention");
    expect(escalator.escalations[0]?.message).toMatch(/no RecoveryEvidencePort/u);
  });

  it("dequeues conflict only when evidence port proves the active owner run", async () => {
    const queue = new InMemoryMergeQueueModel();
    const runner = new ScriptedMergeRunner();
    const events = new RecordingMergeQueueEventEmitter();
    const escalator = new RecordingSpecEscalator();
    const evidence = new ScriptedRecoveryEvidencePort();
    evidence.seedEnqueued("spec_a", "run_replan", "task_replan", "queued");
    queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    runner.script("run_a", {
      kind: "conflict",
      message: "owned",
      recovery: {
        kind: "planner_replan",
        specId: "spec_a",
        run: { kind: "enqueued", replanRunId: "run_replan", plannerTaskId: "task_replan" },
      },
    });
    const coordinator = new EventEmittingMergeCoordinator({
      queue,
      runner,
      events,
      escalator,
      recoveryEvidence: evidence,
    });

    await coordinator.coordinate(PROJECT);

    expect(queue.dequeueReasonOf("run_a")).toBe("conflict");
    expect(escalator.escalations).toEqual([]);
  });
});
