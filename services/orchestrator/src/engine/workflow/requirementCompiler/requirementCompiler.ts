// in-5: the requirement-compiler ACTOR — the LLM-intent derivation that compiles a
// spec's Given/When/Then acceptance criteria + the project's HEAD DesignContract
// into a typed `IntegrationRequirementV1` set (in-2's contract) the integration
// provisioner (in-8..12) consumes.
//
// THE REJECTED DESIGN (lexical matching) is gone. The deferred note said "needs
// an LLM-intent design, not lexical matching" — this module IS that design. The
// compile is an LLM-actor call that reasons over the G/W/T + design intent and
// emits typed requirement candidates; the actor then RE-VALIDATES every candidate
// via the FULL `parseIntegrationRequirement` path (Zod + semantic plane/provider/
// effect rules). A malformed candidate is a typed `MalformedRequirementCompilerResultError`
// — NEVER a silent skip, NEVER a lexical fallback, NEVER a default. The empty set
// (spec needs no integrations) is an EXPLICIT outcome the LLM must justify with a
// non-empty rationale.
//
// CANONICAL LLM-ACTOR SHAPE (mirrors `designOracle.ts` / the specQuality validator):
//   - a typed error class (`MalformedRequirementCompilerResultError`) for the
//     fail-loud-on-malformed arm — a malformed LLM result HALTS the compile;
//   - a pure `invokeRequirementCompiler(adapter, input)` that builds the prompt,
//     calls `adapter.runAnswerer`, and re-validates every candidate;
//   - a `createRequirementCompilerActor(adapter)` wrapper that adapts the raw
//     `AnswererAdapter<RequirementCompilerAnswer>` into a `RequirementCompilerActor`
//     seam the route consumes (the specQuality-validator pattern).
//
// FAKE-MASKS-PROD guard: the actor is pure — it does NOT own the adapter
// construction. Production builds the adapter via `forgeAllocatingAnswererAdapter`
// (the allocating Forge factory, same infra every Forge surface uses); tests inject
// a fake adapter that PASSES THROUGH the real `outputSchema.parse` so the prod
// parse path is exercised (the designOracle-stage test discipline). The route test
// verifies the REAL prod wiring (route → `forgeAllocatingAnswererAdapter` → this
// actor → `parseIntegrationRequirement` → store).

import type { AnswererAdapter, AnswererRunOptions } from "../../providers/types.js";
import { renderAnswererJsonSchema } from "../../answerers/schemas/index.js";
import {
  REQUIREMENT_COMPILER_SCHEMA_ID,
  RequirementCompilerAnswer,
  type RequirementCompilerAnswer as RequirementCompilerAnswerType,
} from "../../answerers/schemas/requirementCompiler.js";
import {
  parseIntegrationRequirement,
  integrationRequirementDigest,
  type IntegrationRequirementV1,
} from "../../contracts/integrationRequirement.js";
import type { DesignContractV1 } from "../../design/designContract.js";
import { buildRequirementCompilerPrompt, type RequirementCompilerPromptInput } from "./requirementCompilerPrompt.js";

/**
 * The compile FAILED because the LLM returned a candidate that does not satisfy
 * the IntegrationRequirementV1 contract (schema OR semantic rules). The prior
 * design (deferred) would have silently coerced / lexically matched; this typed
 * error is the EXPLICIT rejection of that path — a malformed result HALTS the
 * compile, surfaces on the route response (502), and carries the per-candidate
 * validation issues so the operator sees WHICH field(s) were wrong. Mirrors
 * `MalformedDesignOracleResultError` (PR #745) and `MalformedBindingContractError`
 * (in-15): a typed fail-loud class, never the fail-closed `crashed` default.
 */
export class MalformedRequirementCompilerResultError extends Error {
  constructor(
    /** The project the compile ran against. */
    readonly projectId: string,
    /** The spec whose acceptance criteria were being compiled. */
    readonly specId: string,
    /** The per-candidate validation detail (which entry, which fields, which codes). */
    readonly detail: string,
  ) {
    super(
      `requirement compiler: spec '${specId}' (project '${projectId}') produced a malformed result — ${detail}. ` +
        "The LLM-compile output failed `parseIntegrationRequirement` (schema + semantic plane/provider/effect rules). " +
        "There is NO lexical fallback (the rejected design) and NO silent skip: a malformed result halts the compile so " +
        "the operator sees the regression rather than persisting a requirement that violates the integration contract.",
    );
    this.name = "MalformedRequirementCompilerResultError";
  }
}

/** The spec + design-contract context the compiler reasons over. */
export interface RequirementCompilerInput {
  readonly projectId: string;
  readonly specId: string;
  readonly specTitle: string;
  readonly specDescription: string;
  readonly acceptanceCriteria: readonly string[];
  readonly designContract: DesignContractV1;
  readonly designContractVersion: number;
  /** The contract row id (the `source_revision_id` for persisted requirements). */
  readonly designContractId: string;
}

/** A validated compile result — the requirements + the LLM's rationale. */
export interface RequirementCompilerResult {
  readonly requirements: readonly IntegrationRequirementV1[];
  readonly rationale: string;
  /** Per-requirement digest (precomputed for the store; proves effect coordinate). */
  readonly digests: readonly string[];
}

/** The actor seam the route consumes (mirrors the specQuality-validator shape). */
export interface RequirementCompilerActor {
  compile(input: RequirementCompilerInput): Promise<RequirementCompilerResult>;
}

/** The output-schema (rendered inline via `renderAnswererJsonSchema` — the specQuality path). */
function buildOutputSchema(): AnswererRunOptions<RequirementCompilerAnswerType>["outputSchema"] {
  return {
    name: REQUIREMENT_COMPILER_SCHEMA_ID,
    jsonSchema: renderAnswererJsonSchema(RequirementCompilerAnswer),
    parse: (value: unknown) => RequirementCompilerAnswer.parse(value),
  };
}

/**
 * Validate the LLM's answer: re-run EVERY candidate through the FULL
 * `parseIntegrationRequirement` path (Zod + semantic plane/provider/effect rules).
 * A candidate that fails ANY rule throws `MalformedRequirementCompilerResultError`
 * — the typed fail-loud arm. The empty set is valid (the LLM justified it with a
 * non-empty rationale); an ALL-PASS set returns the validated requirements +
 * their canonical digests.
 *
 * PROOF = EFFECT: the validated `IntegrationRequirementV1` returned here is the
 * EXACT object the store persists (same reference, same canonical-body digest).
 * There is no "validate one shape, persist another" divergence — the actor is the
 * single authority between the LLM and the store.
 */
export function validateCompiledRequirements(
  answer: RequirementCompilerAnswerType,
  context: { projectId: string; specId: string },
): RequirementCompilerResult {
  const validated: IntegrationRequirementV1[] = [];
  const digests: string[] = [];
  for (let i = 0; i < answer.requirements.length; i++) {
    const candidate = answer.requirements[i];
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      // Trap #5 (coercion/blank-slip) + #10 (unchecked cast): a non-object entry
      // MUST NOT slip through as a defaulted/empty requirement. Fail loud.
      throw new MalformedRequirementCompilerResultError(
        context.projectId,
        context.specId,
        `requirements[${i}] is not a JSON object (got ${Array.isArray(candidate) ? "array" : typeof candidate}) — the LLM emitted a malformed entry`,
      );
    }
    const result = parseIntegrationRequirement(candidate);
    if (!result.ok) {
      throw new MalformedRequirementCompilerResultError(
        context.projectId,
        context.specId,
        `requirements[${i}] failed validation: ${result.issues
          .map((issue) => `${issue.path} [${issue.code}]: ${issue.message}`)
          .join("; ")}`,
      );
    }
    validated.push(result.requirement);
    digests.push(integrationRequirementDigest(result.requirement));
  }
  return { requirements: validated, rationale: answer.rationale, digests };
}

/**
 * Pure actor entrypoint — builds the prompt, invokes the answerer, re-validates
 * every candidate. The adapter is CALLER-SUPPLIED so tests inject a fake that
 * passes through `outputSchema.parse` (exercising the real parse path) while
 * production wires `forgeAllocatingAnswererAdapter` via `createRequirementCompilerActor`.
 *
 * Fail-closed: a malformed answer throws `MalformedRequirementCompilerResultError`.
 * There is NO lexical fallback and NO silent skip — the compile HALTS on the first
 * candidate that fails `parseIntegrationRequirement`.
 */
export async function invokeRequirementCompiler(
  adapter: AnswererAdapter<RequirementCompilerAnswerType>,
  input: RequirementCompilerInput,
): Promise<RequirementCompilerResult> {
  const promptInput: RequirementCompilerPromptInput = {
    specTitle: input.specTitle,
    specDescription: input.specDescription,
    acceptanceCriteria: input.acceptanceCriteria,
    designContract: input.designContract,
    designContractVersion: input.designContractVersion,
  };
  const prompt = buildRequirementCompilerPrompt(promptInput);
  const answer = await adapter.runAnswerer({ prompt, outputSchema: buildOutputSchema() });
  return validateCompiledRequirements(answer, {
    projectId: input.projectId,
    specId: input.specId,
  });
}

/**
 * Adapt a raw `AnswererAdapter<RequirementCompilerAnswer>` into the
 * `RequirementCompilerActor` seam the route consumes. Production builds the
 * adapter via `forgeAllocatingAnswererAdapter<RequirementCompilerAnswer>(infra, target)`
 * (the allocating Forge factory — same infra every Forge surface uses); tests
 * inject a fake adapter directly. The wrapper renders the JSON Schema INLINE via
 * `renderAnswererJsonSchema` (the specQuality path — NOT in `answererSchemaCatalog`,
 * no `generated/*.json` mirror).
 */
export function createRequirementCompilerActor(
  adapter: AnswererAdapter<RequirementCompilerAnswerType>,
): RequirementCompilerActor {
  return {
    compile: (input) => invokeRequirementCompiler(adapter, input),
  };
}
