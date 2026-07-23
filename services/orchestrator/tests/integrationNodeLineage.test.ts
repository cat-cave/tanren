// gv-17 pure fail-closed lineage checks (always-on; no DB).
// Negative control: reordering or dropping a member vector fails exact-multiset
// equality and member_key agreement — the land path must never treat that as ready.

import { describe, expect, it } from "vitest";
import { memberKey, type IntegrationNodeMember } from "../src/engine/contracts/integrationNodes.js";
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
      dependent: { runId: "run_dep", specId: "spec_dep", branch: "feat-dep" } as never,
      newBaseSha: "b".repeat(40),
      ancestorSpecId: "spec_a",
      ancestorStack: [{ specId: "spec_b", runId: "run_b", branch: "feat-b", headSha: "2".repeat(40) }],
      priorNodes: [
        {
          nodeId: "inode_1",
          baseBranch: "main",
          baseSha: "a".repeat(40),
          ref: "local",
          purpose: "eager_base",
          members: [{ specId: "spec_a", runId: "run_a", branch: "feat-a", headSha: "1".repeat(40) }],
          memberKey: "prior_key",
          gateConfigHash: "",
          policyVersion: "",
          affectedFingerprint: "",
          status: "building",
        },
      ],
    });
    expect(lineage.nodeId).toBe("inode_1");
    expect(lineage.fromMembers).toHaveLength(1);
    expect(lineage.toMembers).toEqual([
      { specId: "spec_b", runId: "run_b", branch: "feat-b", headSha: "2".repeat(40) },
    ]);
    expect(lineage.invalidationCause).toBe("ancestor_landed");
  });
});
