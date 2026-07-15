// Scripted RecoveryEvidencePort for unit tests — never fabricates beyond the script.

import type { ConflictRecoveryReceipt } from "../../src/engine/contracts/conflictResolution.js";
import type { RecoveryEvidencePort, RecoveryRunEvidence } from "../../src/engine/merge/recoveryOwnership.js";
import { hasStructuralOwnedReceiptShape, isActiveOwnerRunStatus } from "../../src/engine/merge/recoveryOwnership.js";

export class ScriptedRecoveryEvidencePort implements RecoveryEvidencePort {
  /** When true, any structurally valid receipt verifies as an active owner. */
  constructor(private readonly mode: "accept-structural" | "reject-all" = "accept-structural") {}

  async verifyOwnedReceipt(input: {
    expectedOrgId: string;
    expectedProjectId: string;
    expectedSpecId: string;
    receipt: ConflictRecoveryReceipt;
  }): Promise<RecoveryRunEvidence | undefined> {
    if (this.mode === "reject-all") return undefined;
    if (!hasStructuralOwnedReceiptShape(input.receipt, input.expectedSpecId)) return undefined;
    if (input.receipt.run.kind === "enqueued") {
      return {
        orgId: input.expectedOrgId,
        projectId: input.expectedProjectId,
        runId: input.receipt.run.replanRunId,
        specId: input.expectedSpecId,
        runStatus: "queued",
        plannerTaskId: input.receipt.run.plannerTaskId,
      };
    }
    if (!isActiveOwnerRunStatus("running")) return undefined;
    return {
      orgId: input.expectedOrgId,
      projectId: input.expectedProjectId,
      runId: input.receipt.run.runId,
      specId: input.expectedSpecId,
      runStatus: "running",
    };
  }
}
