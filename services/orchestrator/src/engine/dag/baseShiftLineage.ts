// gv-17: build the before/after member-vector lineage payload attached to every
// settled base-shift emit (production restacks must persist base_shift_operations).

import { memberKey, type IntegrationNode, type IntegrationNodeMember } from "../contracts/integrationNodes.js";
import type { AncestorStack } from "./ancestorStack.js";
import type { SpeculativeDependent } from "../contracts/changePercolation.js";
import type { BaseShiftInvalidationCause } from "./baseShiftPorts.js";

export interface BaseShiftLineagePayload {
  nodeId?: string;
  ancestorSpecId?: string;
  fromBaseSha: string;
  fromMemberKey: string;
  toMemberKey: string;
  fromMembers: IntegrationNodeMember[];
  toMembers: IntegrationNodeMember[];
  invalidationCause: BaseShiftInvalidationCause;
}

/** Pure: map prior nodes + re-resolved stack into a durable base-shift lineage snapshot. */
export function buildBaseShiftLineage(input: {
  dependent: SpeculativeDependent;
  /** The dependent's OWN branch — the identity that picks its node out of `priorNodes`. */
  branch: string;
  newBaseSha: string;
  ancestorStack?: AncestorStack;
  /**
   * The ancestor SPEC whose landing/advance drove this restack, when one exists. DISTINCT
   * from the coordinator's marker `ancestorSpecId`: on the merge-`behind` path that marker
   * deliberately carries the base BRANCH name (it keys the marker on the shift's `from`),
   * and `base_shift_operations.ancestor_spec_id` has no FK to catch it — a branch name would
   * insert cleanly and the history API would serve `"main"` as a spec id. So the durable
   * record takes THIS field, which is populated only from a real ancestor spec.
   */
  lineageAncestorSpecId?: string;
  priorNodes?: ReadonlyArray<IntegrationNode>;
  /** REQUIRED: the driver's real invalidation cause (never guessed here — the builder
   *  cannot tell an ancestor landing from a base advance from a member head move). */
  invalidationCause: BaseShiftInvalidationCause;
}): BaseShiftLineagePayload {
  // `priorNodes` is a UNION (`selectNodesForDependentRun`): the run's OWN branch-ref node
  // PLUS every merge-batch / eager-beam node that merely LISTS this run as a member. Those
  // describe DIFFERENT integrations, so taking index 0 recorded whichever `inode_<uuid>`
  // happened to sort first — a coin flip that could attribute this run's restack to a batch
  // node's id, members and base sha. Pick by IDENTITY (the run's own branch ref); when the
  // run has no node of its own, record NO prior node rather than a neighbor's lineage.
  const prior = input.priorNodes?.find((node) => node.ref === input.branch);
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
  // Compatibility read-model ids (`inode_compat_*`) are not rows in integration_nodes;
  // recording them would trip base_shift_operations_node_fk and fail the restack emit.
  const persistedNodeId = prior !== undefined && !prior.nodeId.startsWith("inode_compat_") ? prior.nodeId : undefined;
  return {
    ...(persistedNodeId !== undefined && { nodeId: persistedNodeId }),
    ...(input.lineageAncestorSpecId !== undefined && { ancestorSpecId: input.lineageAncestorSpecId }),
    fromBaseSha,
    fromMemberKey,
    toMemberKey,
    fromMembers,
    toMembers,
    invalidationCause: input.invalidationCause,
  };
}
