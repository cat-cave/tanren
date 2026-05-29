// P3-0015: the vision-interview prompt builder.
//
// Renders the per-round prompt handed to a provider Answerer. It states the
// goal (a multi-round product vision interview that accumulates a structured
// capture), the round position, the operator's latest answer, and the capture
// so far, then asks for exactly one `InterviewRoundOutput` (next question +
// capture delta + completion flag). Kept tiny + deterministic so the contract
// is auditable; the strict output schema enforces the rest.

import type { InterviewAnswererContext } from "./types.js";

export function buildInterviewPrompt(context: InterviewAnswererContext): string {
  const captureJson = JSON.stringify(context.capture, null, 2);
  return [
    "You are Forge, running a product vision interview for a brand-new (greenfield) project.",
    `This is round ${context.round} of ~${context.totalRounds}.`,
    "Across the interview you must capture: identity (slug + pitch), personas,",
    "behaviors (Given/When/Then, tied to a persona), interfaces (delivery surfaces),",
    "a design-DNA starter, an architecture proposal, and the required repo rulesets.",
    "",
    "The operator's latest answer:",
    context.answer === "" ? "(none — this is the opening round)" : context.answer,
    "",
    "Capture accumulated so far (JSON):",
    captureJson,
    "",
    "Return exactly one InterviewRoundOutput: `say` is your next question (or a closing",
    "summary when the interview is complete), `captureDelta` is ONLY the new capture this",
    "round adds (the engine merges it), `suggestions` are optional inline answers, and",
    "`complete` is true once every capture area is filled. Ask one focused question at a time."
  ].join("\n");
}
