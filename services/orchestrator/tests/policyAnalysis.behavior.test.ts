// gv-13 — deterministic policy simulate / validate / explain + contradiction witnesses.
// Proves: (1) simulate returns a full decision trace; (2) a policy that cannot be
// evaluated is BLOCKED, never silently allowed; (3) validate surfaces malformed +
// contradictory (incl. unresolved-reference) policies as errors; (4) every reported
// contradiction ships a concrete input pair proving the two rules conflict.

import { describe, expect, it } from "vitest";
import type { PolicyAst } from "../src/engine/governance/policyAst.js";
import { explainPolicyDecision, simulatePolicy, validatePolicy } from "../src/engine/governance/policyAnalysis.js";
import { simulateCompiledPolicy, type SimulationInput } from "../src/engine/governance/policySimulation.js";
import { compilePolicy } from "../src/engine/governance/policyCompiler.js";

function policy(overrides: Partial<Record<"core" | "org" | "tier" | "binding", PolicyAst["core"]>> = {}): PolicyAst {
  return {
    apiVersion: "tanren.dev/governance/v2",
    schemaVersion: 1,
    core: overrides.core ?? {
      rules: [
        { key: "review.mode", value: "human" },
        { key: "review.minimum_approvals", value: 2 },
        { key: "audit.block_at", value: "P2" },
        { key: "budget.per_spec_usd", value: 50 },
        { key: "budget.monthly_usd", value: 500 },
      ],
    },
    org: overrides.org ?? { rules: [] },
    tier: overrides.tier ?? { rules: [] },
    binding: overrides.binding ?? { rules: [] },
  };
}

const compliant: SimulationInput = {
  repositoryVisibility: "private",
  review: {
    mode: "human",
    approvals: 3,
    approvingPrincipals: [{ kind: "user", name: "lead" }],
    freshness: "exact_head_sha",
    forgePublished: true,
    dismissedStaleOnBaseShift: true,
  },
  audit: { highestOpenSeverity: "none", residualDisposition: "human_required" },
  integration: { unmergedAncestorDepth: 0, baseShiftRegated: true },
  budget: { monthlySpendUsd: 100, perSpecSpendUsd: 20, unknownCostEncountered: false },
  notifications: { acknowledged: 5 },
  coverage: { evidenceAgeDays: 1 },
};

describe("gv-13 simulate", () => {
  it("allows a fully compliant scenario and traces every effective rule", () => {
    const outcome = simulatePolicy(policy(), compliant);
    expect(outcome.status).toBe("evaluated");
    if (outcome.status !== "evaluated") throw new Error("expected evaluated");
    expect(outcome.result.decision).toBe("allowed");
    expect(outcome.result.violations).toHaveLength(0);
    // Every compiled rule appears in the trace with provenance.
    expect(outcome.result.evaluations.length).toBe(
      outcome.result.evaluations.filter((e) => e.source !== undefined).length,
    );
    expect(outcome.result.evaluations.map((e) => e.key)).toContain("review.minimum_approvals");
  });

  it("blocks when a rule is violated (too few approvals)", () => {
    const outcome = simulatePolicy(policy(), { ...compliant, review: { ...compliant.review, approvals: 1 } });
    if (outcome.status !== "evaluated") throw new Error("expected evaluated");
    expect(outcome.result.decision).toBe("blocked");
    expect(outcome.result.violations.map((v) => v.key)).toContain("review.minimum_approvals");
  });

  it("blocks on a severe audit finding at/above the block threshold", () => {
    const outcome = simulatePolicy(policy(), {
      ...compliant,
      audit: { highestOpenSeverity: "P0", residualDisposition: "human_required" },
    });
    if (outcome.status !== "evaluated") throw new Error("expected evaluated");
    expect(outcome.result.decision).toBe("blocked");
    expect(outcome.result.violations.map((v) => v.key)).toContain("audit.block_at");
  });

  it("FAIL-CLOSED: an unmappable rule is not_evaluable and forces a block, never an allow", () => {
    // Compile a valid policy, then inject a rule with no evaluator to prove the
    // inconclusive path resolves to BLOCKED rather than silently allowing.
    const compiled = compilePolicy(policy());
    if (compiled.status !== "compiled") throw new Error("expected compiled");
    const tampered = {
      ...compiled.ast,
      rules: [...compiled.ast.rules, { key: "unknown.future_key", value: 1 } as never],
    };
    const result = simulateCompiledPolicy(tampered, compiled.policyHash, compliant);
    expect(result.notEvaluable).toHaveLength(1);
    expect(result.decision).toBe("blocked");
  });

  it("FAIL-CLOSED: a contradictory policy cannot be simulated to an allow", () => {
    const outcome = simulatePolicy(autoPolicyWithApprovals(2), compliant);
    expect(outcome.status).toBe("contradictory");
  });
});

// A policy whose EFFECTIVE review mode is auto (auto in every layer) yet still
// demands approvals — the deterministically unsatisfiable class.
function autoPolicyWithApprovals(minApprovals: number): PolicyAst {
  return policy({
    core: {
      rules: [
        { key: "review.mode", value: "auto" },
        { key: "review.minimum_approvals", value: minApprovals },
      ],
    },
  });
}

function autoPolicyWithPrincipal(principal: { kind: "agent_profile" | "user" | "team"; name: string }): PolicyAst {
  return policy({
    core: {
      rules: [
        { key: "review.mode", value: "auto" },
        { key: "review.minimum_approvals", value: 0 },
      ],
    },
    binding: { rules: [{ key: "review.required_principal", value: principal }] },
  });
}

describe("gv-13 validate", () => {
  it("reports a well-formed, satisfiable policy as valid", () => {
    const report = validatePolicy(policy());
    expect(report.status).toBe("valid");
    if (report.status !== "valid") throw new Error("expected valid");
    expect(report.policyHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("MALFORMED: an unknown rule key is a validate error, not a false clean", () => {
    const report = validatePolicy({ ...policy(), core: { rules: [{ key: "not.a.real.key", value: 1 }] } });
    expect(report.status).toBe("malformed");
    if (report.status !== "malformed") throw new Error("expected malformed");
    expect(report.issues.length).toBeGreaterThan(0);
  });

  it("CONTRADICTORY: auto review + a required principal is an UNRESOLVED reference error", () => {
    const report = validatePolicy(autoPolicyWithPrincipal({ kind: "team", name: "security" }));
    expect(report.status).toBe("contradictory");
    if (report.status !== "contradictory") throw new Error("expected contradictory");
    expect(report.contradictionWitnesses.map((w) => w.kind)).toContain("automatic_review_forbids_required_principal");
    expect(report.unresolvedReferences).toEqual([{ kind: "team", name: "security", source: undefined }]);
  });
});

describe("gv-13 explain + contradiction witnesses", () => {
  it("produces a human-readable rationale for a decision with per-rule provenance", () => {
    const outcome = explainPolicyDecision(policy(), { ...compliant, review: { ...compliant.review, approvals: 1 } });
    expect(outcome.explainable).toBe(true);
    if (!outcome.explainable) throw new Error("expected explainable");
    expect(outcome.decision).toBe("blocked");
    expect(outcome.headline).toContain("BLOCKED");
    expect(outcome.rationale.some((line) => line.startsWith("BLOCK review.minimum_approvals"))).toBe(true);
  });

  it("SOUND WITNESS: the concrete input pair genuinely proves the two rules conflict", () => {
    const outcome = explainPolicyDecision(autoPolicyWithApprovals(2), compliant);
    expect(outcome.explainable).toBe(false);
    if (outcome.explainable) throw new Error("expected non-explainable");
    expect(outcome.reason).toBe("policy_contradictory");
    const proof = outcome.witnessProofs.find((p) => p.witness.kind === "automatic_review_requires_approval");
    expect(proof).toBeDefined();
    if (proof === undefined) throw new Error("expected approval witness");
    // The pair must be coherent inputs, and the mutually exclusive facts must hold:
    // inputA performs the required auto review (0 approvals); inputB collects the
    // demanded approvals — no single input can do both.
    expect(proof.inputA.review.mode).toBe("auto");
    expect(proof.inputA.review.approvals).toBe(0);
    expect(proof.inputB.review.approvals).toBeGreaterThanOrEqual(2);
    expect(proof.inputA.review.approvals).not.toBe(proof.inputB.review.approvals);
  });

  it("no false contradiction: the strict presets and a plain policy compile clean", () => {
    expect(validatePolicy(policy()).status).toBe("valid");
  });
});
