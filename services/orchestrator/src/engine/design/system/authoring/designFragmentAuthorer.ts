// ds-3 (F2D) — the design-fragment WRITER seam + the REAL provider-backed authorer.
//
// The design analog of `providerFragmentAuthorer.ts`. A design fragment is a
// STRUCTURED declarative artifact (a typed VFS apply plan), so — exactly like the
// code-fragment authorer — the ANSWERER pattern is the right seam: one structured
// LLM call returning parsed JSON (`DesignFragmentDraftV1`), recorded through the
// same cost/usage path planner/checker/auditor use. Production wires the allocating
// Forge answerer adapter (real LLM, real cost, per-run scoped credentials);
// deterministic tests inject a fixture authorer through the SAME seam.
//
// The prompt is built from the ds-0 DESIGN CONTRACT (intent), the ds-2 web catalog +
// resolved tokens (the substrate to author against), prior org fragments (shape that
// worked), and — on a rework — the previous draft + its validator rejection.

import { renderAnswererJsonSchema } from "../../../answerers/schemas/index.js";
import type { AnswererAdapter } from "../../../providers/types.js";
import { sanitizeAuthorerErrorSignature } from "../../../templates/fragments/sanitizeAuthorerErrorSignature.js";
import type {
  AuthoringAuthorer,
  AuthoringAuthorerInput,
  AuthoringSignatureDerivation,
} from "../../../contracts/authoringKernel.js";
import type { DesignContractV2 } from "../designContractV2.js";
import type { DesignFragmentSpecV1 } from "../designArtifactSchemas.js";
import {
  DesignFragmentDraftV1,
  designFragmentDraftDigest,
  parseDesignFragmentDraft,
  type DesignFragmentDraftV1 as Draft,
} from "./designFragmentDraft.js";

const STEP_SCHEMA_NAME = "tanren.design_fragment_authoring.v1";

/** Defensive hard cap on the total prompt size (chars). */
export const DESIGN_FRAGMENT_AUTHORER_PROMPT_MAX_CHARS = 25_000;

/** The per-run context the writer prompt is assembled from (built once at binding
 * construction — the design contract + substrate are stable across the run). */
export interface DesignFragmentPromptContext {
  readonly contract: DesignContractV2;
  /** The rendered ds-2 web design-system block (catalog + resolved tokens), if any. */
  readonly webDesignBlock?: string;
  /** Prior successful fragment identities in this org (shape that validated before). */
  readonly priorFragments?: readonly { readonly kind: string; readonly label: string }[];
}

const PRIOR_FRAGMENTS_MAX = 20;

/** Build the writer prompt for one design-fragment slot. Exported for prompt tests. */
export function buildDesignFragmentAuthorerPrompt(
  input: AuthoringAuthorerInput<DesignFragmentSpecV1, Draft>,
  promptContext: DesignFragmentPromptContext,
): string {
  const { spec, previousAttempt } = input;
  const contract = promptContext.contract;
  const lines: string[] = [
    `You are authoring ONE Tanren DESIGN fragment as structured JSON.`,
    ``,
    `## Design intent (the contract this fragment serves)`,
    `domain:   ${contract.domain}`,
    `identity: ${contract.identity}`,
    `intent:   ${contract.intent}`,
  ];
  if (contract.principles.length > 0) lines.push(`principles: ${contract.principles.join("; ")}`);
  if (contract.accessibilityPosture.standard !== "none") {
    lines.push(`accessibility: ${contract.accessibilityPosture.standard} — ${contract.accessibilityPosture.notes}`);
  }

  lines.push(
    ``,
    `## The fragment slot you must author`,
    `kind:   ${spec.kind}`,
    `label:  ${spec.label}`,
    `phase:  ${spec.phase}`,
    `version: (use "1.0.0")`,
    `targetCapabilities the fragment may declare: ${spec.targetCapabilities.join(", ") || "(none required)"}`,
    `conformanceSuiteId (declare verbatim): ${spec.conformanceSuiteId}`,
  );

  if (promptContext.webDesignBlock !== undefined && promptContext.webDesignBlock !== "") {
    lines.push(
      ``,
      `## Web design substrate (compose against THESE — do not invent parallel tokens/components)`,
      promptContext.webDesignBlock,
    );
  }

  lines.push(
    ``,
    `## What you must produce`,
    `Return JSON matching the schema: a design fragment with a \`kind\`, \`label\`, \`phase\`,`,
    `\`version\`, capability/dependency arrays, \`conformanceSuiteId\`, and an \`operations\``,
    `array. Each operation ADDS one file to the design VFS via ONE typed op:`,
    `  - addTokenSet | addMode | addAlias   → a "tokens" file (DTCG JSON; it MUST resolve)`,
    `  - addComponent                        → a "component-source" or "component-contract" file`,
    `  - addScenario                         → a "fixture" file`,
    `  - addAsset                            → an "asset" file`,
    `  - addExporter                         → an "export" file`,
    `  - addCatalogRoute                     → a "catalog" file`,
    `Every file \`path\` must be a normalized, forward-slash, traversal-free relative`,
    `path (no leading "/", no "..", no backslashes). \`content\` is the REAL file body.`,
    `The \`kind\`/\`label\`/\`phase\` MUST match the slot above exactly.`,
  );

  const prior = (promptContext.priorFragments ?? []).slice(0, PRIOR_FRAGMENTS_MAX);
  if (prior.length > 0) {
    lines.push(``, `## Prior successful fragments in this org (follow the shape that worked)`);
    for (const p of prior) lines.push(`  - kind=${p.kind}, label=${p.label}`);
  }

  if (previousAttempt !== undefined) {
    lines.push(
      ``,
      `## Previous attempt — REJECTED by the validator`,
      `Address the rejection directly; do not repeat the same body.`,
      `Rejection: ${previousAttempt.rejection}`,
    );
    if (previousAttempt.draft !== undefined) {
      lines.push(`Previous draft (truncated): ${JSON.stringify(previousAttempt.draft).slice(0, 4000)}`);
    }
  }

  const rendered = lines.join("\n");
  if (rendered.length > DESIGN_FRAGMENT_AUTHORER_PROMPT_MAX_CHARS) {
    return rendered.slice(0, DESIGN_FRAGMENT_AUTHORER_PROMPT_MAX_CHARS) + "\n// … (prompt truncated at cap)\n";
  }
  return rendered;
}

/** Wrap a structured-output answerer adapter (real LLM) into the kernel writer seam. */
export function wrapProviderDesignFragmentAuthorer(
  adapter: AnswererAdapter<Draft>,
  promptContext: DesignFragmentPromptContext,
): AuthoringAuthorer<DesignFragmentSpecV1, Draft> {
  const jsonSchema = renderAnswererJsonSchema(DesignFragmentDraftV1);
  return {
    async author(input): Promise<Draft> {
      return adapter.runAnswerer({
        prompt: buildDesignFragmentAuthorerPrompt(input, promptContext),
        outputSchema: {
          name: STEP_SCHEMA_NAME,
          jsonSchema,
          parse: (value): Draft => parseDesignFragmentDraft(value),
        },
      });
    },
  };
}

/** The binding's signature/preview projections for the kernel's fixed-point loop.
 * `canonicalize` content-addresses the draft (a stable, bounded id); `sanitize`
 * strips provider clock/id noise from a rejection before it folds into the
 * signature window (so a cosmetically-different error each attempt is NOT progress);
 * `preview` is the bounded event text (the kernel truncates it to 500 chars). */
export const designFragmentSignatures: AuthoringSignatureDerivation<Draft> = {
  canonicalize(draft): string {
    return designFragmentDraftDigest(draft);
  },
  sanitize(rejection): string {
    return sanitizeAuthorerErrorSignature(rejection);
  },
  preview(draft): string {
    const firstPath = draft.operations[0]?.path ?? "(no ops)";
    return `${draft.kind}@${draft.label} v${draft.version} ops=${draft.operations.length} first=${firstPath}`;
  },
};
