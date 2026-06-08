// The spec-VALIDATION answerer — workstream 1 of the spec-loop redesign.
//
// A read-only answerer that GATES spec emission: every spec an emitting agent
// produces (derive roadmap-crafter, issue-triage, discovery, the loop's TRIAGE) is
// judged against the four-part spec-quality contract (specQuality.ts) BEFORE it
// lands in the DAG. A spec that fails is NOT silently accepted — it is looped back
// to its emitter with the `revisionGuidance`, bounded; a persistently-invalid spec
// surfaces LOUD (a needs_attention escalation), never a quiet pass.
//
// Fail-closed: the answerer's output is parsed by the strict `SpecQualityAnswer`
// Zod schema, so a malformed answer THROWS (loud, never a default pass). The stage
// (`validateEmittedSpecs` below) treats any error — an unvalidatable spec or an
// exhausted revision budget — as an escalation, not an accept.
//
// Like the inbox-triage answerer, this renders its JSON Schema inline via
// `renderAnswererJsonSchema` (it is intentionally NOT in `answererSchemaCatalog`),
// so the LLM and the runtime parser see the same OpenAI-strict shape.

import { renderAnswererJsonSchema } from "../../answerers/schemas/index.js";
import {
  SPEC_QUALITY_ANSWER_SCHEMA_ID,
  SPEC_QUALITY_CONTRACT_PROMPT,
  SPEC_QUALITY_OUTPUT_INSTRUCTIONS,
  SpecQualityAnswer,
} from "../../answerers/schemas/specQuality.js";
import type { AnswererAdapter } from "../../providers/types.js";

// The candidate spec a spec-emitter produced, in the shape the validator judges.
// Deliberately the minimal slice every emitter already has — title, description,
// and the acceptance criteria (the demo-able surface). The validator never needs
// ids/dependencies; it judges the AUTHORED CONTENT against the contract.
export interface CandidateSpec {
  title: string;
  description: string;
  acceptanceCriteria: ReadonlyArray<string>;
}

// The validator seam — mirrors the discovery/triage answerer shape so the route
// wires a real provider answerer and tests inject a fake.
export interface SpecQualityAnswerer {
  validate(spec: CandidateSpec): Promise<SpecQualityAnswer>;
}

// buildSpecQualityPrompt renders the read-only validation prompt: the contract
// (single-sourced from specQuality.ts), the candidate spec, and the strict output
// instruction. Exported for the prompt-shape test.
export function buildSpecQualityPrompt(spec: CandidateSpec): string {
  const criteria =
    spec.acceptanceCriteria.length === 0
      ? ["(none provided)"]
      : spec.acceptanceCriteria.map((criterion) => `- ${criterion}`);
  return [
    "You are the Tanren Spec-Quality Validator. Judge whether the spec below is fit",
    "to enter the build DAG. You are READ-ONLY: do not edit files, run commands, or",
    "write anything — only judge and explain.",
    "",
    SPEC_QUALITY_CONTRACT_PROMPT,
    "",
    "The spec to judge:",
    `Title: ${spec.title}`,
    `Description: ${spec.description}`,
    "Acceptance criteria:",
    ...criteria,
    "",
    ...SPEC_QUALITY_OUTPUT_INSTRUCTIONS,
  ].join("\n");
}

export interface WrapProviderSpecQualityAnswererOptions {
  // Bounds each provider call. Defaults to 120s — validation is interactive.
  timeoutMs?: number;
}

// Adapt an `AnswererAdapter` into the `SpecQualityAnswerer` seam. The strict
// `SpecQualityAnswer` parse on the output makes a malformed answer THROW (loud).
export function wrapProviderSpecQualityAnswerer(
  adapter: AnswererAdapter<SpecQualityAnswer>,
  options: WrapProviderSpecQualityAnswererOptions = {},
): SpecQualityAnswerer {
  const jsonSchema = renderAnswererJsonSchema(SpecQualityAnswer);
  return {
    async validate(spec: CandidateSpec): Promise<SpecQualityAnswer> {
      return adapter.runAnswerer({
        prompt: buildSpecQualityPrompt(spec),
        timeoutMs: options.timeoutMs ?? 120_000,
        outputSchema: {
          name: SPEC_QUALITY_ANSWER_SCHEMA_ID,
          jsonSchema,
          parse: (value) => SpecQualityAnswer.parse(value),
        },
      });
    },
  };
}
