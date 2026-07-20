// rv-3 — the verification-fragment WRITER seam + the REAL provider-backed authorer.
//
// The analog of `designFragmentAuthorer.ts`. A verification fragment is a STRUCTURED
// declarative capability descriptor, so — like the code/design fragment writers —
// the ANSWERER pattern is the right seam: one structured LLM call returning parsed
// JSON (`VerificationFragmentDraftV1`), recorded through the same cost/usage path.
// Production wires the allocating Forge answerer adapter (real LLM, per-run scoped
// credentials); deterministic tests inject a fixture authorer through the SAME seam.

import { renderAnswererJsonSchema } from "../../../answerers/schemas/index.js";
import type { AnswererAdapter } from "../../../providers/types.js";
import { sanitizeAuthorerErrorSignature } from "../../../templates/fragments/sanitizeAuthorerErrorSignature.js";
import type {
  AuthoringAuthorer,
  AuthoringAuthorerInput,
  AuthoringSignatureDerivation,
} from "../../../contracts/authoringKernel.js";
import {
  VERIFICATION_FRAGMENT_CONTRACT_VERSION,
  VerificationFragmentDraftV1,
  parseVerificationFragmentDraft,
  verificationFragmentDigest,
  type VerificationFragmentDraftV1 as Draft,
  type VerificationFragmentSpecV1,
} from "./verificationFragment.js";

const STEP_SCHEMA_NAME = "tanren.verification_fragment_authoring.v1";

/** Defensive hard cap on the total prompt size (chars). */
export const VERIFICATION_FRAGMENT_AUTHORER_PROMPT_MAX_CHARS = 20_000;

const PRIOR_CAPABILITIES_MAX = 20;

/** The per-run context the writer prompt is assembled from. */
export interface VerificationFragmentPromptContext {
  /** The behavior the fragment serves (the intent the capability verifies). */
  readonly behaviorTitle?: string;
  /** Prior successful capability identities in this org/project (shape that worked). */
  readonly priorCapabilities?: readonly { readonly fragmentKind: string; readonly capabilityKey: string }[];
}

/** Build the writer prompt for one capability slot. Exported for prompt tests. */
export function buildVerificationFragmentAuthorerPrompt(
  input: AuthoringAuthorerInput<VerificationFragmentSpecV1, Draft>,
  promptContext: VerificationFragmentPromptContext,
): string {
  const { spec, previousAttempt } = input;
  const lines: string[] = [
    `You are authoring ONE Tanren VERIFICATION fragment as structured JSON.`,
    `A verification fragment is a reusable capability the acceptance runtime invokes.`,
    ``,
    `## The capability slot you must author`,
    `capabilityKey:  ${spec.capabilityKey}`,
    `fragmentKind:   ${spec.fragmentKind}`,
    `surface:        ${spec.surface}`,
    `contractVersion (declare verbatim): ${VERIFICATION_FRAGMENT_CONTRACT_VERSION}`,
    ``,
    `## What you must produce`,
    `Return JSON matching the schema: capabilityKey, fragmentKind, surface, version`,
    `("1.0.0"), contractVersion (verbatim above), an \`entrypoint\` (the exported symbol`,
    `the runtime invokes), and \`source\` (the REAL capability source text).`,
    `The \`source\` MUST export the \`entrypoint\` symbol (e.g. \`export function <entrypoint>\`).`,
    `\`capabilityKey\`/\`fragmentKind\`/\`surface\` MUST match the slot above exactly.`,
  ];

  if (promptContext.behaviorTitle !== undefined && promptContext.behaviorTitle !== "") {
    lines.push(``, `## Behavior this fragment verifies`, promptContext.behaviorTitle);
  }

  const prior = (promptContext.priorCapabilities ?? []).slice(0, PRIOR_CAPABILITIES_MAX);
  if (prior.length > 0) {
    lines.push(``, `## Prior successful capabilities in this project (follow the shape that worked)`);
    for (const p of prior) lines.push(`  - kind=${p.fragmentKind}, capability=${p.capabilityKey}`);
  }

  if (previousAttempt !== undefined) {
    lines.push(
      ``,
      `## Previous attempt — REJECTED by the validator`,
      `Address the rejection directly; do not repeat the same body.`,
      `Rejection: ${previousAttempt.rejection}`,
    );
    if (previousAttempt.draft !== undefined)
      lines.push(`Previous draft (truncated): ${JSON.stringify(previousAttempt.draft).slice(0, 4000)}`);
  }

  const rendered = lines.join("\n");
  if (rendered.length > VERIFICATION_FRAGMENT_AUTHORER_PROMPT_MAX_CHARS)
    return rendered.slice(0, VERIFICATION_FRAGMENT_AUTHORER_PROMPT_MAX_CHARS) + "\n// … (prompt truncated at cap)\n";
  return rendered;
}

/** Wrap a structured-output answerer adapter (real LLM) into the kernel writer seam. */
export function wrapProviderVerificationFragmentAuthorer(
  adapter: AnswererAdapter<Draft>,
  promptContext: VerificationFragmentPromptContext = {},
): AuthoringAuthorer<VerificationFragmentSpecV1, Draft> {
  const jsonSchema = renderAnswererJsonSchema(VerificationFragmentDraftV1);
  return {
    async author(input): Promise<Draft> {
      return adapter.runAnswerer({
        prompt: buildVerificationFragmentAuthorerPrompt(input, promptContext),
        outputSchema: {
          name: STEP_SCHEMA_NAME,
          jsonSchema,
          parse: (value): Draft => parseVerificationFragmentDraft(value),
        },
      });
    },
  };
}

/** The binding's signature/preview projections for the kernel's fixed-point loop.
 * `canonicalize` content-addresses the draft (stable, bounded); `sanitize` strips
 * provider noise so a cosmetically-different error is NOT progress; `preview` is the
 * bounded event text (the kernel truncates it to 500 chars). */
export const verificationFragmentSignatures: AuthoringSignatureDerivation<Draft> = {
  canonicalize(draft): string {
    return verificationFragmentDigest(draft);
  },
  sanitize(rejection): string {
    return sanitizeAuthorerErrorSignature(rejection);
  },
  preview(draft): string {
    return `${draft.fragmentKind}:${draft.capabilityKey} v${draft.version} surface=${draft.surface} entry=${draft.entrypoint}`;
  },
};
