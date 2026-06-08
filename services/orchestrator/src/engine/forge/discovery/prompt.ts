// P1c: the spec-discovery classification prompt builder.
//
// Renders the prompt handed to a provider Answerer to classify an INSIGHT into
// a real, derived set of proposed specs + DAG-placement options + impact deltas.
// The model is grounded with the project's existing specs (so `dependsOn` +
// placement reference the LIVE DAG, not a template), then asked for exactly one
// `DiscoveryResult`. Kept deterministic + auditable; the strict output schema
// enforces the rest. This is the seam that turns "what to build" into real LLM
// judgement instead of the hardcoded "add csv export" / "fix session race"
// templates the deterministic fixture shipped.

import { SPEC_QUALITY_CONTRACT_PROMPT } from "../../answerers/schemas/specQuality.js";
import type { DiscoveryAnswererContext } from "./types.js";

export function buildDiscoveryPrompt(context: DiscoveryAnswererContext): string {
  const existing = context.existingSpecs.map((spec) => `- ${spec.specId} · ${spec.title} (${spec.status})`).join("\n");
  return [
    "You are Forge, classifying a raw product INSIGHT into a derived, executable",
    "slice of the project's spec DAG. Reason about what should actually be built;",
    "do NOT emit placeholder/template specs.",
    "",
    `Insight variant: ${context.insight.variant}`,
    `Source: ${context.insight.sourceLabel} (${context.insight.source}) — ${context.insight.who}, ${context.insight.when}`,
    "Insight body:",
    context.insight.body,
    "",
    "Existing specs in this project's DAG (id · title · status):",
    existing === "" ? "(none — this is an early/empty project)" : existing,
    "",
    "Return exactly one DiscoveryResult:",
    "- `proposals`: one or more concrete specs (title, description, acceptanceCriteria,",
    "  `dependsOn` referencing the EXISTING spec-ids above where the work builds on them,",
    "  and a `priority`). Each `proposalId` is a stable client-side handle you choose.",
    "- `placements`: the DAG-placement options (slot_after / jump_backlog / interrupt),",
    "  each with an eta, side-effects, priority, and which is `recommended`.",
    "- `deltas`: which personas/behaviors/specs this insight adds or impacts.",
    "- `summary`: your classification narrative; `readSummary`: what you grounded on.",
    "Derive the DAG from the insight + the existing specs — judgement, not a fixed menu.",
    "",
    "Each spec you propose MUST satisfy the spec-quality contract — proposals are",
    "gated by the spec-quality validator before they land, and a spec that fails is",
    "looped back to you to re-author:",
    SPEC_QUALITY_CONTRACT_PROMPT,
  ].join("\n");
}
