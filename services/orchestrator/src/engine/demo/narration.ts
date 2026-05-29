// P3-0011: demo-role narration generator.
//
// The demo role produces a spec-completion narration — the operator-facing
// "here is what this run demonstrated" block — shaped by the P2A-0008
// `DemoAnswer` schema. Phase 2 shipped only the schema; v0 narration was a
// pure template. This module swaps that template for a real Answerer call
// (default Codex, Claude selectable) WITHOUT touching the DemoAnswer
// contract: the Answerer is asked to emit exactly the P2A-0008 shape and the
// result is parsed through the same Zod source of truth.
//
// The Answerer is injected (an `AnswererAdapter<DemoAnswer>`), so unit tests
// drive the generator without an SSH-backed CLI. Production wiring resolves
// the adapter from the project's `demo` routing chain via the P3-0012
// adapter selector (default Codex; Claude when the chain heads with it).
//
// Graceful degradation is a first-class requirement: when no demo credential
// is configured (the routing chain is empty, so no adapter can be built) OR
// when the live Answerer call fails, the generator falls back to a
// deterministic template that still satisfies the DemoAnswer schema. The demo
// therefore never hard-fails for lack of a credential — it just narrates with
// less polish.

import { answererOutputSchemaFor, DemoAnswer } from "../answerers/schemas/index.js";
import type { AnswererAdapter } from "../providers/types.js";

// Behavior the run demonstrated. Mirrors the P2A-0018 behavior shape the
// caller resolves upstream so this module stays free of repository access.
export interface DemoBehaviorContext {
  id: string;
  title: string;
  // given/when/then narrative the writer satisfied, rendered to a string by
  // the caller. Empty string is allowed (behavior without a scenario).
  scenario: string;
}

// Compact spec-completion context the demo narrator consumes. The caller
// loads this from the completed run (spec metadata, the behaviors the spec
// declared, the merged PR url, any unresolved risks the checker/auditor
// surfaced) so the generator is a pure function of its input.
export interface DemoNarrationInput {
  specTitle: string;
  specDescription: string;
  behaviors: ReadonlyArray<DemoBehaviorContext>;
  // The merged/review-ready PR url, when the run produced one. Surfaced as a
  // demo link so the operator can jump straight to the change.
  prUrl?: string;
  // Risks the loop flagged but did not resolve (e.g. auditor caveats, gate
  // warnings). Carried through to showStopperRisks so the demo is honest.
  unresolvedRisks: ReadonlyArray<string>;
  // Workspace path passed through to the Answerer adapter. Codex needs a
  // workspace mount even for a read-only answerer call.
  workspace?: string;
  timeoutMs: number;
}

export type DemoNarrationProvenance = "answerer" | "template";

export interface DemoNarrationResult {
  answer: DemoAnswer;
  // Which path produced the narration. The caller records this for
  // traceability and so the dashboard can flag template-fallback narration.
  provenance: DemoNarrationProvenance;
  // The schema id the Answerer was invoked with (the P2A-0008 demo schema).
  schemaId: string;
}

// buildDemoPrompt is exported for the prompt-shape test. It is the single
// place that knows what context layers the demo narrator receives.
export function buildDemoPrompt(input: DemoNarrationInput): string {
  const header = [
    "You are the Tanren Demo Answerer. Narrate, for a non-technical operator,",
    "what this completed spec run demonstrated. Be concrete and concise.",
    "Return only the structured JSON required by the provided schema.",
    "Do not edit files, run mutation commands, create commits, or write to the workspace.",
    "",
    `Spec title: ${input.specTitle}`,
    `Spec description: ${input.specDescription}`,
    "",
  ];
  const behaviors =
    input.behaviors.length === 0
      ? ["Behaviors demonstrated: none declared.", ""]
      : [
          "Behaviors this run demonstrated (refer to these by id in highlightBehaviorIds):",
          ...input.behaviors.map((behavior) =>
            behavior.scenario === ""
              ? `- ${behavior.id}: ${behavior.title}`
              : `- ${behavior.id}: ${behavior.title} — ${behavior.scenario}`,
          ),
          "",
        ];
  const risks =
    input.unresolvedRisks.length === 0
      ? ["Unresolved risks: none reported.", ""]
      : [
          "Unresolved risks (surface every one in showStopperRisks):",
          ...input.unresolvedRisks.map((risk) => `- ${risk}`),
          "",
        ];
  const link =
    input.prUrl !== undefined && input.prUrl !== ""
      ? [`Pull request: ${input.prUrl} (include it as a link labelled "Open PR").`, ""]
      : [];
  const footer = [
    "Produce:",
    "- headline: a single operator-facing sentence on what shipped",
    "- body: a short paragraph describing what the run demonstrated",
    "- highlightBehaviorIds: the behavior ids worth showing off (subset of the ids above)",
    "- showStopperRisks: every unresolved risk above, verbatim or paraphrased",
    "- links: relevant links (the PR above, when present)",
  ];
  return [...header, ...behaviors, ...risks, ...link, ...footer].join("\n");
}

// templateDemoNarration is the deterministic fallback. It composes the same
// DemoAnswer shape the LLM emits, purely from the structured input, so the
// demo never hard-fails when no credential is available or the live call
// throws. Exported for the fallback-path test.
export function templateDemoNarration(input: DemoNarrationInput): DemoAnswer {
  const behaviorCount = input.behaviors.length;
  const headline =
    behaviorCount === 0
      ? `Completed: ${input.specTitle}`
      : `Completed: ${input.specTitle} (${behaviorCount} behavior${behaviorCount === 1 ? "" : "s"} demonstrated)`;
  const bodyParts: string[] = [input.specDescription];
  if (behaviorCount > 0) {
    bodyParts.push(
      `This run demonstrated ${behaviorCount} behavior${behaviorCount === 1 ? "" : "s"}: ${input.behaviors
        .map((behavior) => behavior.title)
        .join(", ")}.`,
    );
  }
  if (input.unresolvedRisks.length > 0) {
    bodyParts.push(`${input.unresolvedRisks.length} risk(s) remain open.`);
  }
  const links = input.prUrl !== undefined && input.prUrl !== "" ? [{ label: "Open PR", url: input.prUrl }] : [];
  return DemoAnswer.parse({
    headline,
    body: bodyParts.filter((part) => part !== "").join(" "),
    highlightBehaviorIds: input.behaviors.map((behavior) => behavior.id),
    showStopperRisks: [...input.unresolvedRisks],
    links,
  });
}

// generateDemoNarration produces the demo-role narration.
//
// When `answerer` is non-null, it runs the real Answerer against the P2A-0008
// DemoAnswer schema. If that call throws (timeout, usage-limit, validation,
// transport), it degrades to the template rather than propagating — the demo
// must not hard-fail on a flaky CLI. When `answerer` is null (no credential
// configured), it goes straight to the template.
export async function generateDemoNarration(
  answerer: AnswererAdapter<DemoAnswer> | null,
  input: DemoNarrationInput,
): Promise<DemoNarrationResult> {
  const outputSchema = answererOutputSchemaFor("demo", DemoAnswer);
  if (answerer === null) {
    return {
      answer: templateDemoNarration(input),
      provenance: "template",
      schemaId: outputSchema.name,
    };
  }
  try {
    const answer = await answerer.runAnswerer({
      prompt: buildDemoPrompt(input),
      timeoutMs: input.timeoutMs,
      workspace: input.workspace,
      outputSchema,
    });
    return { answer, provenance: "answerer", schemaId: outputSchema.name };
  } catch {
    // Graceful degradation: any live-Answerer failure falls back to the
    // template so the demo still produces a valid DemoAnswer.
    return {
      answer: templateDemoNarration(input),
      provenance: "template",
      schemaId: outputSchema.name,
    };
  }
}
