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

// A single named shell command within a tier. `run` is an opaque shell string
// executed verbatim by the consumer; this module does not parse or validate
// shell syntax.
//
// `junitReport` is the EXPLICIT CI-config contract for the CI-intelligence per-test
// grain: a step that runs tests DECLARES the workspace-relative path it writes its
// JUnit report to (e.g. `reports/junit.xml`). Tanren's native gate reads back EXACTLY
// that declared path after the step runs and ingests the per-test rows
// (flaky→quarantine→root-cause). This is a DECLARED field, never a command-string
// sniff: a step is "junit-producing" iff it sets `junitReport`, so the writer's
// actual test command (`just tier-2`, which does NOT mention the path) is recognized.
// STACK-AGNOSTIC: the path is the project's declaration — Tanren names no test runner,
// only honors the path the project says it emits. Absent ⇒ the step produces no grain
// (the clean no-op skip); present-but-absent-after-run ⇒ a LOUD `ci.junit_missing`.
export const CiStep = z
  .object({
    name: z.string().min(1),
    run: z.string().min(1),
    junitReport: z.string().min(1).optional(),
  })
  .strict();
export type CiStep = z.infer<typeof CiStep>;

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
  });
export type CiConfigV1 = z.infer<typeof CiConfigV1>;

export const SUPPORTED_CI_CONFIG_VERSIONS: ReadonlyArray<number> = [1];
