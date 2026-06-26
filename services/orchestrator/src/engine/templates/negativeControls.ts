// NEGATIVE-CONTROL injectors — the core of the "meaningful, not green-by-accident"
// proof. For each declared gate capability, an injector PLANTS a temporary defect
// into a SCRATCH COPY of the template, the harness runs the capability's gate over
// that scratch copy, and asserts the gate CATCHES the defect (fails). The scratch
// copy is ALWAYS discarded — the real template is never mutated.
//
// WHY (the v29 lesson): a `tsc --noEmit` over an empty `files` array PASSES while
// checking zero files. Running the typecheck on a CLEAN tree can't distinguish a real
// typecheck from that no-op. Planting a type error and demanding the gate FAIL is the
// only thing that proves the gate actually checks. A gate that still passes with the
// defect present is `unproven` (the v29 failure mode), not `proven`.
//
// STACK-AGNOSTIC where reasonable: the injectors drive off the DECLARED CAPABILITY +
// the template's lifecycle (which `just <target>` runs the gate), not a hardcoded
// pnpm/tsc assumption. A capability carries:
//   - `tier`: which CI tier (`fast`/`slow`/`merge`) runs the gate that must catch it,
//     OR a direct `step` command for capabilities (mutation) not on the tier map.
//   - an `inject` strategy that writes a defect file into the scratch copy.
// The default strategies cover the common shapes (a typescript type error, a lint
// violation, a broken-test assertion, a mutation seed). A never-seen stack supplies
// its own per-capability `inject` via `NegativeControlPlan.overrides`, keeping the
// harness itself stack-free.

import type { CiConfigV1, CiWhen } from "../ci/index.js";

// The negative-control capabilities the doc names (templating-system.md §1 / §2.4).
// `typecheck` / `lint` / `test` are the required-gate trio; `mutation` is optional
// (only declared when the template ships a mutation step).
export type NegativeControlCapability = "typecheck" | "lint" | "test" | "mutation";

// How a capability's gate is run during the negative-control pass:
//   - `{ kind: "tier", when }`: run the CI tier mapped to this lifecycle point over
//     the scratch copy (reuses the gate-runner; the typecheck/lint/test gates live in
//     the tiers, e.g. tier-1 for typecheck+lint, tier-2 for test).
//   - `{ kind: "step", run }`: run a single declared shell step directly (mutation —
//     the template declares its mutation command, which is not on the tier map).
export type GateInvocation = { kind: "tier"; when: CiWhen } | { kind: "step"; run: string };

// A single file written into the scratch copy to plant the defect. `path` is relative
// to the scratch repo root; `content` REPLACES the file when `mode: "overwrite"` or is
// a new file when the path does not exist. We overwrite a whole file (rather than
// patch in place) so the injector needs no knowledge of the file's existing contents —
// it just drops a known-defective source the gate must reject.
export interface InjectedDefectFile {
  path: string;
  content: string;
}

// The defect an injector plants. `files` are written into the scratch copy before the
// gate runs; `description` is recorded on the result so an `unproven` verdict names
// exactly what the gate failed to catch.
export interface PlantedDefect {
  description: string;
  files: ReadonlyArray<InjectedDefectFile>;
}

// One negative control: a capability, the gate that must catch its defect, and the
// defect to plant. `coveredSourcePath` is the source file the planted defect lands in
// — it MUST be a file the capability's gate actually covers (the whole point: a
// typecheck that excludes this file is the no-op the control exposes).
export interface NegativeControl {
  capability: NegativeControlCapability;
  invocation: GateInvocation;
  defect: PlantedDefect;
}

// ---- Default (typescript-shaped) injectors ---------------------------------
// These cover the ts-pnpm template (the apex stack) out of the box. They are NOT
// special-cased in the harness: a different stack overrides them per-capability. The
// `coveredSourcePath` defaults to a conventional source location; a template whose
// covered source lives elsewhere passes its own path.

// A planted TYPE ERROR: a `const` annotated `number` assigned a string. A real
// typecheck rejects this; a no-op typecheck (empty `files`, wrong tsconfig — the v29
// bug) passes it. The file is a NEW source under the covered source root, so the
// injector needs no existing-file knowledge.
export function typeErrorDefect(coveredSourcePath: string): PlantedDefect {
  return {
    description: `planted type error in ${coveredSourcePath} (number := string)`,
    files: [
      {
        path: coveredSourcePath,
        content:
          "// TANREN NEGATIVE CONTROL — planted type error. A real typecheck MUST reject this.\n" +
          'export const tanrenNegativeControlTypeError: number = "not a number";\n',
      },
    ],
  };
}

// A planted LINT VIOLATION: a debugger statement + an unused, redeclared binding —
// shapes virtually every linter flags. A real lint gate rejects this; a no-op lint
// (a linter pointed at no files, or with every rule off) passes it.
export function lintViolationDefect(coveredSourcePath: string): PlantedDefect {
  return {
    description: `planted lint violation in ${coveredSourcePath} (debugger + no-unused)`,
    files: [
      {
        path: coveredSourcePath,
        content:
          "// TANREN NEGATIVE CONTROL — planted lint violation. A real lint gate MUST reject this.\n" +
          "export function tanrenNegativeControlLint() {\n" +
          "  debugger;\n" +
          "  var tanrenUnused = 1;\n" +
          "}\n",
      },
    ],
  };
}

// A planted FAILING TEST: a test whose assertion can never hold (1 === 2). A real test
// gate (`just tier-2`) fails; a no-op test gate (no test files discovered, the runner
// exiting 0 on "no tests") passes it. The test file is dropped in a conventional test
// location so the runner discovers it.
export function failingTestDefect(testPath: string): PlantedDefect {
  return {
    description: `planted failing test in ${testPath} (assertion can never hold)`,
    files: [
      {
        path: testPath,
        content:
          "// TANREN NEGATIVE CONTROL — planted failing test. A real test gate MUST fail on this.\n" +
          'import { describe, expect, it } from "vitest";\n' +
          'describe("tanren negative control", () => {\n' +
          '  it("is a planted always-failing assertion", () => {\n' +
          "    expect(1).toBe(2);\n" +
          "  });\n" +
          "});\n",
      },
    ],
  };
}

// A planted MUTATION SEED: a source whose only behavior is a function the template's
// own test asserts, written so a mutation operator can flip it. The mutation control
// runs the template's mutation step over the scratch copy and asserts the seeded
// mutant is KILLED (the step fails / reports a surviving-mutant escape as nonzero).
// The seed is deliberately trivial so the template's existing tests cover it.
export function mutationSeedDefect(seedPath: string): PlantedDefect {
  return {
    description: `planted mutation seed in ${seedPath} (a mutable boolean the tests assert)`,
    files: [
      {
        path: seedPath,
        content:
          "// TANREN NEGATIVE CONTROL — mutation seed. The template's mutation step MUST kill\n" +
          "// the mutant produced from this (a surviving mutant means the gate is unproven).\n" +
          "export function tanrenNegativeControlMutant(value: number): boolean {\n" +
          "  return value > 0;\n" +
          "}\n",
      },
    ],
  };
}

// Default covered-source / test paths for the typescript-shaped template. A stack with
// a different layout passes its own paths into the plan builder below.
export const DEFAULT_TS_COVERED_SOURCE_PATH = "src/tanren-negative-control.ts";
export const DEFAULT_TS_TEST_PATH = "tests/tanren-negative-control.test.ts";
export const DEFAULT_TS_MUTATION_SEED_PATH = "src/tanren-negative-control-mutant.ts";

// ---- Plan builder ----------------------------------------------------------

// Which gate runs each capability's defect-catch. `typecheck` + `lint` live on the
// per-iteration tier (tier-1); `test` lives on the pre-audit tier (tier-2). `mutation`
// is not on the tier map — it runs its own declared step. A stack whose lifecycle maps
// differently passes its own invocations.
export const DEFAULT_TS_INVOCATIONS: Readonly<Record<Exclude<NegativeControlCapability, "mutation">, GateInvocation>> =
  Object.freeze({
    typecheck: { kind: "tier", when: "per_iteration" },
    lint: { kind: "tier", when: "per_iteration" },
    test: { kind: "tier", when: "pre_audit" },
  });

// What a template DECLARES (the negative-control capability surface). The required
// gate trio is always declared; `mutationStep` is present ONLY when the template ships
// a mutation gate — its presence is what flips the mutation control from `n/a` to a
// real proof. A stack with non-default paths/invocations passes overrides.
export interface NegativeControlPlanInput {
  // The covered source the typecheck/lint defects land in (a file the gate covers).
  coveredSourcePath?: string;
  // Where the failing-test defect is dropped (the test runner must discover it).
  testPath?: string;
  // The mutation gate's command — declared ⇒ a real mutation negative control; absent
  // ⇒ mutation is `n/a`.
  mutationStep?: string;
  // Where the mutation seed lands (a source the template's own tests cover).
  mutationSeedPath?: string;
  // Per-capability invocation overrides (a stack whose tiers map differently).
  invocations?: Partial<Record<NegativeControlCapability, GateInvocation>>;
}

// Build the standard negative-control set for a template. Always emits typecheck +
// lint + test; emits mutation ONLY when `mutationStep` is declared. A capability NOT
// in the returned list is recorded `n/a` by the harness — so omitting `mutationStep`
// is exactly "mutation not declared → n/a".
export function buildNegativeControlPlan(input: NegativeControlPlanInput = {}): NegativeControl[] {
  const coveredSource = input.coveredSourcePath ?? DEFAULT_TS_COVERED_SOURCE_PATH;
  const testPath = input.testPath ?? DEFAULT_TS_TEST_PATH;
  const inv = (capability: NegativeControlCapability, fallback: GateInvocation): GateInvocation =>
    input.invocations?.[capability] ?? fallback;

  const controls: NegativeControl[] = [
    {
      capability: "typecheck",
      invocation: inv("typecheck", DEFAULT_TS_INVOCATIONS.typecheck),
      defect: typeErrorDefect(coveredSource),
    },
    {
      capability: "lint",
      invocation: inv("lint", DEFAULT_TS_INVOCATIONS.lint),
      defect: lintViolationDefect(coveredSource),
    },
    {
      capability: "test",
      invocation: inv("test", DEFAULT_TS_INVOCATIONS.test),
      defect: failingTestDefect(testPath),
    },
  ];

  if (input.mutationStep !== undefined && input.mutationStep !== "") {
    controls.push({
      capability: "mutation",
      invocation: inv("mutation", { kind: "step", run: input.mutationStep }),
      defect: mutationSeedDefect(input.mutationSeedPath ?? DEFAULT_TS_MUTATION_SEED_PATH),
    });
  }
  return controls;
}

// ---- Evidence-declaration check (apex v57 task #64) ------------------------

/**
 * The list of evidence-declaration violations a CI config carries — one entry per
 * merge-gating tier (`pre_audit` / `pre_merge`) whose every step is judged on exit
 * code alone (no `evidence` block, no legacy `junitReport`). Empty ⇒ every merge-
 * gating tier declares positive evidence.
 *
 * Defense-in-depth for template-validation: the `CiConfigV1` schema already rejects
 * a config that ships vacuous merge-gating at parse time (see schema.ts §EVIDENCE-
 * GATED TIERS), so a valid `CiConfigV1` returned by `resolveCiConfig` will always
 * yield an empty list here. This helper exists so template-creation can ALSO assert
 * the negative-control plan's promise (the gate ACTUALLY proves something) without
 * having to re-run the schema; the apex doctrine (`templating-system.md` §1.5) demands
 * a template ship NO vacuous merge gate, and this is the explicit assertion.
 */
export interface VacuousMergeGate {
  tier: string;
  when: CiWhen;
}

export function findVacuousMergeGates(config: CiConfigV1): VacuousMergeGate[] {
  const violations: VacuousMergeGate[] = [];
  for (const [tierName, points] of Object.entries(config.when)) {
    const evidenceGated = points.find((p) => p === "pre_audit" || p === "pre_merge");
    if (evidenceGated === undefined) continue;
    const steps = config.tiers[tierName] ?? [];
    const hasEvidence = steps.some((step) => step.evidence !== undefined || step.junitReport !== undefined);
    if (!hasEvidence) violations.push({ tier: tierName, when: evidenceGated });
  }
  return violations;
}

/**
 * Assert every merge-gating tier in `config` declares POSITIVE EVIDENCE — throw loudly
 * if any tier ships vacuous defaults. Intended as a template-validation assertion: a
 * template that ships a `pre_audit`/`pre_merge` tier judged on exit code alone is the
 * v57 green-by-accident class (the writer can ship merged code with zero tests run).
 * The error message names the tier + the lifecycle point so the operator (or the
 * template-build self-heal) sees WHICH tier to fix.
 */
export function assertEvidenceDeclared(config: CiConfigV1): void {
  const violations = findVacuousMergeGates(config);
  if (violations.length === 0) return;
  const summary = violations.map((v) => `tier "${v.tier}" maps to "${v.when}"`).join("; ");
  throw new Error(
    `template ships VACUOUS merge gate(s) — every merge-gating tier MUST declare positive evidence ` +
      `(an \`evidence\` block or the legacy \`junitReport\`) on at least one step. Violations: ${summary}.`,
  );
}
