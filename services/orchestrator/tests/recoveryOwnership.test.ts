import { describe, expect, it } from "vitest";
import type { ConflictRecoveryReceipt } from "../src/engine/contracts/conflictResolution.js";
import {
  hasStructuralOwnedReceiptShape,
  isActiveOwnerRunStatus,
  isRecoverableSourceSpecStatus,
  verifyRecoveryOwnership,
  type RecoveryRunEvidence,
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
      expectedOrgId: "org_a",
      expectedProjectId: "project_a",
      expectedSpecId: "spec_a",
      priorRunId: "run_old",
      receipt: ownedEnqueued("spec_a"),
      contextMessage: "ctx",
    });
    expect(r.ok).toBe(false);
  });
  it("accepts structural receipt under accept-structural port", async () => {
    const r = await verifyRecoveryOwnership({
      evidence: new ScriptedRecoveryEvidencePort("accept-structural"),
      expectedOrgId: "org_a",
      expectedProjectId: "project_a",
      expectedSpecId: "spec_a",
      priorRunId: "run_old",
      receipt: ownedEnqueued("spec_a"),
      contextMessage: "ctx",
    });
    expect(r.ok).toBe(true);
  });
  it("rejects under reject-all port", async () => {
    const r = await verifyRecoveryOwnership({
      evidence: new ScriptedRecoveryEvidencePort("reject-all"),
      expectedOrgId: "org_a",
      expectedProjectId: "project_a",
      expectedSpecId: "spec_a",
      priorRunId: "run_old",
      receipt: ownedEnqueued("spec_a"),
      contextMessage: "ctx",
    });
    expect(r.ok).toBe(false);
  });

  it.each([
    ["org", { orgId: "org_wrong" }],
    ["project", { projectId: "project_wrong" }],
    ["spec", { specId: "spec_wrong" }],
    ["run", { runId: "run_wrong" }],
    ["status", { runStatus: "halted" }],
    ["planner task", { plannerTaskId: "task_wrong" }],
    ["planner kind", { plannerTaskKind: "write" }],
  ] as const)("rejects a port that returns mismatched %s evidence", async (_name, changed) => {
    const receipt = ownedEnqueued("spec_a");
    const exact: RecoveryRunEvidence = {
      orgId: "org_a",
      projectId: "project_a",
      specId: "spec_a",
      runId: "run_r",
      runStatus: "running",
      plannerTaskId: "task_r",
      plannerTaskKind: "plan",
    };
    const r = await verifyRecoveryOwnership({
      evidence: { verifyOwnedReceipt: () => Promise.resolve({ ...exact, ...changed }) },
      expectedOrgId: "org_a",
      expectedProjectId: "project_a",
      expectedSpecId: "spec_a",
      priorRunId: "run_old",
      receipt,
      contextMessage: "ctx",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects unexpected planner evidence on already_running", async () => {
    const receipt: ConflictRecoveryReceipt = {
      kind: "planner_replan",
      specId: "spec_a",
      run: { kind: "already_running", runId: "run_r" },
    };
    const r = await verifyRecoveryOwnership({
      evidence: {
        verifyOwnedReceipt: () =>
          Promise.resolve({
            orgId: "org_a",
            projectId: "project_a",
            specId: "spec_a",
            runId: "run_r",
            runStatus: "running",
            plannerTaskId: "task_unexpected",
            plannerTaskKind: "plan",
          }),
      },
      expectedOrgId: "org_a",
      expectedProjectId: "project_a",
      expectedSpecId: "spec_a",
      priorRunId: "run_old",
      receipt,
      contextMessage: "ctx",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects the retiring run itself as replacement ownership", async () => {
    const receipt: ConflictRecoveryReceipt = {
      kind: "planner_replan",
      specId: "spec_a",
      run: { kind: "already_running", runId: "run_old" },
    };
    const r = await verifyRecoveryOwnership({
      evidence: {
        verifyOwnedReceipt: () =>
          Promise.resolve({
            orgId: "org_a",
            projectId: "project_a",
            specId: "spec_a",
            runId: "run_old",
            runStatus: "running",
          }),
      },
      expectedOrgId: "org_a",
      expectedProjectId: "project_a",
      expectedSpecId: "spec_a",
      priorRunId: "run_old",
      receipt,
      contextMessage: "ctx",
    });
    expect(r.ok).toBe(false);
  });
});
