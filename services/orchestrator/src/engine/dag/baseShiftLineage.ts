// gv-17: build the before/after member-vector lineage payload attached to every
// settled base-shift emit (production restacks must persist base_shift_operations).

import { memberKey, type IntegrationNode, type IntegrationNodeMember } from "../contracts/integrationNodes.js";
import type { AncestorStack } from "./ancestorStack.js";
import type { SpeculativeDependent } from "../contracts/changePercolation.js";

export interface BaseShiftLineagePayload {
  nodeId?: string;
  ancestorSpecId?: string;
  fromBaseSha: string;
  fromMemberKey: string;
  toMemberKey: string;
  fromMembers: IntegrationNodeMember[];
  toMembers: IntegrationNodeMember[];
  invalidationCause: "ancestor_landed";
}

/** Pure: map prior nodes + re-resolved stack into a durable base-shift lineage snapshot. */
export function buildBaseShiftLineage(input: {
  dependent: SpeculativeDependent;
  newBaseSha: string;
  ancestorStack?: AncestorStack;
  ancestorSpecId?: string;
  priorNodes?: ReadonlyArray<IntegrationNode>;
}): BaseShiftLineagePayload {
  const prior = input.priorNodes?.[0];
  const fromMembers = prior === undefined ? [] : [...prior.members];
  const fromBaseSha = prior?.baseSha ?? input.newBaseSha;
  const fromMemberKey =
    prior?.memberKey ??
    memberKey(
      fromBaseSha,
      fromMembers.map((m) => m.headSha),
    );
  const toMembers = (input.ancestorStack ?? []).map((m) => ({
    specId: m.specId,
    runId: m.runId === "" ? input.dependent.runId : m.runId,
    branch: m.branch === "" ? m.specId : m.branch,
    headSha: m.headSha,
  }));
  const toMemberKey = memberKey(
    input.newBaseSha,
    toMembers.map((m) => m.headSha),
  );
  return {
    ...(prior !== undefined && { nodeId: prior.nodeId }),
    ...(input.ancestorSpecId !== undefined && { ancestorSpecId: input.ancestorSpecId }),
    fromBaseSha,
    fromMemberKey,
    toMemberKey,
    fromMembers,
    toMembers,
    invalidationCause: "ancestor_landed",
  };
}
