// gv-17 pure fail-closed lineage checks (always-on; no DB).
// Negative control: reordering or dropping a member vector fails exact-multiset
// equality and member_key agreement — the land path must never treat that as ready.

import { describe, expect, it } from "vitest";
import {
  memberKey,
  type IntegrationNode,
  type IntegrationNodeMember,
} from "../src/engine/contracts/integrationNodes.js";
import { buildBaseShiftLineage } from "../src/engine/dag/baseShiftLineage.js";
import {
  decodeMembersStrict,
  MemberLineageDivergenceError,
  sameOrderedMembers,
} from "../src/engine/dag/integrationNodeLineage.js";

const members = (shas: string[]): IntegrationNodeMember[] =>
  shas.map((headSha, index) => ({
    specId: `spec_${index}`,
    runId: `run_${index}`,
    branch: `feature/${index}`,
    headSha,
  }));

/** The dependent run's OWN branch — the identity `buildBaseShiftLineage` selects on. */
const DEP_BRANCH = "tanren/run_dep";

const node = (over: Partial<IntegrationNode> & { nodeId: string; ref: string }): IntegrationNode => ({
  baseBranch: "main",
  baseSha: "a".repeat(40),
  purpose: "eager_base",
  members: [{ specId: "spec_a", runId: "run_a", branch: "feat-a", headSha: "1".repeat(40) }],
  memberKey: "prior_key",
  gateConfigHash: "",
  policyVersion: "",
  affectedFingerprint: "",
  status: "building",
  ...over,
});

describe("gv-17 integration node member lineage (pure)", () => {
  it("sameOrderedMembers is exact ordered multiset equality", () => {
    const a = members(["a".repeat(40), "b".repeat(40), "c".repeat(40)]);
    expect(sameOrderedMembers(a, [...a])).toBe(true);
    // Reorder is a different vector (order is load-bearing).
    expect(sameOrderedMembers(a, [a[1]!, a[0]!, a[2]!])).toBe(false);
    // Delete one member.
    expect(sameOrderedMembers(a, a.slice(0, 2))).toBe(false);
    // Mutate one head.
    expect(sameOrderedMembers(a, [{ ...a[0]!, headSha: "d".repeat(40) }, a[1]!, a[2]!])).toBe(false);
  });

  it("decodeMembersStrict rejects malformed JSON (negative control)", () => {
    expect(() => decodeMembersStrict({ not: "array" }, "node_x")).toThrow(MemberLineageDivergenceError);
    expect(() => decodeMembersStrict([{ specId: "s" }], "node_x")).toThrow(MemberLineageDivergenceError);
    expect(() => decodeMembersStrict([{ specId: "s", runId: "r", branch: "b", headSha: "" }], "node_x")).toThrow(
      MemberLineageDivergenceError,
    );
  });

  it("six-member chain: reorder changes member_key (proof identity)", () => {
    const baseSha = "0".repeat(40);
    const ordered = members([
      "1".repeat(40),
      "2".repeat(40),
      "3".repeat(40),
      "4".repeat(40),
      "5".repeat(40),
      "6".repeat(40),
    ]);
    const key = memberKey(
      baseSha,
      ordered.map((m) => m.headSha),
    );
    const reordered = [ordered[5]!, ...ordered.slice(0, 5)];
    const reorderedKey = memberKey(
      baseSha,
      reordered.map((m) => m.headSha),
    );
    expect(reorderedKey).not.toBe(key);
    expect(sameOrderedMembers(ordered, reordered)).toBe(false);
  });

  it("production emit always attaches before/after vectors from prior nodes + stack", () => {
    const lineage = buildBaseShiftLineage({
      dependent: { runId: "run_dep", specId: "spec_dep", branch: DEP_BRANCH } as never,
      branch: DEP_BRANCH,
      newBaseSha: "b".repeat(40),
      lineageAncestorSpecId: "spec_a",
      invalidationCause: "ancestor_landed",
      ancestorStack: [{ specId: "spec_b", runId: "run_b", branch: "feat-b", headSha: "2".repeat(40) }],
      priorNodes: [node({ nodeId: "inode_1", ref: DEP_BRANCH })],
    });
    expect(lineage.nodeId).toBe("inode_1");
    expect(lineage.fromMembers).toHaveLength(1);
    expect(lineage.toMembers).toEqual([
      { specId: "spec_b", runId: "run_b", branch: "feat-b", headSha: "2".repeat(40) },
    ]);
    expect(lineage.ancestorSpecId).toBe("spec_a");
    expect(lineage.invalidationCause).toBe("ancestor_landed");
  });

  it("omits compatibility node ids so base_shift_operations FK cannot fail (negative control)", () => {
    const lineage = buildBaseShiftLineage({
      dependent: { runId: "run_dep", specId: "spec_dep", branch: DEP_BRANCH } as never,
      branch: DEP_BRANCH,
      newBaseSha: "b".repeat(40),
      invalidationCause: "base_moved",
      priorNodes: [node({ nodeId: "inode_compat_run_dep", ref: DEP_BRANCH, members: [] })],
    });
    expect(lineage.nodeId).toBeUndefined();
  });

  // THE NONDETERMINISM NEGATIVE CONTROL. `selectNodesForDependentRun` returns a UNION: the
  // run's OWN branch-ref node PLUS every merge-batch node that merely lists the run as a
  // member. Ordered by the random `inode_<uuid>`, index 0 was a coin flip — so a batch node
  // could win and the recorded nodeId / from-vector / from-base-sha would describe a
  // DIFFERENT integration. The builder must select by identity (`ref === branch`).
  it("picks the run's OWN branch-ref node out of the union, never the first by node_id", () => {
    const batch = node({
      nodeId: "inode_a_batch_sorts_first",
      ref: "tanren/integ/batch",
      baseSha: "9".repeat(40),
      memberKey: "batch_key",
      members: [{ specId: "spec_other", runId: "run_other", branch: "feat-other", headSha: "8".repeat(40) }],
    });
    const own = node({ nodeId: "inode_z_own_sorts_last", ref: DEP_BRANCH, memberKey: "own_key" });
    const lineage = buildBaseShiftLineage({
      dependent: { runId: "run_dep", specId: "spec_dep", branch: DEP_BRANCH } as never,
      branch: DEP_BRANCH,
      newBaseSha: "b".repeat(40),
      invalidationCause: "base_moved",
      // The batch node sorts FIRST by node_id — an index pick would take it.
      priorNodes: [batch, own],
    });
    expect(lineage.nodeId).toBe("inode_z_own_sorts_last");
    expect(lineage.fromMembers).toEqual([
      { specId: "spec_a", runId: "run_a", branch: "feat-a", headSha: "1".repeat(40) },
    ]);
    expect(lineage.fromBaseSha).toBe("a".repeat(40));
    expect(lineage.fromMemberKey).toBe("own_key");
  });

  it("records NO prior node when the run has no node of its own (never a neighbor's)", () => {
    const lineage = buildBaseShiftLineage({
      dependent: { runId: "run_dep", specId: "spec_dep", branch: DEP_BRANCH } as never,
      branch: DEP_BRANCH,
      newBaseSha: "b".repeat(40),
      invalidationCause: "base_moved",
      priorNodes: [node({ nodeId: "inode_batch_only", ref: "tanren/integ/batch" })],
    });
    expect(lineage.nodeId).toBeUndefined();
    expect(lineage.fromMembers).toEqual([]);
    expect(lineage.fromBaseSha).toBe("b".repeat(40));
  });
});
