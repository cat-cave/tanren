// gv-17: emit integration.rebase + durable before/after member lineage.

import type { IntegrationNode } from "../contracts/integrationNodes.js";
import type { SpeculativeDependent } from "../contracts/changePercolation.js";
import type { RebaseResult } from "../contracts/workspaceVcsCore.js";
import type { AncestorStack } from "./ancestorStack.js";
import { buildBaseShiftLineage } from "./baseShiftLineage.js";
import type { BaseShiftEventEmitter, RebaseDecision } from "./baseShiftPorts.js";

export async function emitBaseShiftRebase(
  events: BaseShiftEventEmitter,
  input: {
    projectId: string;
    dependent: SpeculativeDependent;
    branch: string;
    newBaseSha: string;
    rebase: RebaseResult;
    ancestorStack?: AncestorStack;
    ancestorSpecId?: string;
    priorNodes?: ReadonlyArray<IntegrationNode>;
  },
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
