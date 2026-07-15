// TEST FIXTURE: scriptable RecoveryEvidencePort for unit tests.
// Production uses PgRecoveryEvidencePort; tests that exercise conflict dequeue
// must inject a port that proves ownership — absence fails closed at settlement.

import type { ConflictRecoveryReceipt } from "../../src/engine/contracts/conflictResolution.js";
import {
  hasStructuralOwnedReceiptShape,
  isActiveOwnerRunStatus,
  type RecoveryEvidencePort,
  type RecoveryRunEvidence,
} from "../../src/engine/merge/recoveryOwnership.js";

/** One verified active owner run for a spec (test script). */
export interface ScriptedOwnerRun {
  runId: string;
  status: "queued" | "running" | "paused" | "halted" | "completed" | "failed" | "cancelled";
  /** When true, the run is registered under a different specId (mismatch cases). */
  wrongSpecId?: string;
  /** When set, planner tasks accepted for enqueued receipts. */
  plannerTaskIds?: string[];
}

/**
 * In-memory evidence port. Registers owner runs by specId; verifies receipts against
 * the registry (mirrors PgRecoveryEvidencePort semantics without a DB).
 */
export class ScriptedRecoveryEvidencePort implements RecoveryEvidencePort {
  private readonly bySpec = new Map<string, ScriptedOwnerRun[]>();
  /** When true, verifyOwnedReceipt always returns undefined (mint-then-expire cases). */
  rejectAll = false;

  seed(specId: string, run: ScriptedOwnerRun): void {
    const list = this.bySpec.get(specId) ?? [];
    list.push(run);
    this.bySpec.set(specId, list);
  }

  /** Seed a successful enqueued ownership for a fresh replan run. */
  seedEnqueued(
    specId: string,
    replanRunId: string,
    plannerTaskId: string,
    status: ScriptedOwnerRun["status"] = "queued",
  ): void {
    this.seed(specId, { runId: replanRunId, status, plannerTaskIds: [plannerTaskId] });
  }

  async verifyOwnedReceipt(input: {
    expectedSpecId: string;
    receipt: ConflictRecoveryReceipt;
  }): Promise<RecoveryRunEvidence | undefined> {
    if (this.rejectAll) return undefined;
    if (!hasStructuralOwnedReceiptShape(input.receipt, input.expectedSpecId)) return undefined;

    const namedRunId =
      input.receipt.run.kind === "already_running" ? input.receipt.run.runId : input.receipt.run.replanRunId;
    const plannerTaskId = input.receipt.run.kind === "enqueued" ? input.receipt.run.plannerTaskId : undefined;

    // Search all scripts (including wrong-spec seedings under expectedSpecId).
    for (const [specId, runs] of this.bySpec) {
      for (const run of runs) {
        if (run.runId !== namedRunId) continue;
        const effectiveSpec = run.wrongSpecId ?? specId;
        if (effectiveSpec !== input.expectedSpecId) return undefined;
        if (!isActiveOwnerRunStatus(run.status)) return undefined;
        if (plannerTaskId !== undefined) {
          if (run.plannerTaskIds === undefined || !run.plannerTaskIds.includes(plannerTaskId)) {
            return undefined;
          }
        }
        return {
          runId: run.runId,
          specId: effectiveSpec,
          runStatus: run.status,
          ...(plannerTaskId !== undefined && { plannerTaskId }),
        };
      }
    }
    return undefined;
  }
}
