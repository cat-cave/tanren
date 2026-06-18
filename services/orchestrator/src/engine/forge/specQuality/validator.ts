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
  SPEC_QUALITY_OUTPUT_INSTRUCTIONS,
  SPEC_REVISION_ANSWER_SCHEMA_ID,
  SPEC_REVISION_OUTPUT_INSTRUCTIONS,
  type SpecAudience,
  SpecQualityAnswer,
  specQualityContractPrompt,
  SpecRevisionAnswer,
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
  // The LEGIBILITY audience the spec is judged against (specQuality.ts `SpecAudience`).
  // Absent ⇒ `product` (the strict plain-product-language bar for a user-facing spec).
  // A TEMPLATE-CREATION build's internal/infrastructure specs carry `technical`, so
  // legitimate domain vocabulary (scaffold / gates / mutation / manifest) is NOT
  // rejected as jargon — a category error no revision could satisfy.
  audience?: SpecAudience;
}

// Resolve the spec's effective audience — `product` is the default (the strict bar).
function audienceOf(spec: CandidateSpec): SpecAudience {
  return spec.audience ?? "product";
}

// The validator seam — mirrors the discovery/triage answerer shape so the route
// wires a real provider answerer and tests inject a fake. `reAuthor` is the gate's
// BUILT-IN re-author: when no emitter-specific revise callback is wired, the stage
// uses this to genuinely ATTEMPT guided re-authoring (the validator's own provider
// rewrites the spec from its guidance) BEFORE any escalation — so a spec is never
// abandoned "after 0 revision(s)". Optional so a pure-validate test fake need not
// implement it (then the gate falls back to the emitter callback, else strict).
export interface SpecQualityAnswerer {
  validate(spec: CandidateSpec): Promise<SpecQualityAnswer>;
  reAuthor?(spec: CandidateSpec, guidance: string): Promise<CandidateSpec>;
}

// buildSpecQualityPrompt renders the read-only validation prompt: the contract
// (single-sourced from specQuality.ts, rendered for the spec's audience), the
// candidate spec, and the strict output instruction. Exported for the prompt-shape test.
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
    specQualityContractPrompt(audienceOf(spec)),
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

// buildSpecRevisionPrompt renders the RE-AUTHOR prompt: the contract (for the spec's
// audience), the failing spec, the validator's guidance, and the strict output
// instruction. The model returns a revised spec addressing the guidance. Exported for
// the prompt-shape test.
export function buildSpecRevisionPrompt(spec: CandidateSpec, guidance: string): string {
  const criteria =
    spec.acceptanceCriteria.length === 0
      ? ["(none provided)"]
      : spec.acceptanceCriteria.map((criterion) => `- ${criterion}`);
  return [
    "You are the Tanren Spec Re-Author. The spec below FAILED the spec-quality gate.",
    "Re-author it so it satisfies the contract, addressing the validator's guidance",
    "while preserving the spec's original intent and scope.",
    "",
    specQualityContractPrompt(audienceOf(spec)),
    "",
    "The spec to re-author:",
    `Title: ${spec.title}`,
    `Description: ${spec.description}`,
    "Acceptance criteria:",
    ...criteria,
    "",
    `Validator guidance to address: ${guidance}`,
    "",
    ...SPEC_REVISION_OUTPUT_INSTRUCTIONS,
  ].join("\n");
}

// No bounding option remains: each provider answerer call is governed by the agent
// ActivityWatchdog (output-driven, never a wall-clock kill) the adapter constructs.
export type WrapProviderSpecQualityAnswererOptions = Record<never, never>;

// Adapt an `AnswererAdapter` into the `SpecQualityAnswerer` seam. The strict
// `SpecQualityAnswer` parse on the output makes a malformed answer THROW (loud). The
// SAME adapter (one provider call per invocation) backs both the validate and the
// built-in re-author, so the gate genuinely re-authors before any escalation.
export function wrapProviderSpecQualityAnswerer(
  adapter: AnswererAdapter<SpecQualityAnswer>,
  reAuthorAdapter: AnswererAdapter<SpecRevisionAnswer>,
  _options: WrapProviderSpecQualityAnswererOptions = {},
): SpecQualityAnswerer {
  const jsonSchema = renderAnswererJsonSchema(SpecQualityAnswer);
  const revisionJsonSchema = renderAnswererJsonSchema(SpecRevisionAnswer);
  return {
    async validate(spec: CandidateSpec): Promise<SpecQualityAnswer> {
      return adapter.runAnswerer({
        prompt: buildSpecQualityPrompt(spec),
        outputSchema: {
          name: SPEC_QUALITY_ANSWER_SCHEMA_ID,
          jsonSchema,
          parse: (value) => SpecQualityAnswer.parse(value),
        },
      });
    },
    async reAuthor(spec: CandidateSpec, guidance: string): Promise<CandidateSpec> {
      const revised = await reAuthorAdapter.runAnswerer({
        prompt: buildSpecRevisionPrompt(spec, guidance),
        outputSchema: {
          name: SPEC_REVISION_ANSWER_SCHEMA_ID,
          jsonSchema: revisionJsonSchema,
          parse: (value) => SpecRevisionAnswer.parse(value),
        },
      });
      // Carry the original audience onto the revised spec so re-validation judges it
      // against the SAME (audience-correct) bar.
      return {
        title: revised.title,
        description: revised.description,
        acceptanceCriteria: revised.acceptanceCriteria,
        ...(spec.audience !== undefined && { audience: spec.audience }),
      };
    },
  };
}
