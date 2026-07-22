// rv-21 — the ONE deterministic interview-completion predicate.
//
// The greenfield vision interview accumulates a client-carried `InterviewCapture`
// across rounds; a real Forge project may only DERIVE once the capture is a COMPLETE,
// self-consistent product vision. This module is the single source of truth for what
// "complete" means, invoked from BOTH boundaries:
//
//   - `runRound` (engine.ts): after merging a round's delta, the running capture is
//     re-evaluated. An Answerer that claims `complete: true` EARLY (before the capture
//     is actually complete) does NOT end the interview — the round stays incomplete and
//     surfaces the typed missing/invalid areas so the next question can target them.
//   - the derive boundary (deriveProductGraph): an incomplete capture is a LOUD,
//     fail-closed halt (`InterviewIncompleteError`) BEFORE any repository / project /
//     design-contract row is created — never a partial derive off a half-captured vision.
//
// DETERMINISTIC + PURE: no I/O, no LLM, no wall-clock. Given the same capture it always
// returns the same assessment. Completion requires POSITIVE evidence in every load-
// bearing area (§4 no vacuous truth): an identity, ≥1 persona, ≥1 fully-formed
// Given/When/Then behavior whose persona RESOLVES to a captured persona, ≥1 declared
// interface, an explicit domain-general design seed, ≥1 architecture line, and a
// lifecycle. Rulesets are NOT required — an EXPLICIT empty ruleset set is a valid
// result (a project may legitimately declare none), so their absence never blocks.
//
// It also reports INVALID references (a behavior or design ref naming an entity the
// interview never captured) so no captured reference is silently dropped (§7 proof =
// effect: the same refs the derive would try to resolve are the ones vetted here).

import type { InterviewCapture } from "./types.js";

// A load-bearing capture area that is REQUIRED before the interview may complete.
export type InterviewCaptureArea =
  | "identity"
  | "persona"
  | "behavior"
  | "interface"
  | "designSeed"
  | "architecture"
  | "lifecycle";

// A captured reference that resolves to no captured entity — surfaced (never silently
// dropped) so the operator/next-question sees exactly which link is dangling. `kind`
// names WHICH ref surface carries it; `ref` is the offending natural key.
export interface InterviewInvalidRef {
  kind: "behaviorPersona" | "designPersona" | "designBehavior";
  ref: string;
  detail: string;
}

// The deterministic completion assessment of a running capture.
export interface InterviewCompletionResult {
  // True IFF no required area is missing AND no captured reference is dangling.
  complete: boolean;
  missing: InterviewCaptureArea[];
  invalid: InterviewInvalidRef[];
}

// The natural key of a captured behavior (persona::title, case-folded) — MUST match
// `deriveDesignContract.behaviorKey` so the refs vetted here are exactly the refs the
// derive resolves against the persisted graph (§7 proof = effect coordinate).
function behaviorKey(persona: string, title: string): string {
  return `${persona.trim().toLowerCase()}::${title.trim().toLowerCase()}`;
}

function nonBlank(value: string | undefined | null): boolean {
  return typeof value === "string" && value.trim() !== "";
}

// Thrown at the derive boundary when the capture is not a complete product vision.
// Carries the typed missing/invalid areas so the route maps it to a 409 whose body
// tells the operator EXACTLY what the interview still owes — never a generic 500.
export class InterviewIncompleteError extends Error {
  override readonly name = "InterviewIncompleteError";

  constructor(
    readonly missing: InterviewCaptureArea[],
    readonly invalid: InterviewInvalidRef[],
  ) {
    const invalidText =
      invalid.length === 0 ? "" : `; invalid refs [${invalid.map((item) => `${item.kind}:${item.ref}`).join(", ")}]`;
    super(
      `interview capture is incomplete — cannot derive a project from a half-captured vision: ` +
        `missing [${missing.join(", ")}]${invalidText}. Complete the interview before deriving.`,
    );
  }
}

// Evaluate the deterministic completeness of a capture. Pure — safe to call on every
// round AND at the derive boundary; the two callers agree on completion by construction.
export function evaluateInterviewCompletion(capture: InterviewCapture): InterviewCompletionResult {
  const missing: InterviewCaptureArea[] = [];
  const invalid: InterviewInvalidRef[] = [];

  // identity — the product must have a captured identity (slug + pitch; the schema
  // guarantees both are non-blank when present, so presence is sufficient here).
  if (capture.identity === null) missing.push("identity");

  // personas — build the resolution set (case-folded names) FIRST; behavior + design
  // refs vet against it below.
  const personaNames = new Set<string>();
  for (const persona of capture.personas) {
    if (nonBlank(persona.name)) personaNames.add(persona.name.trim().toLowerCase());
  }
  if (personaNames.size === 0) missing.push("persona");

  // behaviors — require POSITIVE evidence of ≥1 FULLY-FORMED Given/When/Then behavior
  // whose persona RESOLVES (§4 no vacuous truth: not "no bad behavior", but "≥1 good
  // behavior"). A behavior naming an uncaptured persona is surfaced as invalid (§ no
  // silent drop) and does NOT count toward the requirement.
  const behaviorKeys = new Set<string>();
  let resolvableGwtBehaviors = 0;
  for (const behavior of capture.behaviors) {
    const key = behaviorKey(behavior.persona, behavior.title);
    behaviorKeys.add(key);
    const personaResolves = personaNames.has(behavior.persona.trim().toLowerCase());
    if (!personaResolves) {
      invalid.push({
        kind: "behaviorPersona",
        ref: behavior.persona,
        detail: `behavior '${behavior.title}' names persona '${behavior.persona}', which the interview never captured`,
      });
      continue;
    }
    if (nonBlank(behavior.given) && nonBlank(behavior.when) && nonBlank(behavior.then)) {
      resolvableGwtBehaviors += 1;
    }
  }
  if (resolvableGwtBehaviors === 0) missing.push("behavior");

  // interfaces — ≥1 declared delivery surface.
  if (capture.interfaces.length === 0) missing.push("interface");

  // design seed — an EXPLICIT domain-general design contract (domain + identity +
  // intent; schema guarantees non-blank when present). A design-light project still
  // declares an explicit minimal seed; a SILENT absence is not a valid completion.
  if (capture.designContract === null) {
    missing.push("designSeed");
  } else {
    // Vet the seed's MOAT refs against the captured graph so no design ref is silently
    // dropped (the derive would otherwise fail loud deep in the graph write).
    const seed = capture.designContract;
    const vetPersona = (name: string) => {
      if (!personaNames.has(name.trim().toLowerCase())) {
        invalid.push({
          kind: "designPersona",
          ref: name,
          detail: `design seed names persona '${name}', which the interview never captured`,
        });
      }
    };
    for (const name of seed.personas) vetPersona(name);
    for (const dimension of seed.dimensions) for (const name of dimension.personas) vetPersona(name);
    for (const key of seed.behaviors) {
      if (!behaviorKeys.has(key.trim().toLowerCase())) {
        invalid.push({
          kind: "designBehavior",
          ref: key,
          detail: `design seed names behavior '${key}', which the interview never captured`,
        });
      }
    }
  }

  // architecture — ≥1 captured architecture line (the human-readable stack summary).
  if (capture.architecture.length === 0) missing.push("architecture");

  // lifecycle — the load-bearing concrete-command declaration.
  if (capture.lifecycle === null) missing.push("lifecycle");

  return { complete: missing.length === 0 && invalid.length === 0, missing, invalid };
}
