// Unit tests for the `integration_nodes` pure functions (tanren-owns-the-engine.md
// §3) — `memberKey` (identity of the integrated content) + `proofReuseKey` (the
// proof-reuse cache key). These pin the determinism + order-sensitivity + total
// drift-sensitivity the never-discard rebase + proof-reuse cache depend on.

import { describe, expect, it } from "vitest";
import { memberKey, proofReuseKey, type ProofReuseKeyInput } from "../src/engine/contracts/integrationNodes.js";

describe("memberKey", () => {
  it("is deterministic for the same base + ordered member shas", () => {
    expect(memberKey("base1", ["a", "b", "c"])).toBe(memberKey("base1", ["a", "b", "c"]));
  });

  it("is ORDER-SENSITIVE (a reordering is a different node)", () => {
    expect(memberKey("base1", ["a", "b"])).not.toBe(memberKey("base1", ["b", "a"]));
  });

  it("changes when the base sha changes", () => {
    expect(memberKey("base1", ["a"])).not.toBe(memberKey("base2", ["a"]));
  });

  it("distinguishes member-boundary placement (no separator collision)", () => {
    // Without an unambiguous separator, ["ab","c"] and ["a","bc"] could collide.
    expect(memberKey("b", ["ab", "c"])).not.toBe(memberKey("b", ["a", "bc"]));
  });

  it("an empty member list keys off the base alone (the bare-main node)", () => {
    expect(memberKey("base1", [])).toBe(memberKey("base1", []));
    expect(memberKey("base1", [])).not.toBe(memberKey("base1", ["a"]));
  });
});

describe("proofReuseKey", () => {
  const base: ProofReuseKeyInput = {
    memberKey: "mk",
    gateConfigHash: "a".repeat(64),
    policyVersion: "b".repeat(64),
    runnerImage: "ri",
    appEnvHash: "ae",
    quarantineVersion: "qv",
  };

  it("is deterministic for identical inputs", () => {
    expect(proofReuseKey(base)).toBe(proofReuseKey({ ...base }));
  });

  it("reuses (matches) ONLY when EVERY component matches — any drift forces a recompute", () => {
    const keys = (
      ["memberKey", "gateConfigHash", "policyVersion", "runnerImage", "appEnvHash", "quarantineVersion"] as const
    ).map((field) => proofReuseKey({ ...base, [field]: "DRIFTED" }));
    const baseline = proofReuseKey(base);
    // Every single-field drift yields a DIFFERENT key (no stale reuse).
    for (const k of keys) {
      expect(k).not.toBe(baseline);
    }
    // The drifted keys are all distinct from each other too (no field aliasing).
    expect(new Set(keys).size).toBe(keys.length);
  });
});
