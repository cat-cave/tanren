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

// A captured reference that is dangling OR a required coverage that is absent — surfaced
// (never silently dropped) so the operator/next-question sees exactly what is wrong.
//   - behaviorPersona      — a behavior names a persona the interview never captured.
//   - incompleteBehavior   — a behavior resolves its persona but its Given/When/Then is
//                            not fully formed (a half-specified behavior is not shippable).
//   - personaWithoutBehavior — a captured persona owns no fully-formed behavior (an actor
//                            with nothing to do is not a complete vision AND would make the
//                            synthesized design coverage non-exact).
//   - designPersona        — the design seed names a persona the interview never captured.
//   - designBehavior       — the design seed names a behavior the interview never captured.
//   - uncoveredPersona     — a captured persona the design seed fails to cover (the MOAT
//                            must be EXACT, never vacuously empty).
//   - uncoveredBehavior    — a captured fully-formed behavior the design seed fails to cover.
// `ref` is the offending natural key.
export interface InterviewInvalidRef {
  kind:
    | "behaviorPersona"
    | "incompleteBehavior"
    | "personaWithoutBehavior"
    | "designPersona"
    | "designBehavior"
    | "uncoveredPersona"
    | "uncoveredBehavior";
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

  // identity — a captured identity whose slug AND pitch carry non-blank CONTENT (trim +
  // reject whitespace-only; `z.string().min(1)` accepts "   ", so presence is not enough).
  if (capture.identity === null || !nonBlank(capture.identity.slug) || !nonBlank(capture.identity.pitch)) {
    missing.push("identity");
  }

  // personas — build the resolution set (case-folded, non-blank names) FIRST; behavior +
  // design refs vet against it below.
  const personaNames = new Set<string>();
  for (const persona of capture.personas) {
    if (nonBlank(persona.name)) personaNames.add(persona.name.trim().toLowerCase());
  }
  if (personaNames.size === 0) missing.push("persona");

  // behaviors — require POSITIVE evidence of ≥1 FULLY-FORMED Given/When/Then behavior
  // whose persona RESOLVES (§4 no vacuous truth). ONLY a fully-formed + resolving behavior
  // becomes coverage-eligible (enters `behaviorKeys`); a behavior naming an uncaptured
  // persona (`behaviorPersona`) or with a blank G/W/T (`incompleteBehavior`) is surfaced
  // invalid and does NOT count — a half-specified behavior can neither complete the
  // interview nor be "covered" by the design seed.
  const behaviorKeys = new Set<string>();
  const personasWithBehavior = new Set<string>();
  for (const behavior of capture.behaviors) {
    const personaKey = behavior.persona.trim().toLowerCase();
    const key = behaviorKey(behavior.persona, behavior.title);
    if (!personaNames.has(personaKey)) {
      invalid.push({
        kind: "behaviorPersona",
        ref: behavior.persona,
        detail: `behavior '${behavior.title}' names persona '${behavior.persona}', which the interview never captured`,
      });
      continue;
    }
    if (!nonBlank(behavior.given) || !nonBlank(behavior.when) || !nonBlank(behavior.then)) {
      invalid.push({
        kind: "incompleteBehavior",
        ref: key,
        detail: `behavior '${behavior.title}' is missing a non-blank Given/When/Then — a half-specified behavior is not shippable`,
      });
      continue;
    }
    behaviorKeys.add(key);
    personasWithBehavior.add(personaKey);
  }
  if (behaviorKeys.size === 0) missing.push("behavior");

  // Every captured persona must OWN ≥1 fully-formed behavior — an actor with nothing to do
  // is not a complete vision, and it would also make the synthesized design coverage
  // non-exact in provider mode (a persona with no behavior never appears in the design's
  // coverage surfaces). Surfaced so the design coverage == the persisted entity set.
  for (const name of personaNames) {
    if (!personasWithBehavior.has(name)) {
      invalid.push({
        kind: "personaWithoutBehavior",
        ref: name,
        detail: `persona '${name}' owns no fully-formed behavior — every captured persona must have at least one`,
      });
    }
  }

  // interfaces — ≥1 declared delivery surface with a non-blank name.
  if (!capture.interfaces.some((iface) => nonBlank(iface.name))) missing.push("interface");

  // design seed — an EXPLICIT domain-general design contract with non-blank core content
  // (domain + identity + intent). A design-light project still declares an explicit
  // minimal seed; a null OR blank-core seed is NOT a valid completion.
  if (capture.designContract === null) {
    missing.push("designSeed");
  } else {
    const seed = capture.designContract;
    if (!nonBlank(seed.domain) || !nonBlank(seed.identity) || !nonBlank(seed.intent)) {
      missing.push("designSeed");
    }
    // Vet the seed's MOAT refs against the captured graph (no dangling ref silently kept).
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
          detail: `design seed names behavior '${key}', which is not a captured fully-formed behavior`,
        });
      }
    }
    // EXACT coverage (§4 no vacuous truth): the MOAT must cover EVERY captured persona AND
    // EVERY fully-formed behavior — an empty or partial seed MOAT is a coverage gap, never
    // vacuously complete. (Extras/unknowns are caught as designPersona/designBehavior above.)
    const seedPersonaSet = new Set(seed.personas.map((name) => name.trim().toLowerCase()));
    for (const name of personaNames) {
      if (!seedPersonaSet.has(name)) {
        invalid.push({
          kind: "uncoveredPersona",
          ref: name,
          detail: `design seed does not cover captured persona '${name}' — the design MOAT must bind every persona`,
        });
      }
    }
    const seedBehaviorSet = new Set(seed.behaviors.map((key) => key.trim().toLowerCase()));
    for (const key of behaviorKeys) {
      if (!seedBehaviorSet.has(key)) {
        invalid.push({
          kind: "uncoveredBehavior",
          ref: key,
          detail: `design seed does not cover captured behavior '${key}' — the design MOAT must bind every behavior`,
        });
      }
    }
  }

  // architecture — ≥1 captured architecture line with non-blank layer AND choice.
  if (!capture.architecture.some((line) => nonBlank(line.layer) && nonBlank(line.choice))) missing.push("architecture");

  // lifecycle — the load-bearing concrete-command declaration.
  if (capture.lifecycle === null) missing.push("lifecycle");

  return { complete: missing.length === 0 && invalid.length === 0, missing, invalid };
}
