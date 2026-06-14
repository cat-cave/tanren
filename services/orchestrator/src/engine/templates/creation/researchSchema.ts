// The STRUCTURED-OUTPUT schema the live template researcher (liveResearch.ts) makes
// the model emit (templating-system.md §2.1). It mirrors the `TemplateResearch`
// shape the orchestration consumes, but as a zod schema renderable to the
// JSON-schema the answerer adapter constrains the model to — the same pattern the
// Forge interview/audit answerers use.
//
// Kept in its own module so `research.ts` stays a pure types/seam file and the
// schema can be rendered (`renderAnswererJsonSchema`) without dragging zod into
// every research import site. The lifecycle/tooling fields are 1:1 with
// `ResearchedLifecycle` / `ResearchedTooling`.

import { z } from "zod";

import { CaptureToolchain } from "../../forge/interview/types.js";

// The six conventional `just`-target lifecycle commands the model decides for the
// stack — each the ACTUAL command(s) for the researched toolchain. Non-empty so a
// silent blank lifecycle (which would materialize an empty justfile target) is a
// LOUD parse failure, never a quiet no-op gate.
//
// `toolchain` (environment-management.md §3 Layer 1) — the LIST of {name, version}
// entries the researched stack needs, at CURRENT/LTS versions. The model MUST populate
// it for any stack mise can provision (node/pnpm/python/go/rust/…), so the
// template-build project's lifecycle gets a NON-EMPTY `toolchain`, the scaffold
// materializes a `mise.toml`, and `mise install` provisions the toolchain BEFORE
// `just bootstrap` runs — without it, bootstrap fails (`pnpm: not found`) because the
// runner ships no project toolchain. Reuses the same stack-agnostic `CaptureToolchain`
// array the interview architecture step emits (mise-safe `name`, bounded `version`) —
// Tanren names NO tool/version, the model researches them. Optional ONLY for a stack
// with no mise tool (a pure-shell/system-package stack that provisions inside its own
// bootstrap shell); absent/empty ⇒ no `mise.toml`. The orchestration mapping carries it
// onto `CaptureLifecycle.toolchain` (`liveResearch.ts` `researchFromOutput`).
//
// `upgrade` (environment-management.md §4.5/§7 P1) — the project's `upgrade` verb: the
// SINGLE command that bumps BOTH the toolchain (the mise pins) AND the dependencies to
// latest. Optional (a stack with literally nothing to upgrade omits it ⇒ a loud STUB
// target + a loud creation-time skip). Carried onto `ResearchedLifecycle.upgrade` by the
// orchestration mapping; the COMMAND is the project's own (Tanren names no bump command).
export const ResearchedLifecycleOutput = z
  .object({
    bootstrap: z.string().min(1).max(2000),
    tier1: z.string().min(1).max(2000),
    tier2: z.string().min(1).max(2000),
    tier3: z.string().min(1).max(2000),
    build: z.string().min(1).max(2000),
    deploy: z.string().min(1).max(2000),
    upgrade: z.string().min(1).max(2000).optional(),
    toolchain: CaptureToolchain.optional(),
  })
  .strict();
export type ResearchedLifecycleOutput = z.infer<typeof ResearchedLifecycleOutput>;

// The tooling/feature decisions: which full-bar gates the researched toolchain
// genuinely supports. `mutationStep` is the concrete mutation command, present
// only when `mutation` is true (validated by the orchestration mapping).
export const ResearchedToolingOutput = z
  .object({
    typecheck: z.boolean(),
    lint: z.boolean(),
    test: z.boolean(),
    mutation: z.boolean(),
    junit: z.boolean(),
    bdd: z.boolean(),
    mutationStep: z.string().min(1).max(2000).optional(),
  })
  .strict();
export type ResearchedToolingOutput = z.infer<typeof ResearchedToolingOutput>;

// The full structured research result the model returns. `researchSources` is
// min(0) here (the model can return none) so the GROUNDING gate
// (`assertGroundedResearch`) — not the parser — produces the LOUD failure with the
// stack-named `UngroundedResearchError`; a parser-level min(1) would mask that as a
// generic schema error.
export const ResearchOutput = z
  .object({
    researchSources: z.array(z.string().min(1).max(2000)).default([]),
    lifecycle: ResearchedLifecycleOutput,
    tooling: ResearchedToolingOutput,
    summary: z.string().min(1).max(4000),
  })
  .strict();
export type ResearchOutput = z.infer<typeof ResearchOutput>;
