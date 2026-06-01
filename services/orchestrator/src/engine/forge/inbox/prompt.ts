// P1c: the candidate-triage prompt builder.
//
// Renders the prompt handed to a provider Answerer to triage one ingested
// candidate (a GitHub issue, Sentry error, audit finding, …) against the live
// project DAG: dedupe vs. existing specs, match it to a behavior/spec/milestone,
// propose a DAG placement, and reach a verdict. The model is grounded with the
// project's existing specs so dedupe + placement reference reality. Asks for
// exactly one `CandidateTriage`; the strict output schema enforces the rest.

import type { TriageAnswererContext } from "./types.js";

export function buildTriagePrompt(context: TriageAnswererContext): string {
  const existing = context.existingSpecs.map((spec) => `- ${spec.specId} · ${spec.title} (${spec.status})`).join("\n");
  return [
    "You are Forge, running triage on one ingested candidate (an issue/error/finding)",
    "for the project's candidate inbox. Reach a real verdict — do not rubber-stamp.",
    "",
    `Source: ${context.source.name} (${context.source.kind})`,
    `Candidate: ${context.candidate.title} [${context.candidate.severity}]`,
    "Body:",
    context.candidate.body,
    "",
    "Existing specs in this project's DAG (id · title · status):",
    existing === "" ? "(none)" : existing,
    "",
    "Return exactly one CandidateTriage:",
    "- `dedupe`: whether this duplicates an existing spec/candidate (and which).",
    "- `match`: which behavior/spec/milestone it fits.",
    "- `placement`: the proposed DAG placement (or `auto → … queued`).",
    "- `verdict`: your routing decision.",
    "- `duplicateOfSpecId`: the existing spec-id when dedupe found one, else null.",
    "- `discoveryVariant`: the variant the accept→discovery hand-off should open with.",
  ].join("\n");
}
