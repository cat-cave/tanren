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
    "- `verdict`: your routing decision. Tanren is AUTONOMOUS BY DEFAULT — a clear,",
    "  self-contained bug or feature SHOULD ship without a human call, so default to",
    "  `auto_routable`. Reserve `needs_call` ONLY for genuine PRODUCT ambiguity — a",
    "  'should we even build this?' call where the intent, scope, or value is unclear",
    "  enough that an operator must shape it first (e.g. a vague wish, a strategic",
    "  trade-off, or a request that conflicts with the product's direction). Do NOT",
    "  use `needs_call` merely because a fix is non-trivial or touches several files;",
    "  effort is not ambiguity. Use `dedupe_close` when it duplicates existing work.",
    "- `duplicateOfSpecId`: the existing spec-id when dedupe found one, else null.",
    "- `discoveryVariant`: the variant the accept→discovery hand-off should open with.",
    "- `routableSpec`: WHEN AND ONLY WHEN `verdict` is `auto_routable`, the spec to",
    "  commit into the DAG — a `title`, a `description`, concrete `acceptanceCriteria`,",
    "  any `dependsOn` (existing spec-ids above this spec builds on), and a `priority`",
    "  (`P0`/`P1`/`P2`/`tbd`). For every other verdict, set `routableSpec` to null.",
  ].join("\n");
}
