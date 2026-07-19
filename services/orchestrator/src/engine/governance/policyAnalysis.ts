import type { z } from "zod";
import type { ContradictionWitness } from "./contradictionWitness.js";
import { PolicyAstSchema, type PolicyRule } from "./policyAst.js";
import { compilePolicy, type CompiledPolicyRule, type PolicySource } from "./policyCompiler.js";
import { simulateCompiledPolicy, type SimulationInput, type SimulationResult } from "./policySimulation.js";

export interface PrincipalReference {
  readonly kind: "agent_profile" | "user" | "team";
  readonly name: string;
  readonly source: PolicySource | undefined;
}

/** A concrete pair of hypotheticals proving two rules can never hold together. */
export interface ContradictionWitnessProof {
  readonly witness: ContradictionWitness;
  readonly summary: string;
  readonly inputA: SimulationInput;
  readonly inputB: SimulationInput;
}

export type PolicyValidationReport =
  | { readonly status: "malformed"; readonly issues: readonly z.core.$ZodIssue[] }
  | {
      readonly status: "contradictory";
      readonly contradictionWitnesses: readonly ContradictionWitness[];
      readonly witnessProofs: readonly ContradictionWitnessProof[];
      readonly unresolvedReferences: readonly PrincipalReference[];
    }
  | {
      readonly status: "valid";
      readonly policyHash: string;
      readonly ruleCount: number;
      readonly effectiveRules: readonly CompiledPolicyRule[];
      readonly references: readonly PrincipalReference[];
    };

export type SimulationOutcome =
  | { readonly status: "malformed"; readonly issues: readonly z.core.$ZodIssue[] }
  | { readonly status: "contradictory"; readonly contradictionWitnesses: readonly ContradictionWitness[] }
  | { readonly status: "evaluated"; readonly result: SimulationResult };

export type ExplanationOutcome =
  | { readonly explainable: false; readonly reason: "policy_malformed"; readonly issues: readonly z.core.$ZodIssue[] }
  | {
      readonly explainable: false;
      readonly reason: "policy_contradictory";
      readonly contradictionWitnesses: readonly ContradictionWitness[];
      readonly witnessProofs: readonly ContradictionWitnessProof[];
    }
  | {
      readonly explainable: true;
      readonly decision: "allowed" | "blocked";
      readonly headline: string;
      readonly rationale: readonly string[];
      readonly result: SimulationResult;
    };

const BASELINE: SimulationInput = {
  repositoryVisibility: "private",
  review: {
    mode: "human",
    approvals: 2,
    approvingPrincipals: [],
    freshness: "exact_head_sha",
    forgePublished: true,
    dismissedStaleOnBaseShift: true,
  },
  audit: { highestOpenSeverity: "none", residualDisposition: "human_required" },
  integration: { unmergedAncestorDepth: 0, baseShiftRegated: true },
  budget: { monthlySpendUsd: 0, perSpecSpendUsd: 0, unknownCostEncountered: false },
  notifications: { acknowledged: 16 },
  coverage: { evidenceAgeDays: 0 },
};

function withMode(
  mode: "auto" | "simulated" | "human",
  principals: SimulationInput["review"]["approvingPrincipals"] = [],
): SimulationInput {
  const auto = mode === "auto";
  return {
    ...BASELINE,
    review: {
      ...BASELINE.review,
      mode,
      approvals: auto ? 0 : Math.max(principals.length, 1),
      approvingPrincipals: auto ? [] : principals,
    },
  };
}

function witnessProof(witness: ContradictionWitness): ContradictionWitnessProof {
  switch (witness.kind) {
    case "conflicting_review_modes": {
      const [first, second] = witness.values;
      return {
        witness,
        summary: `layer "${witness.layer}" pins review mode to both ${first} and ${second}; a single change can perform only one review mode.`,
        inputA: withMode(first),
        inputB: withMode(second),
      };
    }
    case "automatic_review_requires_approval": {
      return {
        witness,
        summary: `automatic review records 0 approvals, yet the policy demands ${witness.minimumApprovals}; no scenario collects both 0 and ${witness.minimumApprovals} approvals.`,
        inputA: withMode("auto"),
        inputB: { ...BASELINE, review: { ...BASELINE.review, mode: "human", approvals: witness.minimumApprovals } },
      };
    }
    case "automatic_review_forbids_required_principal": {
      const principal = witness.principals[0] ?? { kind: "user" as const, name: "reviewer" };
      return {
        witness,
        summary: `automatic review records no approver principals, yet the policy requires ${principal.kind}:${principal.name} to approve; the required approval can never be produced under auto review.`,
        inputA: withMode("auto"),
        inputB: withMode("human", [principal]),
      };
    }
    default: {
      // Exhaustive over the closed witness union; a new kind must be handled here.
      throw new Error(`unhandled contradiction witness: ${(witness as { kind: string }).kind}`);
    }
  }
}

function principalReferences(
  rules: readonly CompiledPolicyRule[],
  sourceMap: Readonly<Record<string, PolicySource>>,
): PrincipalReference[] {
  return rules.flatMap((rule) => {
    if (rule.key !== "review.required_principal") return [];
    const value = rule.value as Extract<PolicyRule, { key: "review.required_principal" }>["value"];
    return [{ kind: value.kind, name: value.name, source: sourceMap[`${rule.key} ${JSON.stringify(rule.value)}`] }];
  });
}

/** Static well-formedness + contradiction + unresolved-reference analysis. Fail-closed. */
export function validatePolicy(sourceDocument: unknown): PolicyValidationReport {
  const parsed = PolicyAstSchema.safeParse(sourceDocument);
  if (!parsed.success) return { status: "malformed", issues: parsed.error.issues };
  const compiled = compilePolicy(parsed.data);
  if (compiled.status === "contradictory") {
    const proofs = compiled.contradictionWitnesses.map(witnessProof);
    const unresolvedReferences = compiled.contradictionWitnesses.flatMap((witness): PrincipalReference[] =>
      witness.kind === "automatic_review_forbids_required_principal"
        ? witness.principals.map((p) => ({ kind: p.kind, name: p.name, source: undefined }))
        : [],
    );
    return {
      status: "contradictory",
      contradictionWitnesses: compiled.contradictionWitnesses,
      witnessProofs: proofs,
      unresolvedReferences,
    };
  }
  return {
    status: "valid",
    policyHash: compiled.policyHash,
    ruleCount: compiled.ruleCount,
    effectiveRules: compiled.ast.rules,
    references: principalReferences(compiled.ast.rules, compiled.ast.sourceMap),
  };
}

/** Compile a supplied policy and evaluate it against a hypothetical input. Fail-closed. */
export function simulatePolicy(sourceDocument: unknown, input: SimulationInput): SimulationOutcome {
  const parsed = PolicyAstSchema.safeParse(sourceDocument);
  if (!parsed.success) return { status: "malformed", issues: parsed.error.issues };
  const compiled = compilePolicy(parsed.data);
  if (compiled.status === "contradictory") {
    return { status: "contradictory", contradictionWitnesses: compiled.contradictionWitnesses };
  }
  return { status: "evaluated", result: simulateCompiledPolicy(compiled.ast, compiled.policyHash, input) };
}

/** Human-readable rationale for a decision, or the witnesses proving it cannot be decided. */
export function explainPolicyDecision(sourceDocument: unknown, input: SimulationInput): ExplanationOutcome {
  const parsed = PolicyAstSchema.safeParse(sourceDocument);
  if (!parsed.success) return { explainable: false, reason: "policy_malformed", issues: parsed.error.issues };
  const compiled = compilePolicy(parsed.data);
  if (compiled.status === "contradictory") {
    return {
      explainable: false,
      reason: "policy_contradictory",
      contradictionWitnesses: compiled.contradictionWitnesses,
      witnessProofs: compiled.contradictionWitnesses.map(witnessProof),
    };
  }
  const result = simulateCompiledPolicy(compiled.ast, compiled.policyHash, input);
  const rationale = result.evaluations.map((evaluation) => {
    const mark =
      evaluation.status === "satisfied"
        ? evaluation.warning
          ? "WARN"
          : "PASS"
        : evaluation.status === "violated"
          ? "BLOCK"
          : "UNKNOWN";
    const provenance = evaluation.source === undefined ? "" : ` [from ${evaluation.source.layer} layer]`;
    return `${mark} ${evaluation.key}: ${evaluation.detail}${provenance}`;
  });
  const headline =
    result.decision === "allowed"
      ? `ALLOWED — all ${result.evaluations.length} effective rules are satisfied${result.warnings.length > 0 ? ` (${result.warnings.length} warning(s))` : ""}.`
      : `BLOCKED — ${result.violations.length} rule(s) violated and ${result.notEvaluable.length} not evaluable.`;
  return { explainable: true, decision: result.decision, headline, rationale, result };
}
