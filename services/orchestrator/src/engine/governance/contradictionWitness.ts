import type { PolicyAst, PolicyLayerName, PolicyRule } from "./policyAst.js";

export type ContradictionWitness =
  | {
      kind: "conflicting_review_modes";
      layer: PolicyLayerName;
      ruleIndexes: readonly number[];
      values: readonly ["auto" | "simulated" | "human", "auto" | "simulated" | "human"];
    }
  | {
      kind: "automatic_review_requires_approval";
      ruleIndexes: readonly number[];
      mode: "auto";
      minimumApprovals: number;
    };

function rulesOf(ast: PolicyAst, layer: PolicyLayerName): readonly PolicyRule[] {
  return ast[layer].rules;
}

/**
 * Return structured proof objects for impossible policy combinations. The
 * compiler deliberately consumes these witnesses instead of converting them
 * to a vague invalid-policy string.
 */
export function findContradictionWitnesses(ast: PolicyAst): readonly ContradictionWitness[] {
  const witnesses: ContradictionWitness[] = [];

  for (const layer of ["core", "org", "tier", "binding"] as const) {
    const rules = rulesOf(ast, layer);
    const modes = rules.flatMap(
      (rule, index): Array<{ index: number; value: "auto" | "simulated" | "human" }> =>
        rule.key === "review.mode" ? [{ index, value: rule.value }] : [],
    );
    const distinctModes = [...new Set(modes.map((entry) => entry.value))];
    if (distinctModes.length > 1) {
      const first = distinctModes[0];
      const second = distinctModes[1];
      if (first !== undefined && second !== undefined) {
        witnesses.push({
          kind: "conflicting_review_modes",
          layer,
          ruleIndexes: modes.filter((entry) => distinctModes.includes(entry.value)).map((entry) => entry.index),
          values: [first, second],
        });
      }
    }
  }

  const allRules = (["core", "org", "tier", "binding"] as const).flatMap((layer) =>
    rulesOf(ast, layer).map((rule, index) => ({ layer, index, rule })),
  );
  const mode = allRules
    .filter(
      (entry): entry is { layer: PolicyLayerName; index: number; rule: Extract<PolicyRule, { key: "review.mode" }> } =>
        entry.rule.key === "review.mode",
    )
    .sort((left, right) => {
      const rank: Record<"auto" | "simulated" | "human", number> = { auto: 0, simulated: 1, human: 2 };
      return rank[right.rule.value] - rank[left.rule.value];
    })[0];
  const minimumApprovals = allRules.reduce(
    (maximum, entry) => (entry.rule.key === "review.minimum_approvals" ? Math.max(maximum, entry.rule.value) : maximum),
    0,
  );
  if (mode?.rule.key === "review.mode" && mode.rule.value === "auto" && minimumApprovals > 0) {
    witnesses.push({
      kind: "automatic_review_requires_approval",
      ruleIndexes: [
        mode.index,
        ...allRules.filter((entry) => entry.rule.key === "review.minimum_approvals").map((entry) => entry.index),
      ],
      mode: "auto",
      minimumApprovals,
    });
  }

  return witnesses;
}
