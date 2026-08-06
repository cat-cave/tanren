// gv-17: emit integration.rebase + durable before/after member lineage.

import type { IntegrationNode } from "../contracts/integrationNodes.js";
import type { SpeculativeDependent } from "../contracts/changePercolation.js";
import type { RebaseResult } from "../contracts/workspaceVcsCore.js";
import type { AncestorStack } from "./ancestorStack.js";
import { buildBaseShiftLineage } from "./baseShiftLineage.js";
import type { BaseShiftEventEmitter, BaseShiftInvalidationCause, RebaseDecision } from "./baseShiftPorts.js";

export type BaseShiftEmitInput = {
  projectId: string;
  dependent: SpeculativeDependent;
  branch: string;
  newBaseSha: string;
  rebase: RebaseResult;
  ancestorStack?: AncestorStack;
  /** Only ever a REAL ancestor spec id — never the marker's base-branch key (see the builder). */
  lineageAncestorSpecId?: string;
  priorNodes?: ReadonlyArray<IntegrationNode>;
  invalidationCause: BaseShiftInvalidationCause;
};

export async function emitBaseShiftRebase(
  events: BaseShiftEventEmitter,
  input: BaseShiftEmitInput,
  rebaseConflicted: boolean,
  decision: RebaseDecision,
): Promise<void> {
  await events.emitRebase({
    projectId: input.projectId,
    specId: input.dependent.specId,
    runId: input.dependent.runId,
    branch: input.branch,
    newBaseSha: input.newBaseSha,
    headSha: input.rebase.headSha,
    rebaseConflicted,
    decision,
    lineage: buildBaseShiftLineage(input),
  });
}

/** Persist held lineage when re-gate is pending after a workspace restack. */
export async function emitHeldOnPendingRegate(
  events: BaseShiftEventEmitter,
  projectId: string,
  dependent: SpeculativeDependent,
  rebasedHeadSha: string,
  lineageContext: {
    branch: string;
    newBaseSha: string;
    ancestorStack?: AncestorStack;
    lineageAncestorSpecId?: string;
    priorNodes?: ReadonlyArray<IntegrationNode>;
    invalidationCause: BaseShiftInvalidationCause;
  },
): Promise<void> {
  await emitBaseShiftRebase(
    events,
    {
      projectId,
      dependent,
      branch: lineageContext.branch,
      newBaseSha: lineageContext.newBaseSha,
      rebase: { outcome: "clean", headSha: rebasedHeadSha },
      ...(lineageContext.ancestorStack !== undefined && { ancestorStack: lineageContext.ancestorStack }),
      ...(lineageContext.lineageAncestorSpecId !== undefined && {
        lineageAncestorSpecId: lineageContext.lineageAncestorSpecId,
      }),
      ...(lineageContext.priorNodes !== undefined && { priorNodes: lineageContext.priorNodes }),
      invalidationCause: lineageContext.invalidationCause,
    },
    false,
    "held",
  );
}
