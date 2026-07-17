import { describe, expect, it } from "vitest";
import { compilePolicy } from "./policyCompiler.js";
import type { PolicyAst } from "./policyAst.js";

function policy(binding?: PolicyAst["binding"]): PolicyAst {
  return {
    apiVersion: "tanren.dev/governance/v2",
    schemaVersion: 1,
    core: {
      rules: [
        { key: "repository.visibility", value: "public" },
        { key: "review.mode", value: "simulated" },
        { key: "review.minimum_approvals", value: 1 },
      ],
    },
    org: {
      rules: [
        { key: "repository.visibility", value: "private" },
        { key: "review.freshness", value: "exact_head_sha" },
        { key: "review.require_forge_publication", value: true },
      ],
    },
    tier: {
      rules: [
        { key: "review.minimum_approvals", value: 2 },
        { key: "budget.unknown_cost_action", value: "pause" },
      ],
    },
    binding: binding ?? { rules: [] },
  };
}

describe("deterministic governance compiler", () => {
  it("reproduces the same canonical compiled AST and hash", () => {
    const first = compilePolicy(policy());
    const second = compilePolicy(policy());
    expect(first.status).toBe("compiled");
    expect(second.status).toBe("compiled");
    if (first.status !== "compiled" || second.status !== "compiled") throw new Error("expected compiled policy");
    expect(second.ast).toEqual(first.ast);
    expect(second.policyHash).toBe(first.policyHash);
    expect(first.policyHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("aggregates the most restrictive value in core → org → tier → binding order", () => {
    const result = compilePolicy(policy({ rules: [{ key: "review.minimum_approvals", value: 3 }] }));
    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") throw new Error("expected compiled policy");
    expect(result.ast.rules).toEqual([
      { key: "budget.unknown_cost_action", value: "pause" },
      { key: "repository.visibility", value: "private" },
      { key: "review.freshness", value: "exact_head_sha" },
      { key: "review.minimum_approvals", value: 3 },
      { key: "review.mode", value: "simulated" },
      { key: "review.require_forge_publication", value: true },
    ]);
  });

  it("orders the compiled rules array by codepoint, not host locale", () => {
    // "Bob" (0x42) precedes "alice" (0x61) by codepoint; a locale collator (en) would
    // reverse them. Pinning the exact order proves the rule sort is collator-independent,
    // so policy_hash is byte-identical across hosts regardless of the process locale.
    const withPrincipals: PolicyAst = {
      ...policy(),
      binding: {
        rules: [
          { key: "review.required_principal", value: { kind: "team", name: "alice" } },
          { key: "review.required_principal", value: { kind: "team", name: "Bob" } },
        ],
      },
    };
    const result = compilePolicy(withPrincipals);
    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") throw new Error("expected compiled policy");
    const principals = result.ast.rules
      .filter((rule) => rule.key === "review.required_principal")
      .map((rule) => (typeof rule.value === "object" && rule.value !== null ? rule.value.name : rule.value));
    expect(principals).toEqual(["Bob", "alice"]);
  });

  it("returns contradiction witnesses and no hash for an impossible AST", () => {
    const result = compilePolicy({
      ...policy(),
      binding: {
        rules: [
          { key: "review.mode", value: "auto" },
          { key: "review.mode", value: "human" },
        ],
      },
    });
    expect(result.status).toBe("contradictory");
    expect(result).not.toHaveProperty("policyHash");
    if (result.status !== "contradictory") throw new Error("expected contradiction");
    expect(result.contradictionWitnesses).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "conflicting_review_modes", layer: "binding" })]),
    );
  });

  it("changes the content hash when a typed rule changes", () => {
    const first = compilePolicy(policy());
    const second = compilePolicy({
      ...policy(),
      tier: { rules: [{ key: "budget.unknown_cost_action", value: "warn" }] },
    });
    expect(first.status).toBe("compiled");
    expect(second.status).toBe("compiled");
    if (first.status !== "compiled" || second.status !== "compiled") throw new Error("expected compiled policy");
    expect(second.policyHash).not.toBe(first.policyHash);
  });
});
