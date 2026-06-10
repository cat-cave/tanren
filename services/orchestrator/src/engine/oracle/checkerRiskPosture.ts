// Maps the native entity-change RISK SIGNAL (entityRiskTaxonomy.ts) onto the
// CHECKER's posture: how the deterministic, pre-LLM risk class shapes the
// checker's prompt EMPHASIS and its finding-severity WEIGHTING.
//
// docs/roadmap/entity-analysis-layer.md §3.1. This is the "composes with the
// P0–P3 finding currency" half of the oracle: the risk class is a native signal
// Tanren DERIVES (from the entity-change map) and uses to STEER the checker —
// NOT raw sem output injected as context. Per the answerer architecture (memory:
// "Answerer prompt architecture"), the agent still inspects the diff itself in
// its sandbox; the posture only adds a short steer ("concentrate scrutiny here" /
// "this is cosmetic, a light pass suffices") and a severity-weighting hint the
// loop can apply to the emitted findings. It NEVER injects the entity list, and
// it NEVER decides the verdict — it shapes WHERE the checker spends its attention.

import type { EntityRiskClass, EntityRiskSignal } from "./entityRiskTaxonomy.js";

// The posture the checker should take for a given risk class. `scrutiny` is the
// coarse stance; `severityWeight` is the multiplier the loop applies when
// composing the checker's (always-P0) completeness findings with the auditor's
// P0–P3 currency — a cosmetic-class change down-weights borderline findings, a
// public-signature change up-weights them. `emphasisLines` are appended to the
// checker prompt to steer (not inject) the agent's attention.
export interface CheckerRiskPosture {
  riskClass: EntityRiskClass;
  // "skip" — cosmetic-only: a light pass; do not manufacture findings.
  // "standard" — internal-logic / unknown: the default scrutiny.
  // "heightened" — broad structural change.
  // "maximal" — public-API signature change: the highest scrutiny.
  scrutiny: "skip" | "standard" | "heightened" | "maximal";
  // A relative weight (1.0 = neutral) the loop MAY apply when grading the
  // significance of borderline findings against the project posture. NEVER used
  // to suppress a real completeness gap — only to bias borderline severity.
  severityWeight: number;
  // Prompt steer lines (one per element). Empty for `unknown` (no steer — the
  // checker proceeds exactly as today on the raw diff).
  emphasisLines: ReadonlyArray<string>;
}

// The single source of truth: risk class → posture. Keep in lockstep with the
// taxonomy's classes (adding a class is a deliberate edit to BOTH this map and
// the rank map in entityRiskTaxonomy.ts).
const POSTURE_BY_CLASS: Record<EntityRiskClass, Omit<CheckerRiskPosture, "riskClass">> = {
  unknown: {
    scrutiny: "standard",
    severityWeight: 1.0,
    // No steer: the risk oracle is unavailable, so the checker proceeds on the
    // raw diff exactly as it does today. This is the graceful-fallback posture.
    emphasisLines: [],
  },
  cosmetic: {
    scrutiny: "skip",
    severityWeight: 0.5,
    emphasisLines: [
      "ENTITY-RISK SIGNAL (deterministic, pre-judgement): this change is",
      "COSMETIC-ONLY — the entity-change map shows no behavioral entity changes",
      "(formatting / comments / whitespace). A light completeness pass suffices:",
      "confirm no acceptance criterion silently regressed, then stop. Do NOT",
      "manufacture findings for a cosmetic change.",
    ],
  },
  "internal-logic": {
    scrutiny: "standard",
    severityWeight: 1.0,
    emphasisLines: [
      "ENTITY-RISK SIGNAL (deterministic, pre-judgement): this change is",
      "INTERNAL-LOGIC — behavioral changes confined to internal entities with no",
      "public-surface signature change (bounded blast radius). Apply your standard",
      "completeness scrutiny to the changed logic.",
    ],
  },
  "public-api-signature": {
    scrutiny: "maximal",
    severityWeight: 1.5,
    emphasisLines: [
      "ENTITY-RISK SIGNAL (deterministic, pre-judgement): this change touches a",
      "PUBLIC-API SIGNATURE — a public/exported entity's callable shape changed,",
      "was added, or was removed. This is the HIGHEST structural risk class:",
      "concentrate scrutiny on whether dependents/callers and the behaviors that",
      "exercise this surface are still satisfied for what downstream tasks need.",
    ],
  },
  structural: {
    scrutiny: "heightened",
    severityWeight: 1.25,
    emphasisLines: [
      "ENTITY-RISK SIGNAL (deterministic, pre-judgement): this change is broadly",
      "STRUCTURAL — many structural entity changes and/or deletions/renames, with a",
      "diffuse blast radius. Apply HEIGHTENED scrutiny: trace the structural edits",
      "against the acceptance criteria the downstream depends on.",
    ],
  },
};

// Derive the checker posture from the risk signal. Pure + deterministic.
export function checkerPostureFor(signal: EntityRiskSignal): CheckerRiskPosture {
  const base = POSTURE_BY_CLASS[signal.riskClass];
  return { riskClass: signal.riskClass, ...base };
}

// Render the posture's steer as prompt lines, with the signal's headline counts
// folded in so the steer is concrete ("3 structural, 1 public-signature") without
// injecting the raw entity list. Returns an EMPTY array for the `unknown` posture
// (no steer — the graceful-fallback path), so a caller can append unconditionally.
export function renderRiskPostureLines(signal: EntityRiskSignal): string[] {
  const posture = checkerPostureFor(signal);
  if (posture.emphasisLines.length === 0) {
    return [];
  }
  const c = signal.counts;
  return [
    ...posture.emphasisLines,
    `(entity-change map: ${c.total} changed — ${c.cosmetic} cosmetic, ${c.structural} structural, ${c.publicSignature} public-signature, ${c.deletedOrRenamed} deleted/renamed.)`,
  ];
}
