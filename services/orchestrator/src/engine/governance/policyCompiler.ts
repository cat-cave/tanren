import { findContradictionWitnesses, type ContradictionWitness } from "./contradictionWitness.js";
import {
  parsePolicyAst,
  POLICY_LAYER_ORDER,
  type PolicyAst,
  type PolicyLayerName,
  type PolicyRule,
} from "./policyAst.js";
import { policyHash } from "./policyHash.js";

export interface CompiledPolicyRule {
  key: PolicyRule["key"];
  value: PolicyRule["value"];
}

export interface PolicySource {
  layer: PolicyLayerName;
  ruleIndexes: readonly number[];
}

export interface CompiledPolicyAst {
  apiVersion: PolicyAst["apiVersion"];
  schemaVersion: number;
  aggregationOrder: readonly PolicyLayerName[];
  rules: readonly CompiledPolicyRule[];
  sourceMap: Readonly<Record<string, PolicySource>>;
}

export interface CompiledPolicy {
  status: "compiled";
  ast: CompiledPolicyAst;
  policyHash: string;
  ruleCount: number;
  contradictionWitnesses: readonly [];
}

export interface ContradictoryPolicy {
  status: "contradictory";
  contradictionWitnesses: readonly ContradictionWitness[];
}

export type PolicyCompileResult = CompiledPolicy | ContradictoryPolicy;

const restrictiveness: Record<string, ReadonlyMap<string, number>> = {
  "repository.visibility": new Map([
    ["public", 0],
    ["private", 1],
  ]),
  "review.mode": new Map([
    ["auto", 0],
    ["simulated", 1],
    ["human", 2],
  ]),
  "review.freshness": new Map([
    ["none", 0],
    ["branch_head", 1],
    ["exact_head_sha", 2],
  ]),
  "audit.block_at": new Map([
    ["P0", 0],
    ["P1", 1],
    ["P2", 2],
    ["P3", 3],
  ]),
  "audit.residual_disposition": new Map([
    ["risk_accepted", 0],
    ["new_spec", 1],
    ["human_required", 2],
  ]),
  "budget.unknown_cost_action": new Map([
    ["allow", 0],
    ["warn", 1],
    ["pause", 2],
  ]),
};

const numericDirection: Record<string, "higher" | "lower"> = {
  "review.minimum_approvals": "higher",
  "integration.max_unmerged_ancestor_depth": "lower",
  "budget.monthly_usd": "lower",
  "budget.per_spec_usd": "lower",
  "notifications.quorum": "higher",
  "coverage.max_evidence_age_days": "lower",
};

function valueKey(value: PolicyRule["value"]): string {
  return JSON.stringify(value);
}

function isMoreRestrictive(
  key: PolicyRule["key"],
  candidate: PolicyRule["value"],
  current: PolicyRule["value"],
): boolean {
  if (
    key === "review.require_forge_publication" ||
    key === "review.dismiss_on_base_shift" ||
    key === "integration.require_base_shift_regate"
  ) {
    return candidate === true && current === false;
  }
  const ordered = restrictiveness[key];
  if (ordered !== undefined) {
    const candidateKey = typeof candidate === "string" ? candidate : valueKey(candidate);
    const currentKey = typeof current === "string" ? current : valueKey(current);
    return (ordered.get(candidateKey) ?? 0) > (ordered.get(currentKey) ?? 0);
  }
  const direction = numericDirection[key];
  if (direction === "higher") return Number(candidate) > Number(current);
  if (direction === "lower") return Number(candidate) < Number(current);
  return false;
}

function byCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ruleOrder(rule: CompiledPolicyRule): string {
  return `${rule.key}\u0000${valueKey(rule.value)}`;
}

function selectionKey(rule: PolicyRule): string {
  // This key becomes a persisted `compiled_ast.sourceMap` property. PostgreSQL
  // JSON rejects the NUL escape, so it must be printable while still retaining
  // one source-map entry per distinct required principal.
  return rule.key === "review.required_principal"
    ? `${rule.key}:${encodeURIComponent(valueKey(rule.value))}`
    : rule.key;
}

function compileWithoutContradictions(ast: PolicyAst): CompiledPolicyAst {
  const selected = new Map<string, { rule: PolicyRule; source: PolicySource }>();
  for (const layer of POLICY_LAYER_ORDER) {
    ast[layer].rules.forEach((rule, ruleIndex) => {
      const current = selected.get(selectionKey(rule));
      if (current === undefined || isMoreRestrictive(rule.key, rule.value, current.rule.value)) {
        selected.set(selectionKey(rule), {
          rule,
          source: {
            layer,
            ruleIndexes: [ruleIndex],
          },
        });
      } else if (current.rule.value === rule.value) {
        selected.set(selectionKey(rule), {
          rule: current.rule,
          source: {
            layer: current.source.layer,
            ruleIndexes: [...current.source.ruleIndexes, ruleIndex],
          },
        });
      }
    });
  }

  const rules = [...selected.values()]
    .map(({ rule }) => ({ key: rule.key, value: rule.value }))
    .sort((left, right) => byCodepoint(ruleOrder(left), ruleOrder(right)));
  const sourceMap = Object.fromEntries(
    [...selected.entries()]
      .sort(([left], [right]) => byCodepoint(left, right))
      .map(([key, selectedRule]) => [key, selectedRule.source]),
  );
  return {
    apiVersion: ast.apiVersion,
    schemaVersion: ast.schemaVersion,
    aggregationOrder: POLICY_LAYER_ORDER,
    rules,
    sourceMap,
  };
}

/** Compile only validated typed data; natural-language interpretation is impossible here. */
export function compilePolicy(input: unknown): PolicyCompileResult {
  const ast = parsePolicyAst(input);
  const contradictionWitnesses = findContradictionWitnesses(ast);
  if (contradictionWitnesses.length > 0) return { status: "contradictory", contradictionWitnesses };
  const compiledAst = compileWithoutContradictions(ast);
  return {
    status: "compiled",
    ast: compiledAst,
    policyHash: policyHash(compiledAst),
    ruleCount: compiledAst.rules.length,
    contradictionWitnesses: [],
  };
}
