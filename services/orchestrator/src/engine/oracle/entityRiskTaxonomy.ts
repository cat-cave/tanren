// The native entity-change RISK TAXONOMY + deterministic classifier — the
// `inspect`-inspired oracle, built NATIVE into the checker (not a shelled tool).
//
// docs/roadmap/entity-analysis-layer.md §3.1: fold an entity-change risk triage +
// structural verdict into the checker as part of the ORACLE TAXONOMY (memory:
// "Tanren = general build engine" — the oracle taxonomy is the generality
// mechanism). The entity-level change map becomes a first-class signal the checker
// reasons over DETERMINISTICALLY, BEFORE the LLM judgement: a cosmetic-only change
// is a different risk class than a public-API signature change, so the checker can
// cheaply skip / downgrade cosmetic changes and concentrate scrutiny on high-risk
// structural ones. Because it is native, it composes with the P0–P3 finding
// currency rather than being a separate tool's opinion.
//
// GENERALITY (non-negotiable, §1): the core model bakes in NO language assumption.
// `sem` is the (optional) entity-diff SOURCE, but this module classifies a NEUTRAL
// `EntityChangeMap` — a list of `EntityChange`s whose `kind`/`nature`/`visibility`
// are stack-agnostic. A non-code project (a fan-translation where "entities" are
// chapters, a config repo where they are stanzas) can produce the same map. The
// taxonomy is the durable asset; `sem` is one producer of its input.
//
// FALLBACK (non-negotiable, §1): the risk signal is an OPTIONAL accelerator. When
// no entity-change map is available (sem absent, or the stack can't be parsed) the
// classifier returns the `unknown` risk class and the checker proceeds on the raw
// diff exactly as today. This module NEVER blocks or changes a verdict because the
// oracle is unavailable. The DISTINCTION the no-silent-fallback doctrine demands —
// "sem absent (legitimate) vs sem present-but-erroring (unexpected)" — is carried
// by `EntityRiskSignal.provenance` so the wiring layer can log the unexpected case
// loudly while the legitimate-absent case stays quiet.

// ── The neutral entity-change map (the classifier's input) ───────────────────

// How an entity changed. Stack-agnostic: an entity is any first-class unit the
// producer extracts (a function/class/method/type for code; a chapter/stanza for
// a non-code project). `rename` carries identity across a move (sem's structural
// hash); we treat it as a structural change unless the body is otherwise cosmetic.
export type EntityChangeKind = "added" | "modified" | "deleted" | "renamed";

// The NATURE of the change to the entity's body. `cosmetic` = formatting,
// whitespace, comments, doc-only — no behavioral change. `structural` = the
// entity's behaviour/shape changed. `unknown` = the producer could not decide
// (e.g. a partially-parsed entity); treated conservatively as NOT cosmetic.
export type EntityChangeNature = "cosmetic" | "structural" | "unknown";

// Whether the entity is part of the project's PUBLIC surface (an exported
// function/type, a public method) or INTERNAL (a private helper, a local). A
// signature change to a public entity is the highest structural risk class
// because it can break external/dependent callers. `unknown` when the producer
// cannot determine visibility; treated as NOT public (so we do not over-escalate).
export type EntityVisibility = "public" | "internal" | "unknown";

// One entity's change in the map. `signatureChanged` is the load-bearing
// structural signal: a change to the entity's CALLABLE SHAPE (params, return
// type, generics, exported type fields) — distinct from an internal-logic edit
// that leaves the signature intact. `id` is the entity's stable identity (sem's
// structural hash / a path-qualified name) so the signal is traceable but is NOT
// required for classification.
export interface EntityChange {
  id?: string;
  kind: EntityChangeKind;
  nature: EntityChangeNature;
  visibility: EntityVisibility;
  // True when the change altered the entity's public/callable signature. Only
  // meaningful for `added`/`modified`/`renamed`; a `deleted` public entity is
  // itself a signature-level (breaking) change and is handled by `kind`.
  signatureChanged?: boolean;
}

// The neutral entity-change map: the full set of entity changes for a diff.
// Produced by normalizing `sem diff --format json`, or by any other entity
// producer, or supplied empty for a genuinely empty diff. `undefined`/`null`
// (NOT empty) is the "no map available" signal — see `classifyEntityRisk`.
export interface EntityChangeMap {
  entities: ReadonlyArray<EntityChange>;
}

// ── The risk taxonomy (the classifier's output) ──────────────────────────────

// The entity-change RISK CLASSES, ordered low→high. This ordering IS the
// taxonomy's severity axis — `riskClassRank` keys off it. Adding a class is a
// deliberate taxonomy change (update the rank map + the posture map together).
//
// - `unknown`           — no entity map available (sem absent / can't-parse).
//                         The checker proceeds on the raw diff as today.
// - `cosmetic`          — every changed entity is cosmetic-only (formatting /
//                         comments / whitespace); zero behavioral change.
// - `internal-logic`    — behavioral change(s), but confined to INTERNAL
//                         entities with no signature change — bounded blast radius.
// - `public-api-signature` — a PUBLIC entity's signature changed (or a public
//                         entity was added/removed) — can break dependents.
// - `structural`        — broad structural change (many structural entities, or
//                         deletions/renames) without a single public-signature
//                         focal point — high scrutiny, diffuse blast radius.
export type EntityRiskClass = "unknown" | "cosmetic" | "internal-logic" | "public-api-signature" | "structural";

// Severity rank for ordering / "take the highest" composition. `unknown` sits at
// 0 (it must never out-rank a real class — an unclassifiable signal cannot
// escalate scrutiny) and the real classes climb from cosmetic up.
const RISK_CLASS_RANK: Record<EntityRiskClass, number> = {
  unknown: 0,
  cosmetic: 1,
  "internal-logic": 2,
  "public-api-signature": 4,
  structural: 3,
};

export function riskClassRank(riskClass: EntityRiskClass): number {
  return RISK_CLASS_RANK[riskClass];
}

// Why a class was chosen (and, for `unknown`, WHICH absence). The wiring layer
// reads `provenance` to honour the no-silent-fallback doctrine: a `sem-errored`
// provenance is logged LOUDLY (unexpected), while `no-producer` /
// `producer-unsupported` stay quiet (legitimate absence on an unsupported stack).
export type EntityRiskProvenance =
  // A real entity map was classified.
  | "classified"
  // No entity producer ran at all (sem not on PATH) — legitimate, quiet.
  | "no-producer"
  // The producer ran but reported it cannot parse the stack — legitimate, quiet.
  | "producer-unsupported"
  // The producer ran and ERRORED / emitted unparseable output — UNEXPECTED, loud.
  | "producer-errored";

// The deterministic risk signal: the class, its provenance, a human-readable
// rationale, and per-class entity counts the wiring/observability layer surfaces.
export interface EntityRiskSignal {
  riskClass: EntityRiskClass;
  provenance: EntityRiskProvenance;
  rationale: string;
  // Headline counts (always present; zeros under `unknown`). These drive the
  // checker posture emphasis ("N public-signature entities changed") without
  // injecting the raw entity list into the prompt.
  counts: {
    total: number;
    cosmetic: number;
    structural: number;
    publicSignature: number;
    deletedOrRenamed: number;
  };
}

// True when this provenance is an UNEXPECTED failure that must be observable
// (logged/eventful) per the no-silent-fallback doctrine — as opposed to the
// legitimate "no map available" absence, which stays quiet.
export function isUnexpectedRiskFailure(provenance: EntityRiskProvenance): boolean {
  return provenance === "producer-errored";
}

// ── The pure deterministic classifier ────────────────────────────────────────

// How the classifier was told the map is unavailable, so it can stamp the right
// `unknown` provenance. `null`/`undefined` map + no reason ⇒ `no-producer`.
export type UnavailableReason = "no-producer" | "producer-unsupported" | "producer-errored";

function unknownSignal(provenance: EntityRiskProvenance, rationale: string): EntityRiskSignal {
  return {
    riskClass: "unknown",
    provenance,
    rationale,
    counts: { total: 0, cosmetic: 0, structural: 0, publicSignature: 0, deletedOrRenamed: 0 },
  };
}

// Classify a neutral entity-change map into a risk class. PURE + DETERMINISTIC:
// same input ⇒ same output, no IO, no clock, no environment read. This is the
// oracle's core — every consumer (checker posture, finding weighting, tests)
// shares this single function.
//
// `map === undefined | null` ⇒ `unknown` (the producer did not run / no map).
// `unavailable` lets the caller distinguish a producer that erred (loud) from a
// producer that legitimately cannot parse the stack (quiet) — it is honoured ONLY
// when the map is absent; a present map is always classified.
export function classifyEntityRisk(
  map: EntityChangeMap | undefined | null,
  unavailable?: UnavailableReason,
): EntityRiskSignal {
  if (map === undefined || map === null) {
    switch (unavailable) {
      case "producer-errored":
        return unknownSignal(
          "producer-errored",
          "Entity producer errored or emitted unparseable output; risk unclassified.",
        );
      case "producer-unsupported":
        return unknownSignal("producer-unsupported", "Entity producer cannot parse this stack; risk unclassified.");
      default:
        return unknownSignal("no-producer", "No entity producer available; risk unclassified.");
    }
  }

  const entities = map.entities;
  const total = entities.length;

  // A genuinely EMPTY diff (zero entities changed) is cosmetic-equivalent: there
  // is nothing structural to scrutinize. This is the cheap-skip the doc calls out
  // ("0 entities changed, cosmetic-only → move on").
  if (total === 0) {
    return {
      riskClass: "cosmetic",
      provenance: "classified",
      rationale: "No entities changed (empty or whitespace/comment-only diff).",
      counts: { total: 0, cosmetic: 0, structural: 0, publicSignature: 0, deletedOrRenamed: 0 },
    };
  }

  let cosmetic = 0;
  let structural = 0;
  let publicSignature = 0;
  let deletedOrRenamed = 0;

  for (const change of entities) {
    const isCosmetic = change.nature === "cosmetic";
    if (isCosmetic) {
      cosmetic += 1;
    } else {
      // `structural` AND `unknown` nature both count as non-cosmetic: an
      // unknown-nature entity is treated conservatively as potentially behavioral.
      structural += 1;
    }

    if (change.kind === "deleted" || change.kind === "renamed") {
      deletedOrRenamed += 1;
    }

    // A public-surface signature change (or a public add/delete) is the
    // highest-risk structural signal: it can break dependents/callers.
    const publicEntity = change.visibility === "public";
    const breakingShape =
      change.signatureChanged === true ||
      change.kind === "deleted" ||
      change.kind === "added" ||
      change.kind === "renamed";
    if (publicEntity && breakingShape && !isCosmetic) {
      publicSignature += 1;
    }
  }

  const counts = { total, cosmetic, structural, publicSignature, deletedOrRenamed };
  const entitiesWord = (n: number): string => (n === 1 ? "entity" : "entities");

  // ── Deterministic class decision (highest applicable class wins) ───────────

  // 1. Cosmetic-only: every changed entity is cosmetic. The cheap-skip case.
  if (structural === 0) {
    return {
      riskClass: "cosmetic",
      provenance: "classified",
      rationale: `${total} ${entitiesWord(total)} changed, all cosmetic-only (formatting/comments).`,
      counts,
    };
  }

  // 2. Public-API signature: any public entity's signature/shape changed. This is
  //    the focal high-risk class — it out-ranks a diffuse structural change
  //    because the blast radius is concrete (dependents of a public symbol).
  if (publicSignature > 0) {
    return {
      riskClass: "public-api-signature",
      provenance: "classified",
      rationale: `${publicSignature} public-surface signature change${publicSignature === 1 ? "" : "s"} (of ${structural} structural ${entitiesWord(structural)}); public callers/dependents may break.`,
      counts,
    };
  }

  // 3. Broad structural: many structural entities, or any deletion/rename without
  //    a public-signature focal point — diffuse, high-scrutiny blast radius.
  //    Threshold is intentionally low (≥ 3 structural entities, OR any
  //    delete/rename) so a wide refactor is escalated above plain internal-logic.
  if (structural >= 3 || deletedOrRenamed > 0) {
    return {
      riskClass: "structural",
      provenance: "classified",
      rationale: `${structural} structural ${entitiesWord(structural)} changed (${deletedOrRenamed} deleted/renamed); diffuse blast radius.`,
      counts,
    };
  }

  // 4. Internal logic: a small number of structural changes confined to internal
  //    entities with no signature change — bounded blast radius.
  return {
    riskClass: "internal-logic",
    provenance: "classified",
    rationale: `${structural} internal structural change${structural === 1 ? "" : "s"}, no public-surface signature change; bounded blast radius.`,
    counts,
  };
}
