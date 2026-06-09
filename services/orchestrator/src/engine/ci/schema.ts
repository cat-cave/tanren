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
export const CiStep = z
  .object({
    name: z.string().min(1),
    run: z.string().min(1),
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
  });
export type CiConfigV1 = z.infer<typeof CiConfigV1>;

export const SUPPORTED_CI_CONFIG_VERSIONS: ReadonlyArray<number> = [1];
