import { z } from "zod";

// Versioned Zod schema for `tanren-ci.yml` — the repo-sourced tiered CI
// contract. Tanren's native in-loop gate is the sole CI authority (Action-less
// delivery): it reads this contract and runs the declared shell steps over SSH.
// This module is the contract + parser ONLY — it never executes a step (the gate
// stage that runs the steps lives under workflow/gate/).

// ---- Lifecycle points -----------------------------------------------------

// The points in a run's lifecycle at which a tier may be invoked. A tier is
// mapped to one or more of these via the `when` policy below. Declarative so
// the in-loop gate can ask "which tiers run at this point?" without
// hard-coding tier names.
export const CiWhen = z.enum(["per_iteration", "pre_audit", "pre_merge"]);
export type CiWhen = z.infer<typeof CiWhen>;

// ---- Steps -----------------------------------------------------------------

// EVIDENCE CONTRACT (apex v57 task #64) — the POSITIVE PROOF a step must produce to
// be judged successful. The runtime gate (workflow/gate/runGateTier) checks for this
// evidence AFTER the step exits; a step that exits 0 with insufficient evidence FAILS
// the tier with `failedReason: "evidence_insufficient"`. This eradicates the v57
// green-by-accident class: `tsc --noEmit` over an empty `files` array passes while
// checking zero files; `vitest run` with no test files passes while running zero
// tests; `playwright test` with no browsers installed passes while running nothing.
// The negative-control doctrine (templates/negativeControls.ts §v29) is now ALSO
// enforced at every runtime gate, not just template-validation. Discriminated:
//   - `kind: "junit"`         — the step writes a JUnit report at `reportPath`; the
//                               gate parses it and asserts `total >= minTests`.
//                               `minTests` MUST be ≥ 1 (a 0 threshold is vacuous).
//                               `reportPath` MUST be a non-empty workspace path.
//   - `kind: "artifact"`      — the step writes an artifact at `path`; the gate stats
//                               it and asserts presence (+ `minBytes` when given).
//   - `kind: "stdout-count"`  — the step's stdout must contain `pattern` (a regex
//                               source) at least `min` times. `min` MUST be ≥ 1.
export const CiStepEvidence = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("junit"),
      reportPath: z.string().min(1),
      minTests: z.number().int().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("artifact"),
      path: z.string().min(1),
      minBytes: z.number().int().min(0).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("stdout-count"),
      pattern: z.string().min(1),
      min: z.number().int().min(1),
    })
    .strict(),
]);
export type CiStepEvidence = z.infer<typeof CiStepEvidence>;

// ---- Regression contract ----------------------------------------------------

// REGRESSION CONTRACT — the declaration that makes a test step safe to run at
// `per_iteration`. The full argument lives in engine/ci/regression.ts.
//
// A step that declares `regression` is judged NOT on whether its suite is green, but on
// whether it BROKE something that was green: the gate parses the step's JUnit report at
// `reportPath` and fails ONLY when a test that PASSED on the run's untouched base tree
// now fails. A test the writer is in the middle of authoring is not in the baseline and
// therefore cannot fail this step — which is what makes tests survivable in the writer's
// own loop, where a failure is fed back as steering in the context that produced it.
//
// WHY A SEPARATE FIELD AND NOT AN `evidence` KIND. `evidence` is POSITIVE PROOF harvested
// on an exit-0 — it answers "did the declared work actually run?". This contract answers
// a different question ("did this change break something?"), and it applies on the
// NONZERO-exit path that `evidence` deliberately never touches: a step whose suite is red
// exits nonzero, and that exit is precisely what must stop being an automatic tier
// failure. The two COMPOSE — a step may declare both, and each keeps its own meaning.
//
// SCOPE DISCIPLINE: this changes how THIS step is judged, at the lifecycle points its
// tier maps to. It is intended for `per_iteration`. It does NOT weaken `pre_audit` /
// `pre_merge`, which run their own unscoped, absolute test steps under `minTests` floors
// — the merge authority is untouched, so a regression that somehow escaped the
// per-iteration judgment still cannot merge.
export const CiStepRegression = z
  .object({
    reportPath: z.string().min(1),
  })
  .strict();
export type CiStepRegression = z.infer<typeof CiStepRegression>;

// A single named shell command within a tier. `run` is an opaque shell string
// executed verbatim by the consumer; this module does not parse or validate
// shell syntax.
//
// `junitReport` is the LEGACY explicit CI-config contract for the CI-intelligence
// per-test grain: a step that runs tests DECLARES the workspace-relative path it
// writes its JUnit report to (e.g. `reports/junit.xml`). Tanren's native gate reads
// back EXACTLY that declared path after the step runs and ingests the per-test rows
// (flaky→quarantine→root-cause). This is a DECLARED field, never a command-string
// sniff: a step is "junit-producing" iff it sets `junitReport`, so the writer's
// actual test command (`just tier-2`, which does NOT mention the path) is recognized.
// STACK-AGNOSTIC: the path is the project's declaration — Tanren names no test runner,
// only honors the path the project says it emits. Absent ⇒ the step produces no grain
// (the clean no-op skip); present-but-absent-after-run ⇒ a LOUD `ci.junit_missing`.
//
// EVIDENCE BACK-COMPAT: a step that sets `junitReport: X` and OMITS `evidence` is
// promoted to `evidence: { kind: "junit", reportPath: X, minTests: 1 }` at the
// runtime gate (see {@link evidenceForStep} below). A step MAY also declare an
// explicit `evidence` block (e.g. a higher `minTests`); the explicit declaration
// always wins. A `junitReport` PLUS a non-junit `evidence` declaration is permitted
// (artifact + junit), but the junit promotion only applies when no `evidence` is set.
export const CiStep = z
  .object({
    name: z.string().min(1),
    run: z.string().min(1),
    junitReport: z.string().min(1).optional(),
    evidence: CiStepEvidence.optional(),
    // The pass→fail TRANSITION contract (see `CiStepRegression`). Optional; a step that
    // declares none is judged exactly as before (exit code, then evidence).
    regression: CiStepRegression.optional(),
  })
  .strict();
export type CiStep = z.infer<typeof CiStep>;

/**
 * Resolve the EFFECTIVE evidence contract for a step — the runtime gate's positive-
 * proof requirement. An explicit `evidence` declaration always wins. Otherwise, a
 * legacy `junitReport: X` promotes to `{ kind: "junit", reportPath: X, minTests: 1 }`
 * so the back-compat path enforces "at least one test must run" without ceremony.
 * Returns `undefined` when the step declares neither — the step is judged on exit
 * code alone (the per-iteration cheap tiers: lint, typecheck).
 */
export function evidenceForStep(step: CiStep): CiStepEvidence | undefined {
  if (step.evidence !== undefined) return step.evidence;
  if (step.junitReport !== undefined) {
    return { kind: "junit", reportPath: step.junitReport, minTests: 1 };
  }
  return undefined;
}

// ---- Bootstrap -------------------------------------------------------------

// Optional install/bootstrap command run before any tier. workspace
// bootstrap reads this to provision dependencies (conventionally `just bootstrap`,
// deferring to the project's stack — Tanren names no tech stack itself).
export const CiBootstrap = z
  .object({
    run: z.string().min(1),
  })
  .strict();
export type CiBootstrap = z.infer<typeof CiBootstrap>;

// ---- Upgrade ---------------------------------------------------------------

// Optional `upgrade` verb (environment-management.md §4.5 + §7 P1) — the
// project-declared command that BUMPS this project's dependencies to latest and
// regenerates its lockfile (conventionally `just upgrade`, deferring to the
// project's stack — Tanren names NO dependency-manager: `pnpm update --latest`,
// `cargo update`, `uv lock --upgrade`, `go get -u ./...`, …). Same opaque `{ run }`
// shape as `bootstrap`; Tanren never parses the shell.
//
// This verb only PRODUCES the new declaration/lockfile. What makes a version change
// SAFE is that it runs as a first-class DAG node through the same never-break-main
// gate as any code change (§4.5) — the upgrade-spec generator
// (engine/forge/upgrade/generator.ts) inserts it via the existing spec-creation path,
// NEVER as a side stream that mutates dependencies and merges un-gated. Optional: a
// project that declares no `upgrade` verb has no Tanren-driven forced-upgrade lever
// (the design's Renovate escape hatch is FUTURE work, not this verb).
export const CiUpgrade = z
  .object({
    run: z.string().min(1),
  })
  .strict();
export type CiUpgrade = z.infer<typeof CiUpgrade>;

// ---- Deploy ----------------------------------------------------------------

// Optional `deploy` verb — the project-declared command that releases the built
// artifact to its target (conventionally `just deploy`, deferring to the project's
// stack — Tanren names NO deploy tool). It is the ci.yml HOME for the lifecycle's
// `deploy` command (engine/forge/interview/types.ts; the lifecycle's first-class
// `deploy` point); a template-build's `deploy` spec projects its lifecycle deploy
// command HERE, so the strict `CiConfigV1` accepts a `.tanren/ci.yml` that carries
// it. Same opaque `{ run }` shape as `bootstrap`/`upgrade`; Tanren never parses the
// shell.
//
// STACK-AGNOSTIC + TARGET-AGNOSTIC: `run` holds ONLY the project's own deploy
// COMMAND — never a stack-specific (vercel/fly/…) branch. The deploy PROVIDER/TARGET
// (the app to release onto + its credentials) is a separate concern, resolved from
// the org's integration grants (engine/postMerge/deployTargetResolution.ts), not
// from this verb. Optional: a project that declares no `deploy` verb has no
// Tanren-runnable deploy COMMAND (absence is semantic — no silent fallback).
export const CiDeploy = z
  .object({
    run: z.string().min(1),
  })
  .strict();
export type CiDeploy = z.infer<typeof CiDeploy>;

// ---- Tiers -----------------------------------------------------------------

// The set of named tiers. `fast` and `slow` are REQUIRED so the in-loop gate
// always has a cheap per-iteration tier and an expensive pre-merge tier;
// additional named tiers are permitted for projects that want finer control.
export const CiTiers = z
  .object({
    fast: z.array(CiStep).min(1),
    slow: z.array(CiStep).min(1),
  })
  .catchall(z.array(CiStep).min(1));
export type CiTiers = z.infer<typeof CiTiers>;

// ---- When policy -----------------------------------------------------------

// Declarative mapping from tier name -> the lifecycle points at which it runs.
// Validated against the declared tiers (see CiConfigV1's superRefine) so a
// policy can never reference a tier that does not exist, and so every required
// tier participates in the lifecycle.
export const CiWhenPolicy = z.record(z.string().min(1), z.array(CiWhen).min(1));
export type CiWhenPolicy = z.infer<typeof CiWhenPolicy>;

// ---- Top-level config ------------------------------------------------------

export const CiConfigV1 = z
  .object({
    version: z.literal(1),
    bootstrap: CiBootstrap.optional(),
    // The project's dependency-bump command (environment-management.md §4.5/§7 P1).
    // Optional + opaque — see `CiUpgrade`. Tanren runs it inside a gated upgrade DAG
    // node, never a side stream.
    upgrade: CiUpgrade.optional(),
    // The project's deploy command (engine/forge/interview lifecycle `deploy`). Optional
    // + opaque — see `CiDeploy`. The ci.yml HOME for the lifecycle deploy command, so a
    // template-build's `deploy` spec can author a ci.yml that carries it (the strict
    // schema rejected it before this verb existed). Stack/target-agnostic: just the
    // project's COMMAND; the deploy provider/target is a separate org-integration concern.
    deploy: CiDeploy.optional(),
    tiers: CiTiers,
    when: CiWhenPolicy,
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const tierNames = new Set(Object.keys(cfg.tiers));
    // Every `when` key must name a declared tier.
    for (const tierName of Object.keys(cfg.when)) {
      if (!tierNames.has(tierName)) {
        ctx.addIssue({
          code: "custom",
          path: ["when", tierName],
          message: `when policy references unknown tier "${tierName}"`,
        });
      }
    }
    // Every declared tier must have a `when` mapping; an unmapped tier would
    // silently never run, which violates "fail loudly, never silently skip".
    for (const tierName of tierNames) {
      if (cfg.when[tierName] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["when", tierName],
          message: `tier "${tierName}" has no when policy entry`,
        });
      }
    }
    // §3.12 FAIL-CLOSED PRE_MERGE COVERAGE: at least one tier MUST map to `pre_merge`. The
    // `pre_merge` gate is the MERGE AUTHORITY — `runGateForWhen` returns a PASSING empty
    // verdict when no tier maps to it (an empty tier set is a vacuous pass), so a config that
    // leaves `pre_merge` uncovered makes `tanren/gate: success` a VACUOUS pass that lands
    // anything. A repo-sourced (writer-editable) ci.yml that drops pre_merge coverage must
    // FAIL the config (loud), never silently authorize an un-gated merge.
    const coversPreMerge = Object.values(cfg.when).some((points) => points.includes("pre_merge"));
    if (!coversPreMerge) {
      ctx.addIssue({
        code: "custom",
        path: ["when"],
        message:
          "no tier maps to `pre_merge` — the pre_merge gate is the merge authority; an uncovered pre_merge is a vacuous pass (fail-closed)",
      });
    }
    // EVIDENCE-GATED TIERS (apex v57 task #64): every tier mapped to `pre_audit` or
    // `pre_merge` MUST declare at least one step that produces POSITIVE evidence (either
    // an explicit `evidence` block or the legacy `junitReport`, which promotes). A
    // pre-merge tier that is only lint/typecheck cannot be the merge authority — it
    // exits 0 even when no real verification ran (the v57 green-by-accident class).
    // Fail-closed at config-resolve time so a writer-authored ci.yml that ships a
    // vacuous merge gate dies loud, not silently authorizing un-tested merges.
    for (const [tierName, points] of Object.entries(cfg.when)) {
      const evidenceGatedPoint = points.find((p) => p === "pre_audit" || p === "pre_merge");
      if (evidenceGatedPoint === undefined) continue;
      const steps = cfg.tiers[tierName] ?? [];
      const hasEvidence = steps.some((step) => step.evidence !== undefined || step.junitReport !== undefined);
      if (!hasEvidence) {
        ctx.addIssue({
          code: "custom",
          path: ["tiers", tierName],
          message:
            `tier "${tierName}" maps to "${evidenceGatedPoint}" but declares no step with positive evidence ` +
            "(every step is judged on exit code alone — the green-by-accident class). " +
            "Declare an `evidence` block (junit / artifact / stdout-count) on at least one step, " +
            "or set `junitReport` on the test step (back-compat: promotes to junit evidence with minTests: 1).",
        });
      }
    }
    // ONE REGRESSION CONTRACT PER LIFECYCLE POINT. Baseline capture resolves the FIRST
    // declaration (`regressionStepFor`) and runs THAT command once on the base tree, but the
    // tier runner judges EVERY step that declares `regression`. A second declaration would
    // therefore be judged against a baseline produced by a different command — its own tests
    // would look like they had never passed, so a green suite could read as a mass
    // regression. There is no sensible reconciliation, so the config is refused rather than
    // silently resolved to the first.
    for (const point of ["per_iteration", "pre_audit", "pre_merge"] as const) {
      const declaring: string[] = [];
      for (const [tierName, points] of Object.entries(cfg.when)) {
        if (!points.includes(point)) continue;
        for (const step of cfg.tiers[tierName] ?? []) {
          if (step.regression !== undefined) declaring.push(`${tierName}.${step.name}`);
        }
      }
      if (declaring.length > 1) {
        ctx.addIssue({
          code: "custom",
          path: ["tiers"],
          message:
            `${declaring.length} steps declare a \`regression\` contract at "${point}" ` +
            `(${declaring.join(", ")}). Exactly one is allowed: the run captures ONE baseline, from the ` +
            "first declaration's command, and judging a second step's report against it would read that " +
            "step's tests as never having passed. Merge them into one step, or move one to another " +
            "lifecycle point.",
        });
      }
    }
    // THE MERGE AUTHORITY IS NOT NEGOTIABLE: a `regression` step may never sit in a tier
    // mapped to `pre_merge`. The regression contract deliberately PASSES a step whose
    // suite is red — as long as nothing that was green went red — which is exactly right
    // inside the writer's loop and exactly wrong at the merge gate, where the bar is an
    // ABSOLUTE green suite. `.tanren/ci.yml` is repo-sourced and WRITER-EDITABLE, so a
    // writer that could not get the merge gate green has a one-line edit available that
    // makes red tests mergeable, and it reads like a reasonable config change. Refuse it
    // at config-resolve time (loud), rather than discovering it in a post-mortem.
    for (const [tierName, points] of Object.entries(cfg.when)) {
      if (!points.includes("pre_merge")) continue;
      const regressionStep = (cfg.tiers[tierName] ?? []).find((step) => step.regression !== undefined);
      if (regressionStep !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["tiers", tierName],
          message:
            `step "${regressionStep.name}" declares a \`regression\` contract but tier "${tierName}" maps to ` +
            '"pre_merge". The regression contract passes a step whose suite is RED so long as nothing ' +
            "REGRESSED — that is correct inside the writer loop and unacceptable at the merge authority, " +
            "which requires an absolute green suite. Move the regression step to a `per_iteration` tier " +
            "and keep an unscoped, absolute test step at pre_merge.",
        });
      }
    }
  });
export type CiConfigV1 = z.infer<typeof CiConfigV1>;

export const SUPPORTED_CI_CONFIG_VERSIONS: ReadonlyArray<number> = [1];
