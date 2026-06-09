// Template-creation STEP 1 — RESEARCH (docs/roadmap/templating-system.md §2.1).
//
// Before Tanren builds a template for a stack it does not yet have, it
// web-researches the CURRENT best practice + modern tooling for that stack and
// records the sources. The research produces two durable things:
//   1. `researchSources` — the urls/references the decisions are grounded on,
//      persisted into the template manifest's `provenance.researchSources` (the
//      "this template is grounded, not hand-waved" evidence).
//   2. The TOOLING/FEATURE decisions — the capabilities the template will bake
//      (formatter/linter/typechecker/test/BDD/mutation/JUnit) AND the concrete
//      lifecycle commands (`just bootstrap/tier-1/2/3/build/deploy`) for the
//      stack. These drive spec authoring (step 2) and the manifest capabilities.
//
// STACK-AGNOSTIC by construction: the researcher is a SEAM, not a hardcoded
// per-stack table. The real implementation runs live web searches/fetches (the
// orchestrator can reach WebSearch/WebFetch) and reasons out the tooling for ANY
// stack — including a never-seen one. Tests inject a stub researcher that returns
// a fixed decision set, so the creation orchestration is exercised without a live
// LLM/web call. Tanren's own TypeScript names NO stack here.

import type { TemplateChannel } from "../manifest.js";

// What the operator (or the no-match selection hook) asks Tanren to create a
// template FOR. A capability-shaped request — NOT a stack switch Tanren branches
// on; the researcher reads it as the brief for what to research. The fields are
// the same capability vocabulary selection queries by, so a no-match query maps
// straight onto a creation request.
export interface TemplateCreationRequest {
  // The human stack label the operator named ("ts-pnpm-next", "rust-axum",
  // "novel-ru-en"). Descriptive — the researcher uses it as the brief, Tanren
  // never branches on it.
  stack: string;
  // The runtime the template should target ("node", "cargo", "python", "prose").
  runtime: string;
  // The package/dependency manager ("pnpm", "uv", "cargo").
  packageManager: string;
  // The application framework, when the stack has one ("next", "axum").
  framework?: string;
  // The deploy target the template's `just deploy` should wire ("vercel",
  // "flyio", "hetzner"). Absent ⇒ the template ships no deploy hook.
  deployTarget?: string;
  // Whether the template must bake behavior-driven specs (the BDD feature set).
  // Defaults true (the full-bar doctrine) — the request can opt out for a stack
  // with no BDD concept.
  bdd?: boolean;
  // Whether the template must bake mutation testing. Defaults true (full bar).
  mutation?: boolean;
  // The maintenance channel the created template tracks. Defaults `lts` (nightly
  // is a later maintenance concern — templating-system.md §4).
  channel?: TemplateChannel;
  // A free-form note from the operator (extra constraints / context the
  // researcher should honor). Optional.
  note?: string;
}

// The concrete lifecycle commands the research decided for the stack — the six
// conventional `just` targets, each holding the ACTUAL stack command(s). This is
// the load-bearing output that becomes the template-build project's lifecycle
// (the run materializes the justfile + `.tanren/ci.yml` from it deterministically,
// per the stack-flexible contract). General enough for any stack: a Rust template
// fills `tier1` with "cargo clippy", a novel translation with "aspell".
export interface ResearchedLifecycle {
  bootstrap: string;
  tier1: string;
  tier2: string;
  tier3: string;
  build: string;
  deploy: string;
}

// The tooling/feature decisions the research produced for the stack — which parts
// of the full-bar feature set the template bakes. Maps onto the manifest
// capabilities + drives which negative controls the validation harness runs.
export interface ResearchedTooling {
  // Whether a real typecheck gate is part of the stack (most compiled/typed
  // stacks; a prose stack may have none). When false, the typecheck negative
  // control is `n/a`.
  typecheck: boolean;
  // Whether a lint gate is part of the stack.
  lint: boolean;
  // Whether a test gate is part of the stack.
  test: boolean;
  // Whether a mutation gate is baked (a real mutation command). When true, the
  // mutation negative control runs and must KILL the seeded mutant.
  mutation: boolean;
  // Whether a test tier emits a machine-readable JUnit report.
  junit: boolean;
  // Whether the template bakes behavior-driven specs.
  bdd: boolean;
  // The mutation command (`just mutation` or the stack's equivalent), present
  // ONLY when `mutation` is true. Absent ⇒ mutation control is `n/a`.
  mutationStep?: string;
}

// The full research result: the grounded sources, the tooling decisions, and the
// concrete lifecycle. Produced by step 1, consumed by step 2 (spec authoring) +
// the manifest builder (capabilities + provenance).
export interface TemplateResearch {
  // The research sources (urls/references) the decisions are grounded on. At
  // least one — provenance requires it (a template with no grounding cannot be
  // published). A LOUD failure when the researcher returns none.
  researchSources: ReadonlyArray<string>;
  // The decided lifecycle commands for the stack.
  lifecycle: ResearchedLifecycle;
  // The decided tooling/feature set.
  tooling: ResearchedTooling;
  // A human-readable summary of what the research concluded (the rationale the
  // spec set + the operator can read). Carried into the scaffold spec brief.
  summary: string;
}

// The RESEARCH SEAM. The real implementation runs live web searches/fetches +
// reasons out the tooling for the requested stack; tests inject a stub. A throw
// is a LOUD failure (the creation flow cannot proceed without grounded research) —
// never a silent default-to-a-stack.
export interface TemplateResearcher {
  research(request: TemplateCreationRequest): Promise<TemplateResearch>;
}

// Thrown when research returned NO sources — provenance requires at least one, so
// an ungrounded research result cannot proceed to a build (a published template
// must be grounded, not hand-waved). LOUD, never a silent empty-provenance.
export class UngroundedResearchError extends Error {
  // Named `requestedStack` (not `stack`) so it does not shadow `Error.stack`.
  readonly requestedStack: string;
  constructor(stack: string) {
    super(`template research for "${stack}" returned no sources — cannot build an ungrounded template`);
    this.name = "UngroundedResearchError";
    this.requestedStack = stack;
  }
}

// Assert the research is grounded (at least one source). Called at the boundary
// between research and the build so an ungrounded result fails LOUDLY here rather
// than producing a template with empty provenance the manifest parser would
// reject downstream (provenance.researchSources is min(1)).
export function assertGroundedResearch(research: TemplateResearch, stack: string): void {
  if (research.researchSources.length === 0) {
    throw new UngroundedResearchError(stack);
  }
}
