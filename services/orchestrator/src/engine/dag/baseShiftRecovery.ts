// Base-shift consumer of the canonical typed recovery settlement. Kept separate
// from the coordinator so the policy is small and mutation-testable: no
// parking_required escapes, and the percolation marker is cleared only after
// durable ownership, an atomic park, or a concurrent terminal result.

import type { SpeculativeDependent } from "../contracts/changePercolation.js";
import type {
  ConflictRecoveryDisposition,
  ConflictRecoverySettlement,
  DurableConflictRecoverySettlement,
} from "../contracts/conflictResolution.js";
import { BaseShiftHeldError, type BaseShiftPersistence, type RebaseDecision } from "./baseShiftPorts.js";

export async function settleBaseShiftRecovery(
  persistence: BaseShiftPersistence,
  input: { projectId: string; dependent: SpeculativeDependent },
  recovery: ConflictRecoveryDisposition,
): Promise<DurableConflictRecoverySettlement> {
  let settled: ConflictRecoverySettlement;
  try {
    settled = await persistence.settleRecovery({
      projectId: input.projectId,
      specId: input.dependent.specId,
      runId: input.dependent.runId,
      recovery,
    });
  } catch (error) {
    throw new BaseShiftHeldError("recovery", error instanceof Error ? error.message : String(error));
  }
  if (settled.kind === "parking_failed") {
    throw new BaseShiftHeldError("recovery", settled.message, settled);
  }
  try {
    await persistence.clearInFlight({ projectId: input.projectId, runId: input.dependent.runId });
  } catch (error) {
    throw new BaseShiftHeldError("recovery", error instanceof Error ? error.message : String(error), settled);
  }
  return settled;
}

export function rebaseDecisionFromRecovery(recovery: DurableConflictRecoverySettlement): RebaseDecision {
  return recovery.kind === "owned" ? "replanned" : "held";
}
