// Requirement-Compiler Answerer output schema (in-5). Source of truth for the
// JSON Schema rendered INLINE via `renderAnswererJsonSchema` (the SAME path
// `forge/specQuality/validator.ts` uses — this schema is intentionally NOT in
// `answererSchemaCatalog`, so there is no `generated/*.json` mirror and no drift
// test entry; the runtime renderer is the single source for both the LLM and the
// parser).
//
// THE COMPILE TARGET: in-5 compiles the spec's Given/When/Then acceptance
// criteria + the project's HEAD `DesignContract` into a set of typed
// `IntegrationRequirementV1` documents (in-2's contract) the integration
// provisioner (in-8..12) consumes. This is an LLM-INTENT derivation (the deferred
// design), NEVER lexical/keyword matching.
//
// FAIL-CLOSED SHAPE (the rejected-design guard):
//   - `requirements` is an array of UNKNOWN JSON values. The LLM's shape is NEVER
//     trusted at the schema level. EVERY candidate is validated post-parse via
//     `parseIntegrationRequirement` (Zod + semantic plane/provider/effect rules)
//     inside the actor. A candidate that fails ANY rule surfaces as a typed
//     `MalformedRequirementCompilerResultError` — there is NO lexical fallback,
//     NO silent skip, NO default. This is the explicit rejection of the prior
//     "deferred — needs an LLM-intent design" note.
//   - `rationale` is REQUIRED + non-empty, even when `requirements` is empty. An
//     empty `requirements` array is a legitimate outcome (the spec needs no
//     integrations) — the rationale MUST explain why, so the empty set is
//     EXPLICIT, never a silent default.
//
// STRICT-STRUCTURED-OUTPUT COMPATIBILITY: `requirements` uses `z.unknown()` items
// deliberately. The `IntegrationRequirementV1Schema` has `.optional()` sub-fields
// (`trigger.given` / `trigger.when` / `providerPolicy.preferred` / …) that render
// as nullable under OpenAI strict mode but would NOT re-parse through the
// contract's Zod schema (`.optional()` rejects `null`). Embedding that schema
// directly would create a proof≠effect divergence (the LLM would be instructed
// to emit `null`, the contract would reject it). The unknown-items design breaks
// that cycle: the LLM emits the shape the PROMPT describes (with golden vectors),
// the actor re-validates via the FULL `parseIntegrationRequirement` path — one
// authority, one coordinate.
import { z } from "zod";

export const REQUIREMENT_COMPILER_SCHEMA_ID = "tanren.requirement_compiler_answer.v1" as const;

/**
 * The requirement-compiler answerer output. Each `requirements[]` entry is an
 * UNVALIDATED candidate the actor re-runs through `parseIntegrationRequirement`.
 * `rationale` is the non-empty human-facing narration of the compile decision
 * (why these requirements, or why none) — required even on an empty set.
 */
export const RequirementCompilerAnswer = z
  .object({
    // z.unknown() items: the contract schema is NOT embedded here (see module
    // header). The actor validates every entry post-parse; the LLM's shape is
    // never trusted at the schema level. An empty array is valid (the spec needs
    // no integrations) — `rationale` MUST then explain the empty set.
    requirements: z
      .array(z.unknown())
      .max(64)
      .describe(
        "Integration requirement candidates (IntegrationRequirementV1 shape — see the prompt for the full schema, catalog, and a golden example). Each entry is re-validated strictly; an invalid entry fails the compile. An empty array is valid when the spec needs no integrations.",
      ),
    rationale: z
      .string()
      .min(1)
      .max(8000)
      .describe(
        "The compile rationale: which acceptance criteria / design-contract intent map to which integration capabilities, OR why no integrations are needed. Required + non-empty even when `requirements` is empty (an explicit empty set, never a silent default).",
      ),
  })
  .strict();

export type RequirementCompilerAnswer = z.infer<typeof RequirementCompilerAnswer>;
