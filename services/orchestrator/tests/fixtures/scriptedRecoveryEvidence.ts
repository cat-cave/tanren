// TEST FIXTURE: scriptable RecoveryEvidencePort for unit tests.
// Production uses PgRecoveryEvidencePort; tests that exercise conflict dequeue
// must inject a port that proves ownership — absence fails closed at settlement.
// Enqueued proof mirrors production SQL: task id + run id + kind = 'plan'.
// A same-run non-plan task must NOT satisfy plannerTaskId.

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
  /**
   * Planner tasks (kind=plan) accepted for enqueued receipts.
   * Production binds `tasks.kind = 'plan'` — non-plan task ids must use
   * {@link nonPlanTaskIds} and never prove enqueued ownership.
   */
  plannerTaskIds?: string[];
  /**
   * Task ids that exist on the run but are NOT kind=plan (write/check/etc).
   * Hostile tests: a same-run non-plan task must fail verifyOwnedReceipt.
   */
  nonPlanTaskIds?: string[];
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

  /** Seed a successful enqueued ownership for a fresh replan run (plan-kind task). */
  seedEnqueued(
    specId: string,
    replanRunId: string,
    plannerTaskId: string,
    status: ScriptedOwnerRun["status"] = "queued",
  ): void {
    this.seed(specId, { runId: replanRunId, status, plannerTaskIds: [plannerTaskId] });
  }

  /**
   * Seed a run whose only task is non-plan (write/check). Enqueued receipts naming
   * that task id must fail — mirrors production `kind = 'plan'` constraint.
   */
  seedNonPlanTask(
    specId: string,
    runId: string,
    nonPlanTaskId: string,
    status: ScriptedOwnerRun["status"] = "queued",
  ): void {
    this.seed(specId, { runId, status, nonPlanTaskIds: [nonPlanTaskId] });
  }

  async verifyOwnedReceipt(input: {
    expectedSpecId: string;
    receipt: ConflictRecoveryReceipt;
  }): Promise<RecoveryRunEvidence | undefined> {
    if (this.rejectAll) return;
    if (!hasStructuralOwnedReceiptShape(input.receipt, input.expectedSpecId)) return;

    const namedRunId =
      input.receipt.run.kind === "already_running" ? input.receipt.run.runId : input.receipt.run.replanRunId;
    const plannerTaskId = input.receipt.run.kind === "enqueued" ? input.receipt.run.plannerTaskId : undefined;

    for (const [specId, runs] of this.bySpec) {
      for (const run of runs) {
        if (run.runId !== namedRunId) continue;
        const effectiveSpec = run.wrongSpecId ?? specId;
        if (effectiveSpec !== input.expectedSpecId) continue;
        if (!isActiveOwnerRunStatus(run.status)) continue;
        if (plannerTaskId !== undefined) {
          // Production: task must be kind=plan on this run. Non-plan tasks fail.
          if (run.nonPlanTaskIds?.includes(plannerTaskId)) continue;
          if (run.plannerTaskIds === undefined || !run.plannerTaskIds.includes(plannerTaskId)) continue;
        }
        return {
          runId: run.runId,
          specId: effectiveSpec,
          runStatus: run.status,
          ...(plannerTaskId !== undefined && { plannerTaskId }),
        };
      }
    }
  }
}
