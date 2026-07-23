// §8 compatibility projection: speculative run → IntegrationNode (pure, no DB).

import { type IntegrationNode, type IntegrationNodeMember, memberKey } from "../contracts/integrationNodes.js";
import type { AncestorStack } from "./ancestorStack.js";

/**
 * PURE: project ONE speculative run row into the FROZEN `IntegrationNode` shape (the §8
 * compatibility read-model, factored out so it is unit-testable WITHOUT a DB). The members
 * are the ordered `ancestor_stack` (already DAG-ordered → a stable, deterministic `memberKey`).
 * jj-local: there is no synthesized base ref; the base identity is the immediate-ancestor
 * PR-head branch (the stacked base), or the dependent's own run branch as the fallback.
 */
export function speculativeRunToNode(input: {
  runId: string;
  branch: string;
  ancestorStack: AncestorStack;
}): IntegrationNode {
  const members: IntegrationNodeMember[] = input.ancestorStack.map((m) => ({
    specId: m.specId,
    // A stack member's run id/branch may be empty (a placeholder) before the bootstrap
    // write-back; fall back to the dependent's own labels so the projection is total.
    runId: m.runId === "" ? input.runId : m.runId,
    branch: m.branch === "" ? m.specId : m.branch,
    headSha: m.headSha,
  }));
  const immediateAncestorBranch = input.ancestorStack.at(-1)?.branch;
  const base =
    immediateAncestorBranch !== undefined && immediateAncestorBranch !== "" ? immediateAncestorBranch : input.branch;
  return {
    nodeId: `inode_compat_${input.runId}`,
    baseBranch: base,
    baseSha: base,
    ref: base,
    purpose: "eager_base",
    members,
    memberKey: memberKey(
      base,
      members.map((m) => m.headSha),
    ),
    gateConfigHash: "",
    policyVersion: "",
    affectedFingerprint: "",
    status: "building",
  };
}
