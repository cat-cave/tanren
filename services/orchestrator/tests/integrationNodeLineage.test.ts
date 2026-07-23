// gv-17 pure fail-closed lineage checks (always-on; no DB).
// Negative control: reordering or dropping a member vector fails exact-multiset
// equality and member_key agreement — the land path must never treat that as ready.

import { describe, expect, it } from "vitest";
import { memberKey, type IntegrationNodeMember } from "../src/engine/contracts/integrationNodes.js";
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
});
