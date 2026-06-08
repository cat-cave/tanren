// Spec-quality contract — workstream 1 of the spec-loop redesign
// (docs/roadmap/spec-loop-redesign.md §"Workstream 1").
//
// THE CONTRACT. Every spec emitted into the DAG by ANY spec-emitting agent (the
// onboarding/derive roadmap-crafter, the issue-triage that routes a candidate, the
// discovery classifier, and the loop's TRIAGE answerer) must be:
//
//   (a) ACCOMPLISHABLE — a bounded unit: one coherent change a single writer-loop
//       can complete (not an epic, not "build the whole app").
//   (b) DEMO-ABLE — there is a concrete "show me it works": an observable behavior
//       a human (or a test/curl) can exercise to confirm the spec landed.
//   (c) NON-TRIVIAL — worth a spec, not a one-liner / typo / rename that needs no
//       plan-write-check loop.
//   (d) LEGIBLE to a NON-TECHNICAL reader — the title + description convey the
//       scope and PURPOSE to a product person, not just an engineer.
//
// This module is the SINGLE SOURCE of that contract. It exposes two things the
// spec-emitters and the validator both consume:
//   1. SPEC_QUALITY_CONTRACT_PROMPT — reusable PROMPT language injected into every
//      spec-emitting agent so it emits good specs in the FIRST place.
//   2. SpecQualityAnswer (Zod) — the strict output schema of the spec-VALIDATION
//      answerer that gates emission. Each of the four requirements gets a
//      {pass,reason}; an `overall` verdict (`pass` | `revise`) drives the loopback,
//      and `revisionGuidance` is the bounded feedback handed back to the emitter.
//
// The schema is NOT in `answererSchemaCatalog` (the catalog drives the committed
// `generated/*.json` mirror + its drift test). Like the inbox-triage answerer, the
// validator renders its JSON Schema inline via `renderAnswererJsonSchema`, so the
// LLM and the runtime parser see the same OpenAI-strict shape without a codegen
// round.
import { z } from "zod";

export const SPEC_QUALITY_ANSWER_SCHEMA_ID = "tanren.spec_quality_answer.v1" as const;

// A single contract dimension's verdict: did the spec satisfy it, and why/why not.
const SpecQualityCheck = z
  .object({
    pass: z.boolean().describe("True only when the spec satisfies this contract requirement."),
    reason: z
      .string()
      .min(1)
      .describe("One concrete sentence citing what in the spec satisfies or violates this requirement."),
  })
  .strict();

export const SpecQualityAnswer = z
  .object({
    accomplishable: SpecQualityCheck.describe(
      "Is the spec a BOUNDED, accomplishable unit — one coherent change a single writer-loop can complete (not an epic, not 'build the whole product')?",
    ),
    demoable: SpecQualityCheck.describe(
      "Is the spec DEMO-ABLE — is there a concrete observable behavior a human/test can exercise to confirm it works (not a vague or unverifiable goal)?",
    ),
    nonTrivial: SpecQualityCheck.describe(
      "Is the spec NON-TRIVIAL — worth a full plan/write/check loop (not a one-liner, typo, or pure rename that needs no spec)?",
    ),
    legible: SpecQualityCheck.describe(
      "Is the spec LEGIBLE to a NON-TECHNICAL reader — do the title + description convey the scope and PURPOSE to a product person, not just an engineer?",
    ),
    overall: z
      .enum(["pass", "revise"])
      .describe(
        "`pass` only when ALL FOUR requirements pass; `revise` when ANY requirement fails (the spec is looped back to the emitter, never silently accepted).",
      ),
    revisionGuidance: z
      .string()
      .describe(
        "When overall is `revise`, concrete, actionable guidance the emitter uses to re-author the spec so it passes. Empty string when overall is `pass`.",
      ),
  })
  .strict();

export type SpecQualityAnswer = z.infer<typeof SpecQualityAnswer>;

// The reusable PROMPT fragment. Injected (verbatim) into every spec-EMITTING
// agent's prompt so the model authors contract-compliant specs in the first place,
// AND rendered as the framing of the spec-validation answerer (so the gate judges
// against the exact same bar the emitters were told to hit). Single-source: tuning
// the contract is a ONE-place edit here.
export const SPEC_QUALITY_CONTRACT_PROMPT: string = [
  "EVERY spec you emit into the DAG MUST satisfy the Tanren spec-quality contract —",
  "four requirements, all of which must hold:",
  "(a) ACCOMPLISHABLE: a BOUNDED unit — one coherent change a single writer-loop can",
  "    complete in one pass. NOT an epic, NOT 'build the whole product', NOT a bundle",
  "    of unrelated changes. If the work is too big, split it into multiple specs and",
  "    wire the dependency edges.",
  "(b) DEMO-ABLE: a concrete 'show me it works' — name an OBSERVABLE behavior a human",
  "    (or a curl / test) can exercise to confirm the spec landed. Avoid goals that",
  "    cannot be demonstrated or verified.",
  "(c) NON-TRIVIAL: worth a full plan/write/check loop. A one-liner, a typo fix, or a",
  "    pure rename is NOT worth a spec — fold trivia into a larger coherent spec.",
  "(d) LEGIBLE to a NON-TECHNICAL reader: the title + description must convey the",
  "    scope and PURPOSE to a PRODUCT person, not only an engineer. State what the",
  "    user gets and why, in plain language — no unexplained jargon in the title.",
].join("\n");

// The closing output-field instruction for the spec-validation answerer. Names the
// SpecQualityAnswer fields so the model fills the strict schema exactly.
export const SPEC_QUALITY_OUTPUT_INSTRUCTIONS: ReadonlyArray<string> = [
  "Return exactly one SpecQualityAnswer judging the spec above against the four",
  "requirements:",
  "- `accomplishable`, `demoable`, `nonTrivial`, `legible`: each a { pass, reason }.",
  "  `pass` is a boolean; `reason` is one concrete sentence citing the spec text.",
  "- `overall`: `pass` ONLY when all four pass; otherwise `revise`.",
  "- `revisionGuidance`: when `revise`, concrete actionable guidance to re-author the",
  "  spec so it passes (e.g. 'split the auth + billing changes into two specs';",
  "  'add an observable acceptance criterion'; 'rewrite the title in plain language').",
  "  Empty string when `overall` is `pass`.",
];
