// Re-gate the rebased branch; pending holds and records durable held lineage (gv-17).

import type { SpeculativeDependent } from "../contracts/changePercolation.js";
import type { IntegrationNode } from "../contracts/integrationNodes.js";
import type { AncestorStack } from "./ancestorStack.js";
import { emitHeldOnPendingRegate } from "./baseShiftEmit.js";
import {
  BaseShiftHeldError,
  type BaseShiftEventEmitter,
  type BaseShiftInvalidationCause,
  type ReGateResult,
  type ReGateVerdict,
} from "./baseShiftPorts.js";

// Use structural type instead.
export async function reGateOrHold(
  deps: {
    reGate: {
      reGate(input: {
        projectId: string;
        dependent: SpeculativeDependent;
        rebasedHeadSha: string;
      }): Promise<ReGateVerdict | ReGateResult>;
    };
    events: BaseShiftEventEmitter;
  },
  projectId: string,
  dependent: SpeculativeDependent,
  rebasedHeadSha: string,
  lineageContext?: {
    branch: string;
    newBaseSha: string;
    ancestorStack?: AncestorStack;
    lineageAncestorSpecId?: string;
    priorNodes?: ReadonlyArray<IntegrationNode>;
    invalidationCause: BaseShiftInvalidationCause;
  },
): Promise<{ verdict: "passed" | "failed"; gateError?: string }> {
  let result: ReGateVerdict | ReGateResult;
  try {
    result = await deps.reGate.reGate({ projectId, dependent, rebasedHeadSha });
  } catch (error) {
    throw new BaseShiftHeldError("regate", error instanceof Error ? error.message : String(error));
  }
  const verdict = typeof result === "string" ? result : result.verdict;
  const gateError = typeof result === "string" ? undefined : result.gateError;
  if (verdict === "pending") {
    if (lineageContext !== undefined) {
      await emitHeldOnPendingRegate(deps.events, projectId, dependent, rebasedHeadSha, lineageContext);
    }
    throw new BaseShiftHeldError("regate", "the re-gate did not converge (held, not merged)");
  }
  return { verdict, ...(gateError !== undefined && { gateError }) };
}
