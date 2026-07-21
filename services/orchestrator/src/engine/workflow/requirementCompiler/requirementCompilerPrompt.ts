// cspell:ignore AKIA
// in-5: the requirement-compiler PROMPT builder. Pure function — takes the spec's
// Given/When/Then acceptance criteria + the project's HEAD `DesignContract` and
// produces the LLM prompt that directs the compile. The prompt is the SOLE source
// of structural guidance for the requirement shape (the answerer schema uses
// `z.unknown()` items by design — see `requirementCompiler.ts` header); the actor
// re-validates every candidate via `parseIntegrationRequirement`, so the prompt
// and the validator see the SAME authority (no proof≠effect divergence).
//
// The prompt carries:
//   - the spec title/description + its acceptance criteria (the G/W/T input)
//   - the DesignContract domain/identity/intent/principles/constraints (the intent)
//   - the FULL IntegrationRequirementV1 field-by-field schema description
//   - the integration catalog (capabilities, planes, directions, environments,
//     criticalities, binding kinds — so the LLM emits catalog-consistent values)
//   - ONE golden vector (the product-messaging example — a complete, valid
//     requirement the LLM can mirror structurally)
//   - the output contract (the `requirements[]` + `rationale` shape, the
//     fail-closed-on-malformed guarantee, the "empty set is valid" rule)
//
// Domain-general: the prompt reasons over the G/W/T + DesignContract, never any
// product-specific hardcode. Tanren never branches on the domain in code; the
// prompt lets the LLM choose the integration capabilities the spec's acceptance
// criteria IMPLY (messaging/deploy/errors/auth/…).

import {
  INTEGRATION_CRITICALITIES,
  INTEGRATION_DIRECTIONS,
  INTEGRATION_ENVIRONMENTS,
  INTEGRATION_PLANES,
  CONTROL_CAPABILITIES,
  PRODUCT_CAPABILITIES,
  integrationContractCatalog,
  goldenProductMessagingRequirement,
} from "../../contracts/integrationRequirement.js";
import type { DesignContractV1 } from "../../design/designContract.js";

/** The spec + design-contract context the prompt is built from. */
export interface RequirementCompilerPromptInput {
  readonly specTitle: string;
  readonly specDescription: string;
  readonly acceptanceCriteria: readonly string[];
  readonly designContract: DesignContractV1;
  readonly designContractVersion: number;
}

/**
 * Build the requirement-compiler LLM prompt. The prompt is a self-contained
 * directive: it describes the task, the input context, the requirement schema, the
 * catalog, a golden example, and the output contract. The LLM returns
 * `{ requirements: [...], rationale: "..." }`; the actor validates each entry.
 */
export function buildRequirementCompilerPrompt(input: RequirementCompilerPromptInput): string {
  const catalog = integrationContractCatalog();
  const golden = goldenProductMessagingRequirement();

  const criteriaBlock =
    input.acceptanceCriteria.length === 0
      ? "(No acceptance criteria recorded — derive integrations from the description + design intent alone.)"
      : input.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n");

  const principlesBlock =
    input.designContract.principles.length === 0
      ? "(No explicit principles.)"
      : input.designContract.principles.map((p) => `  - ${p}`).join("\n");

  const constraintsBlock =
    input.designContract.constraints.length === 0
      ? "(No explicit constraints.)"
      : input.designContract.constraints.map((c) => `  - ${c}`).join("\n");

  return [
    "# Task: compile integration requirements from spec acceptance criteria + design intent",
    "",
    "You are the Tanren REQUIREMENT COMPILER. Given a spec's Given/When/Then acceptance",
    "criteria and the project's HEAD DesignContract, derive the set of typed",
    "IntegrationRequirementV1 documents the spec needs (messaging, deploy, error",
    "capture, auth, etc.). Each requirement is a STRICTLY-TYPED integration contract",
    "the provisioner consumes — a malformed requirement fails the compile.",
    "",
    "## Input",
    "",
    "### Spec",
    `- title: ${input.specTitle}`,
    `- description: ${input.specDescription}`,
    "### Acceptance criteria (Given/When/Then):",
    criteriaBlock,
    "",
    "### DesignContract (HEAD, version " + input.designContractVersion + ")",
    `- domain: ${input.designContract.domain}`,
    `- identity: ${input.designContract.identity}`,
    `- intent: ${input.designContract.intent}`,
    "### Design principles:",
    principlesBlock,
    "### Design constraints:",
    constraintsBlock,
    "",
    "## IntegrationRequirementV1 schema (EACH requirement MUST satisfy this)",
    "",
    "A requirement is a JSON object with EXACTLY these fields (strict — no extra keys):",
    "",
    "- `version`: MUST be the literal number `1`.",
    "- `capability`: a non-empty string naming the integration capability. Catalogued:",
    "  control plane = " + CONTROL_CAPABILITIES.join(", ") + ";",
    "  product plane = " + PRODUCT_CAPABILITIES.join(", ") + ".",
    "  A `control.*` prefix FORCES plane `control`; a `product.*` prefix FORCES `product`.",
    "- `plane`: one of " + INTEGRATION_PLANES.map((p) => `\`${p}\``).join(", ") + ".",
    "  MUST agree with the capability's plane affinity (control capability → control plane).",
    "- `direction`: one of " + INTEGRATION_DIRECTIONS.map((d) => `\`${d}\``).join(", ") + ".",
    "- `providerPolicy`: `{ preferred?: string[], allowed?: string[], forbidden?: string[] }`.",
    "  `preferred` MUST NOT appear in `forbidden`; if `allowed` is non-empty, `preferred`",
    "  MUST be a subset of `allowed`; `allowed` and `forbidden` MUST be disjoint.",
    "- `environments`: non-empty array of " + INTEGRATION_ENVIRONMENTS.map((e) => `\`${e}\``).join(", ") + ".",
    "- `trigger`: a BehaviorStimulusV1 — `{ version:1, kind, description, given?, when?,",
    "  behaviorRevisionId?, behaviorKey? }`. `kind` ∈",
    "  `user_action|http|schedule|event|threshold`. `given`/`when` are the structured",
    "  G/W/T carrier — carry the relevant acceptance-criterion wording.",
    "- `expectedEffect`: `{ version:1, plane, provider, observation, correlationFields[],",
    "  independent:true }`. `plane` MUST equal the requirement's `plane`.",
    "  `independent` MUST be the literal `true`. If",
    "  `validation.postDeploy.independentObservation` is true, this field is REQUIRED true.",
    "- `requiredOperations`: non-empty array of provider API operation names.",
    "- `requiredScopes`: non-empty array of provider OAuth/API scope strings.",
    "- `bindingOutputs`: non-empty array (1–32) of AppBindingOutputV1 —",
    "  `{ version:1, kind, logicalKey, classification, required, description? }`.",
    "  `kind` MUST match the requirement's plane:",
    "    control kinds = " + catalog.controlBindingKinds.join(", ") + ";",
    "    product kinds = " + catalog.productBindingKinds.join(", ") + ".",
    "  `logicalKey` MUST match `^[A-Z][A-Z0-9_]*$`. `classification` ∈",
    "  `secret_ref|plain|handle`. If `classification` is `secret_ref`, the `kind` MUST",
    "  end in `_ref` (a ref-shaped kind).",
    "- `validation`: `{ version:1, preMerge:{contractTests,recordingFake,negativeControls,",
    "  liveProviderInMergeGate:false}, postDeploy:{liveStimulus,independentObservation},",
    "  negativeControls:string[] }`. `liveProviderInMergeGate` MUST be the literal `false`",
    "  (live provider calls are FORBIDDEN as merge authority).",
    "- `criticality`: one of " + INTEGRATION_CRITICALITIES.map((c) => `\`${c}\``).join(", ") + ".",
    "",
    "### HARD RULES (a violation FAILS the compile)",
    "",
    "1. NEVER embed credential material. Strings matching credential shapes",
    "   (`xox*-`, `sk_live_`, `ghp_`, `AKIA…`, `-----BEGIN …`) are FORBIDDEN anywhere.",
    "2. A `control.*` capability MUST be plane `control`; a `product.*` capability MUST",
    "   be plane `product`. A cross-plane mismatch fails.",
    "3. `expectedEffect.plane` MUST equal the requirement `plane`.",
    "4. Every `bindingOutputs[].kind` MUST be a plane-matching kind. A product-plane",
    "   requirement MUST NOT carry a `control.*` binding kind (the classic wrong-plane",
    "   Slack guard: product messaging cannot use a control-notify bot-token ref).",
    "5. `validation.preMerge.liveProviderInMergeGate` MUST be literally `false`.",
    "6. `expectedEffect.independent` MUST be literally `true`.",
    "",
    "## Golden example (a valid product-messaging requirement)",
    "",
    "```json",
    JSON.stringify(golden, null, 2),
    "```",
    "",
    "## Output contract",
    "",
    "Return a JSON object with EXACTLY two keys (strict — no extra keys):",
    "",
    "- `requirements`: an array of IntegrationRequirementV1 candidates (0–64 entries).",
    "  Each entry MUST satisfy the schema + ALL hard rules above. An EMPTY array is",
    "  VALID when the spec needs no integrations — then `rationale` MUST explain why.",
    "  Do NOT emit duplicate capabilities for the same plane+environment; merge them.",
    "- `rationale`: a non-empty string (1–8000 chars) explaining which acceptance",
    "  criteria / design intent map to which integration capability, or why no",
    "  integrations are needed. This is REQUIRED even when `requirements` is empty.",
    "",
    "## Catalog summary",
    "",
    "```json",
    JSON.stringify(
      {
        planes: catalog.planes,
        directions: catalog.directions,
        environments: catalog.environments,
        criticalities: catalog.criticalities,
        controlCapabilities: catalog.controlCapabilities,
        productCapabilities: catalog.productCapabilities,
        controlBindingKinds: catalog.controlBindingKinds,
        productBindingKinds: catalog.productBindingKinds,
      },
      null,
      2,
    ),
    "```",
    "",
    "Derive the integration requirements now. Emit ONLY the JSON object described above.",
  ].join("\n");
}
