import { z } from "zod";
import type { PolicyRule } from "./policyAst.js";
import type { CompiledPolicyAst, CompiledPolicyRule, PolicySource } from "./policyCompiler.js";

/**
 * A hypothetical merge/change scenario, expressed as the concrete facts the
 * closed governance rule vocabulary can observe. Every field a rule may read is
 * required, so evaluation is total: a policy is never silently allowed because an
 * input field was absent.
 */
const PrincipalSchema = z
  .object({
    kind: z.enum(["agent_profile", "user", "team"]),
    name: z.string().min(1).max(256),
  })
  .strict();

export const SimulationInputSchema = z
  .object({
    repositoryVisibility: z.enum(["public", "private"]),
    review: z
      .object({
        mode: z.enum(["auto", "simulated", "human"]),
        approvals: z.number().int().nonnegative(),
        approvingPrincipals: z.array(PrincipalSchema),
        freshness: z.enum(["none", "branch_head", "exact_head_sha"]),
        forgePublished: z.boolean(),
        dismissedStaleOnBaseShift: z.boolean(),
      })
      .strict(),
    audit: z
      .object({
        highestOpenSeverity: z.enum(["none", "P0", "P1", "P2", "P3"]),
        residualDisposition: z.enum(["risk_accepted", "new_spec", "human_required"]),
      })
      .strict(),
    integration: z
      .object({
        unmergedAncestorDepth: z.number().int().nonnegative(),
        baseShiftRegated: z.boolean(),
      })
      .strict(),
    budget: z
      .object({
        monthlySpendUsd: z.number().finite().nonnegative(),
        perSpecSpendUsd: z.number().finite().nonnegative(),
        unknownCostEncountered: z.boolean(),
      })
      .strict(),
    notifications: z
      .object({
        acknowledged: z.number().int().nonnegative(),
      })
      .strict(),
    coverage: z
      .object({
        evidenceAgeDays: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  // Automatic review collects no approvals and records no approver principals;
  // a hypothetical that claims otherwise is incoherent and is rejected outright
  // rather than being evaluated to a misleading verdict.
  .superRefine((input, ctx) => {
    if (input.review.mode === "auto" && input.review.approvals > 0) {
      ctx.addIssue({ code: "custom", path: ["review", "approvals"], message: "auto review cannot collect approvals" });
    }
    if (input.review.mode === "auto" && input.review.approvingPrincipals.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["review", "approvingPrincipals"],
        message: "auto review records no approver principals",
      });
    }
  });

export type SimulationInput = z.infer<typeof SimulationInputSchema>;

export type RuleStatus = "satisfied" | "violated" | "not_evaluable";

export interface RuleEvaluation {
  readonly key: CompiledPolicyRule["key"];
  readonly requiredValue: CompiledPolicyRule["value"];
  readonly observed: unknown;
  readonly status: RuleStatus;
  readonly detail: string;
  readonly warning: boolean;
  readonly source: PolicySource | undefined;
}

export interface SimulationResult {
  readonly decision: "allowed" | "blocked";
  readonly policyHash: string;
  readonly evaluations: readonly RuleEvaluation[];
  readonly violations: readonly RuleEvaluation[];
  readonly warnings: readonly RuleEvaluation[];
  readonly notEvaluable: readonly RuleEvaluation[];
}

const MODE_RANK: Record<"auto" | "simulated" | "human", number> = { auto: 0, simulated: 1, human: 2 };
const FRESHNESS_RANK: Record<"none" | "branch_head" | "exact_head_sha", number> = {
  none: 0,
  branch_head: 1,
  exact_head_sha: 2,
};
const DISPOSITION_RANK: Record<"risk_accepted" | "new_spec" | "human_required", number> = {
  risk_accepted: 0,
  new_spec: 1,
  human_required: 2,
};
// Lower ordinal is a MORE severe finding (P0 is worst); a finding blocks when it
// is at least as severe as the configured `audit.block_at` threshold.
const SEVERITY_ORDINAL: Record<"P0" | "P1" | "P2" | "P3", number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

function ok(observed: unknown, detail: string): { status: RuleStatus; observed: unknown; detail: string } {
  return { status: "satisfied", observed, detail };
}
function bad(observed: unknown, detail: string): { status: RuleStatus; observed: unknown; detail: string } {
  return { status: "violated", observed, detail };
}

function evaluateRule(
  rule: PolicyRule,
  input: SimulationInput,
): { status: RuleStatus; observed: unknown; detail: string; warning?: boolean } {
  switch (rule.key) {
    case "repository.visibility": {
      const observed = input.repositoryVisibility;
      return observed === rule.value
        ? ok(observed, `repository visibility is ${observed}`)
        : bad(observed, `policy requires ${rule.value} repository, scenario is ${observed}`);
    }
    case "review.mode": {
      const observed = input.review.mode;
      return MODE_RANK[observed] >= MODE_RANK[rule.value]
        ? ok(observed, `review mode ${observed} meets required ${rule.value}`)
        : bad(observed, `policy requires at least ${rule.value} review, scenario performed ${observed}`);
    }
    case "review.minimum_approvals": {
      const observed = input.review.approvals;
      return observed >= rule.value
        ? ok(observed, `${observed} approvals meet the minimum of ${rule.value}`)
        : bad(observed, `policy requires ${rule.value} approvals, scenario has ${observed}`);
    }
    case "review.freshness": {
      const observed = input.review.freshness;
      return FRESHNESS_RANK[observed] >= FRESHNESS_RANK[rule.value]
        ? ok(observed, `approval freshness ${observed} meets required ${rule.value}`)
        : bad(observed, `policy requires ${rule.value} freshness, scenario is ${observed}`);
    }
    case "review.require_forge_publication": {
      const observed = input.review.forgePublished;
      if (!rule.value) return ok(observed, "forge publication not required");
      return observed
        ? ok(observed, "review is published to the forge")
        : bad(observed, "review is not published to the forge");
    }
    case "review.dismiss_on_base_shift": {
      const observed = input.review.dismissedStaleOnBaseShift;
      if (!rule.value) return ok(observed, "stale-approval dismissal not required");
      return observed
        ? ok(observed, "stale approvals were dismissed on base shift")
        : bad(observed, "stale approvals were not dismissed on base shift");
    }
    case "review.required_principal": {
      const required = rule.value;
      const present = input.review.approvingPrincipals.some(
        (p) => p.kind === required.kind && p.name === required.name,
      );
      const observed = input.review.approvingPrincipals;
      return present
        ? ok(observed, `required principal ${required.kind}:${required.name} approved`)
        : bad(observed, `required principal ${required.kind}:${required.name} did not approve`);
    }
    case "audit.block_at": {
      const observed = input.audit.highestOpenSeverity;
      if (observed === "none") return ok(observed, "no open audit findings");
      const blocks = SEVERITY_ORDINAL[observed] <= SEVERITY_ORDINAL[rule.value];
      return blocks
        ? bad(observed, `open ${observed} finding is at or above the ${rule.value} block threshold`)
        : ok(observed, `open ${observed} finding is below the ${rule.value} block threshold`);
    }
    case "audit.residual_disposition": {
      const observed = input.audit.residualDisposition;
      return DISPOSITION_RANK[observed] >= DISPOSITION_RANK[rule.value]
        ? ok(observed, `residual disposition ${observed} meets required ${rule.value}`)
        : bad(observed, `policy requires ${rule.value} residual disposition, scenario uses ${observed}`);
    }
    case "integration.max_unmerged_ancestor_depth": {
      const observed = input.integration.unmergedAncestorDepth;
      return observed <= rule.value
        ? ok(observed, `unmerged ancestor depth ${observed} within max ${rule.value}`)
        : bad(observed, `unmerged ancestor depth ${observed} exceeds max ${rule.value}`);
    }
    case "integration.require_base_shift_regate": {
      const observed = input.integration.baseShiftRegated;
      if (!rule.value) return ok(observed, "base-shift regate not required");
      return observed
        ? ok(observed, "the change was re-gated after base shift")
        : bad(observed, "the change was not re-gated after base shift");
    }
    case "budget.monthly_usd": {
      const observed = input.budget.monthlySpendUsd;
      return observed <= rule.value
        ? ok(observed, `monthly spend ${observed} within cap ${rule.value}`)
        : bad(observed, `monthly spend ${observed} exceeds cap ${rule.value}`);
    }
    case "budget.per_spec_usd": {
      const observed = input.budget.perSpecSpendUsd;
      return observed <= rule.value
        ? ok(observed, `per-spec spend ${observed} within cap ${rule.value}`)
        : bad(observed, `per-spec spend ${observed} exceeds cap ${rule.value}`);
    }
    case "budget.unknown_cost_action": {
      const observed = input.budget.unknownCostEncountered;
      if (!observed) return ok(observed, "no unknown-cost operation encountered");
      if (rule.value === "pause") return bad(observed, "unknown-cost operation must pause the run");
      return { ...ok(observed, `unknown-cost operation is set to ${rule.value}`), warning: rule.value === "warn" };
    }
    case "notifications.quorum": {
      const observed = input.notifications.acknowledged;
      return observed >= rule.value
        ? ok(observed, `${observed} acknowledgements meet quorum ${rule.value}`)
        : bad(observed, `policy requires ${rule.value} acknowledgements, scenario has ${observed}`);
    }
    case "coverage.max_evidence_age_days": {
      const observed = input.coverage.evidenceAgeDays;
      return observed <= rule.value
        ? ok(observed, `evidence age ${observed}d within max ${rule.value}d`)
        : bad(observed, `evidence age ${observed}d exceeds max ${rule.value}d`);
    }
    default: {
      // Exhaustiveness guard: an unmapped key is inconclusive and MUST NOT allow.
      return {
        status: "not_evaluable",
        observed: undefined,
        detail: `no evaluator for rule ${(rule as { key: string }).key}`,
      };
    }
  }
}

function sourceKey(rule: CompiledPolicyRule): string {
  return rule.key === "review.required_principal" ? `${rule.key} ${JSON.stringify(rule.value)}` : rule.key;
}

/**
 * Evaluate a compiled (contradiction-free) policy against a hypothetical input
 * and return the full decision trace. The decision is `blocked` if any rule is
 * violated OR any rule is not evaluable — inconclusive never resolves to allow.
 */
export function simulateCompiledPolicy(
  ast: CompiledPolicyAst,
  policyHashValue: string,
  input: SimulationInput,
): SimulationResult {
  const evaluations: RuleEvaluation[] = ast.rules.map((rule) => {
    const outcome = evaluateRule(rule as PolicyRule, input);
    return {
      key: rule.key,
      requiredValue: rule.value,
      observed: outcome.observed,
      status: outcome.status,
      detail: outcome.detail,
      warning: outcome.warning === true,
      source: ast.sourceMap[sourceKey(rule)],
    };
  });
  const violations = evaluations.filter((e) => e.status === "violated");
  const notEvaluable = evaluations.filter((e) => e.status === "not_evaluable");
  const warnings = evaluations.filter((e) => e.warning && e.status === "satisfied");
  return {
    decision: violations.length > 0 || notEvaluable.length > 0 ? "blocked" : "allowed",
    policyHash: policyHashValue,
    evaluations,
    violations,
    warnings,
    notEvaluable,
  };
}
