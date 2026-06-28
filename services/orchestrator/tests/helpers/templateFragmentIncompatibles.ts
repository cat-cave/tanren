// SHARED: cross-runtime INCOMPATIBLE_COMBINATIONS list (task #72).
//
// The matrix coverage harness (`templateFragmentMatrixCoverage.test.ts`) uses this to
// FILTER incompatible combos out of the "compose cleanly" loop; the cross-runtime
// mismatch harness (`templateFragmentDependsOnRuntimeMismatch.test.ts`) uses the same
// list to assert each entry MUST throw with a `dependency_runtime_mismatch` payload.
// Sharing the list keeps the two harnesses in lock-step — a new runtime-dependent
// fragment must register one entry here and the two harnesses both pick it up.
//
// Doctrine: a fragment declaring `dependsOn: [<runtime-*>]` cannot pair with a
// different runtime — today react-router, remix, postgres-prisma, and biome are the
// four. `addon-docker` is stack-agnostic (inspects `config.runtime`) so has no entry.
// Steady state: `INCOMPATIBLE_COMBINATIONS.length === 0`. An entry here is a
// contract debt; prefer making a fragment stack-agnostic over adding an exclusion.

import type { FragmentKind, TemplateConfig } from "../../src/engine/templates/index.js";

export interface NormalizedCombo {
  readonly runtime: TemplateConfig["runtime"];
  readonly frontend?: NonNullable<TemplateConfig["frontend"]>;
  readonly backend?: NonNullable<TemplateConfig["backend"]>;
  readonly db?: NonNullable<TemplateConfig["db"]>;
  readonly auth?: NonNullable<TemplateConfig["auth"]>;
  readonly deploy: TemplateConfig["deploy"];
  readonly addons: readonly TemplateConfig["addons"][number][];
  readonly examples: readonly TemplateConfig["examples"][number][];
}

export interface IncompatibleCombinationRule {
  readonly predicate: (combo: NormalizedCombo) => boolean;
  readonly fragmentId: string;
  readonly phase: FragmentKind;
  readonly requiredRuntime: string;
  readonly reason: string;
}

/** The compose-phase apply order. The composer's pre-flight walks fragments in this
 * order + throws on the FIRST cross-runtime fragment encountered; `pickFirstMatchingRule`
 * mirrors this so the harness can predict the SAME fragment the pre-flight will name. */
export const PHASE_ORDER: readonly FragmentKind[] = [
  "base",
  "runtime",
  "frontend",
  "backend",
  "db",
  "auth",
  "addon",
  "example",
  "deploy",
];

export const INCOMPATIBLE_COMBINATIONS: readonly IncompatibleCombinationRule[] = [
  {
    predicate: (c) => c.runtime === "ruby-bundler" && c.frontend === "react-router",
    fragmentId: "frontend-react-router",
    phase: "frontend",
    requiredRuntime: "runtime-node-pnpm",
    reason: "frontend-react-router declares dependsOn: [runtime-node-pnpm] — react is a node tool.",
  },
  {
    predicate: (c) => c.runtime === "ruby-bundler" && c.frontend === "remix",
    fragmentId: "frontend-remix",
    phase: "frontend",
    requiredRuntime: "runtime-node-pnpm",
    reason: "frontend-remix declares dependsOn: [runtime-node-pnpm] — remix is a node tool.",
  },
  {
    predicate: (c) => c.runtime === "ruby-bundler" && c.db === "postgres-prisma",
    fragmentId: "db-postgres-prisma",
    phase: "db",
    requiredRuntime: "runtime-node-pnpm",
    reason: "db-postgres-prisma declares dependsOn: [runtime-node-pnpm] — prisma is a node tool.",
  },
  {
    predicate: (c) => c.runtime === "ruby-bundler" && c.addons.includes("biome"),
    fragmentId: "addon-biome",
    phase: "addon",
    requiredRuntime: "runtime-node-pnpm",
    reason: "addon-biome declares dependsOn: [runtime-node-pnpm] — biome is a node tool.",
  },
];

/** Sort INCOMPATIBLE_COMBINATIONS hits by compose-phase order + return the first
 * matching rule for `combo`, so the harness predicts the SAME fragment the
 * composer's pre-flight will throw on. Returns `undefined` when no rule matches. */
export function pickFirstMatchingRule(combo: NormalizedCombo): IncompatibleCombinationRule | undefined {
  const matches = INCOMPATIBLE_COMBINATIONS.filter((rule) => rule.predicate(combo));
  if (matches.length === 0) return undefined;
  return matches.slice().sort((a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase))[0];
}

/** True iff any INCOMPATIBLE_COMBINATIONS predicate matches `combo`. Used by the
 * matrix coverage harness to exclude these from the "compose cleanly" loop. */
export function isIncompatibleCombination(combo: NormalizedCombo): boolean {
  return INCOMPATIBLE_COMBINATIONS.some((rule) => rule.predicate(combo));
}
