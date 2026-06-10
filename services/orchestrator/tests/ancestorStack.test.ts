// WS-A PR-1 (walker-jj-local-integration-design.md §2.3, §7): the typed
// `AncestorStack` + the pure DUAL-READ resolver. Proves both read branches:
//   (1) the new `ancestor_stack` column is the source of truth when present;
//   (2) else the stack is reconstructed from the legacy `integrated_ancestor_shas`
//       SHA map (best-effort — runId/branch empty, since the legacy column carries
//       only the per-ancestor head sha);
//   (3) a non-speculative run (no column, no legacy map) resolves to an EMPTY stack.
// Pure functions — no DB, no seams.

import { describe, expect, it } from "vitest";
import {
  ancestorStackFromShaMap,
  ancestorStackSchema,
  resolveAncestorStack,
  type AncestorStack,
} from "../src/engine/dag/ancestorStack.js";

describe("AncestorStack — typed shape + zod schema", () => {
  it("accepts a well-formed ordered stack", () => {
    const stack: AncestorStack = [
      { specId: "spec_a", runId: "run_a", branch: "tanren/spec_a", headSha: "sha_a" },
      { specId: "spec_b", runId: "run_b", branch: "tanren/spec_b", headSha: "sha_b" },
    ];
    expect(ancestorStackSchema.parse(stack)).toEqual(stack);
  });

  it("rejects a malformed member (missing headSha)", () => {
    const bad = [{ specId: "spec_a", runId: "run_a", branch: "tanren/spec_a" }];
    expect(ancestorStackSchema.safeParse(bad).success).toBe(false);
  });
});

describe("ancestorStackFromShaMap — legacy SHA map → ordered stack", () => {
  it("reconstructs one member per ancestor (runId/branch empty, headSha from the map)", () => {
    expect(ancestorStackFromShaMap({ spec_a: "sha_a", spec_b: "sha_b" })).toEqual([
      { specId: "spec_a", runId: "", branch: "", headSha: "sha_a" },
      { specId: "spec_b", runId: "", branch: "", headSha: "sha_b" },
    ]);
  });

  it("an empty map yields an empty stack", () => {
    expect(ancestorStackFromShaMap({})).toEqual([]);
  });
});

describe("resolveAncestorStack — DUAL-READ", () => {
  it("(1) reads the new ancestor_stack column when present (the source of truth)", () => {
    const stack: AncestorStack = [{ specId: "spec_a", runId: "run_a", branch: "tanren/spec_a", headSha: "sha_a" }];
    // The legacy columns carry DIFFERENT data — the column must win.
    const resolved = resolveAncestorStack({
      ancestorStack: stack,
      speculativeBase: "tanren/integ/spec_x",
      integratedAncestorShas: { spec_z: "sha_z" },
    });
    expect(resolved).toEqual(stack);
  });

  it("(2) reconstructs from the legacy integrated_ancestor_shas when the column is absent", () => {
    const resolved = resolveAncestorStack({
      ancestorStack: null,
      speculativeBase: "tanren/integ/spec_b",
      integratedAncestorShas: { spec_a: "sha_a" },
    });
    expect(resolved).toEqual([{ specId: "spec_a", runId: "", branch: "", headSha: "sha_a" }]);
  });

  it("(2b) reconstructs from the legacy map when the column is an empty array (treated as absent)", () => {
    const resolved = resolveAncestorStack({
      ancestorStack: [],
      integratedAncestorShas: { spec_a: "sha_a" },
    });
    expect(resolved).toEqual([{ specId: "spec_a", runId: "", branch: "", headSha: "sha_a" }]);
  });

  it("(3) a non-speculative run (no column, no legacy map) resolves to an EMPTY stack", () => {
    expect(resolveAncestorStack({ ancestorStack: null, speculativeBase: null, integratedAncestorShas: null })).toEqual(
      [],
    );
    expect(resolveAncestorStack({})).toEqual([]);
  });

  it("ignores a malformed ancestor_stack column and falls back to the legacy map", () => {
    const resolved = resolveAncestorStack({
      ancestorStack: [{ specId: "spec_a" }],
      integratedAncestorShas: { spec_a: "sha_a" },
    });
    expect(resolved).toEqual([{ specId: "spec_a", runId: "", branch: "", headSha: "sha_a" }]);
  });
});
