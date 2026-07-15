import { describe, expect, it } from "vitest";
import type { ConflictRecoveryReceipt } from "../src/engine/contracts/conflictResolution.js";
import {
  hasStructuralOwnedReceiptShape,
  isActiveOwnerRunStatus,
  isRecoverableSourceSpecStatus,
  verifyRecoveryOwnership,
} from "../src/engine/merge/recoveryOwnership.js";
import { ScriptedRecoveryEvidencePort } from "./fixtures/scriptedRecoveryEvidence.js";

function ownedEnqueued(specId: string, runId = "run_r", taskId = "task_r"): ConflictRecoveryReceipt {
  return {
    kind: "planner_replan",
    specId,
    run: { kind: "enqueued", replanRunId: runId, plannerTaskId: taskId },
  };
}

describe("hasStructuralOwnedReceiptShape", () => {
  it("accepts matching non-empty enqueued shape", () => {
    expect(hasStructuralOwnedReceiptShape(ownedEnqueued("spec_a"), "spec_a")).toBe(true);
  });
  it("rejects wrong-spec and empty ids", () => {
    expect(hasStructuralOwnedReceiptShape(ownedEnqueued("spec_other"), "spec_a")).toBe(false);
    expect(hasStructuralOwnedReceiptShape(ownedEnqueued("spec_a", "", "task"), "spec_a")).toBe(false);
  });
});

describe("status allowlists", () => {
  it("recoverable source specs are open/in_flight/review only", () => {
    expect(isRecoverableSourceSpecStatus("open")).toBe(true);
    expect(isRecoverableSourceSpecStatus("merged")).toBe(false);
  });
  it("active owner excludes halted", () => {
    expect(isActiveOwnerRunStatus("running")).toBe(true);
    expect(isActiveOwnerRunStatus("halted")).toBe(false);
  });
});

describe("verifyRecoveryOwnership", () => {
  it("fails closed without evidence port", async () => {
    const r = await verifyRecoveryOwnership({
      evidence: undefined,
      expectedSpecId: "spec_a",
      receipt: ownedEnqueued("spec_a"),
      contextMessage: "ctx",
    });
    expect(r.ok).toBe(false);
  });
  it("accepts structural receipt under accept-structural port", async () => {
    const r = await verifyRecoveryOwnership({
      evidence: new ScriptedRecoveryEvidencePort("accept-structural"),
      expectedSpecId: "spec_a",
      receipt: ownedEnqueued("spec_a"),
      contextMessage: "ctx",
    });
    expect(r.ok).toBe(true);
  });
  it("rejects under reject-all port", async () => {
    const r = await verifyRecoveryOwnership({
      evidence: new ScriptedRecoveryEvidencePort("reject-all"),
      expectedSpecId: "spec_a",
      receipt: ownedEnqueued("spec_a"),
      contextMessage: "ctx",
    });
    expect(r.ok).toBe(false);
  });
});
