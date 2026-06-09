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

// The six conventional `just`-target lifecycle commands the model decides for the
// stack — each the ACTUAL command(s) for the researched toolchain. Non-empty so a
// silent blank lifecycle (which would materialize an empty justfile target) is a
// LOUD parse failure, never a quiet no-op gate.
export const ResearchedLifecycleOutput = z
  .object({
    bootstrap: z.string().min(1).max(2000),
    tier1: z.string().min(1).max(2000),
    tier2: z.string().min(1).max(2000),
    tier3: z.string().min(1).max(2000),
    build: z.string().min(1).max(2000),
    deploy: z.string().min(1).max(2000),
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
