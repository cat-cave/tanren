// Template-creation STEP 1 — the LIVE research seam impl (templating-system.md §2.1).
//
// `WebResearchTemplateResearcher` is the REAL `TemplateResearcher` the creation
// flow runs in production. It reasons out the CURRENT best-practice tooling +
// lifecycle for a requested stack with a real model that has WEB ACCESS, and
// records the sources it grounded the decisions on (`provenance.researchSources`).
//
// REUSE, not reinvent: the model call rides the SAME transport every other Forge
// ideation surface uses — an `AnswererAdapter<TemplateResearch>` built from the
// boot-time `ForgeAnswererInfra` via `forgeAllocatingAnswererAdapter` (allocate a
// short-lived runner → resolve the org/project LLM credential + forge routing →
// run ONE structured call → release). The runner the agent runs on can reach the
// web (WebSearch/WebFetch), so the model performs live research and returns the
// grounded decision set + the urls it consulted. There is NO deterministic
// fallback (the §8a invariant): an org with no resolvable LLM credential hard-fails
// the allocate/resolve, and an ungrounded result (no sources) fails LOUD at the
// `assertGroundedResearch` boundary the orchestration enforces.
//
// STACK-AGNOSTIC by construction: the prompt hands the model the requested
// capability brief (the `TemplateCreationRequest`) and asks it to research that
// stack; Tanren names no stack and branches on none — a never-seen stack flows
// through identically.

import { renderAnswererJsonSchema } from "../../answerers/schemas/index.js";
import {
  type ForgeAnswererInfra,
  type ForgeAnswererTarget,
  forgeAllocatingAnswererAdapter,
} from "../../forge/providerFactory.js";
import type { AnswererAdapter } from "../../providers/types.js";
import { ResearchOutput } from "./researchSchema.js";
import type { TemplateCreationRequest, TemplateResearch, TemplateResearcher } from "./research.js";

// The structured-output schema name the model emits under (mirrors the Forge
// interview/audit answerer naming convention).
const RESEARCH_SCHEMA_NAME = "tanren.template_research.v1";

// The default per-call ceiling: template research reads several web sources and
// reasons over them — the same budget the brownfield recon / audit answerers take.
const DEFAULT_RESEARCH_TIMEOUT_MS = 180_000;

export interface WrapProviderResearcherOptions {
  // Bounds the one research model call. Defaults to 180s.
  timeoutMs?: number;
}

// Render the research brief the model researches against. Capability-shaped: the
// stack label + the runtime/pkg-mgr/framework/deploy target + the full-bar
// feature asks (BDD/mutation default-on). The model is INSTRUCTED to ground every
// decision in live web sources and to return the urls it consulted — an empty
// `researchSources` is rejected downstream (the grounding gate). No stack literal
// appears here; the brief is assembled from the request fields verbatim.
export function buildResearchPrompt(request: TemplateCreationRequest): string {
  const lines: string[] = [
    "You are researching CURRENT best-practice tooling + project lifecycle for a software (or non-software) project stack so Tanren can scaffold a validated, conforming template for it.",
    "",
    "Use live web research (search + fetch authoritative, recent sources) to decide the modern, well-supported toolchain for THIS stack. Do not answer from memory alone — ground every decision in sources you consulted and RETURN their urls in researchSources (at least one; an ungrounded answer is rejected).",
    "",
    "The requested stack (treat these as an opaque brief, never assume a default stack):",
    `- stack label: ${request.stack}`,
    `- runtime: ${request.runtime}`,
    `- package/dependency manager: ${request.packageManager}`,
    ...(request.framework === undefined ? [] : [`- framework: ${request.framework}`]),
    ...(request.deployTarget === undefined ? [] : [`- deploy target: ${request.deployTarget}`]),
    `- behavior-driven specs (BDD) wanted: ${String(request.bdd ?? true)}`,
    `- mutation testing wanted: ${String(request.mutation ?? true)}`,
    ...(request.note === undefined || request.note.trim() === "" ? [] : [`- operator note: ${request.note}`]),
    "",
    "Decide the concrete `just`-target lifecycle commands for this stack (bootstrap / tier1 / tier2 / tier3 / build / deploy), filling each with the ACTUAL command(s) for the researched toolchain. tier1 is the fast format+lint+typecheck gate, tier2 the test gate, tier3 the pre-merge/e2e gate.",
    "Decide which full-bar gates this stack supports (typecheck / lint / test / mutation / junit / bdd) — only mark a gate present if the researched toolchain genuinely provides it (a gate that is green-by-accident must NOT be claimed). When mutation is present, give the concrete mutation command in mutationStep.",
    "Summarize the rationale (the chosen tooling + why) in `summary`.",
  ];
  return lines.join("\n");
}

// Adapt an `AnswererAdapter<ResearchOutput>` into the `TemplateResearcher` seam.
// One structured model call per `research(request)`. The adapter is the Forge
// allocating adapter in production (a real LLM with web access on an allocated
// runner); tests inject a fake adapter to exercise the wrapping without a model.
export function wrapProviderResearcher(
  adapter: AnswererAdapter<ResearchOutput>,
  options: WrapProviderResearcherOptions = {},
): TemplateResearcher {
  const jsonSchema = renderAnswererJsonSchema(ResearchOutput);
  return {
    async research(request: TemplateCreationRequest): Promise<TemplateResearch> {
      const output = await adapter.runAnswerer({
        prompt: buildResearchPrompt(request),
        timeoutMs: options.timeoutMs ?? DEFAULT_RESEARCH_TIMEOUT_MS,
        outputSchema: {
          name: RESEARCH_SCHEMA_NAME,
          jsonSchema,
          parse: (value) => ResearchOutput.parse(value),
        },
      });
      return researchFromOutput(output);
    },
  };
}

// Map the model's structured output onto the `TemplateResearch` the orchestration
// consumes. `mutationStep` is carried ONLY when the model declared a mutation gate
// (so the manifest/negative-control wiring stays 1:1 with the declared
// capabilities). The grounding (≥1 source) is asserted at the orchestration
// boundary (`assertGroundedResearch`), not silently defaulted here.
function researchFromOutput(output: ResearchOutput): TemplateResearch {
  return {
    researchSources: [...output.researchSources],
    lifecycle: { ...output.lifecycle },
    tooling: {
      typecheck: output.tooling.typecheck,
      lint: output.tooling.lint,
      test: output.tooling.test,
      mutation: output.tooling.mutation,
      junit: output.tooling.junit,
      bdd: output.tooling.bdd,
      ...(output.tooling.mutation && output.tooling.mutationStep !== undefined
        ? { mutationStep: output.tooling.mutationStep }
        : {}),
    },
    summary: output.summary,
  };
}

// Build the PRODUCTION researcher from the boot-time Forge infra + the target the
// research runs under (the org creating the template — `projectId` absent, exactly
// like the greenfield interview, so credentials resolve from the org defaults).
// This is the single construction site `createTemplateFlow` wires.
export function buildTemplateResearcher(
  infra: ForgeAnswererInfra,
  target: ForgeAnswererTarget,
  options: WrapProviderResearcherOptions = {},
): TemplateResearcher {
  return wrapProviderResearcher(forgeAllocatingAnswererAdapter<ResearchOutput>(infra, target), options);
}
