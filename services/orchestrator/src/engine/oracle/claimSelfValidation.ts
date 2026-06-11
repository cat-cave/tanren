// The SELF-VALIDATING CLAIM ORACLE — the durable form of the §2.3 staleness check
// (docs/roadmap/entity-analysis-layer.md §3.3, the surviving lodestar thread).
//
// §2.3 made issue-triage a ONE-SHOT "is this entity still present?" decision using
// `sem`'s structural-hash identity. §3.3 makes it DURABLE: an open Claim anchored
// to an entity is RE-CHECKED against the current code; if the entity is gone the
// Claim SELF-RESOLVES, and it survives the refactors that would orphan a line-
// anchored claim. This module is the PURE decision core: given a neutral
// `EntityProbeOutcome` (what an entity producer — `sem` on the runner — found for
// the Claim's anchor identity), it decides whether the Claim self-resolves, stays
// open, or needs an agent — and at which DECIDABILITY tier.
//
// NON-NEGOTIABLE (the no-silent-fallback doctrine + §1 graceful fallback): a Claim
// SELF-RESOLVES ONLY on POSITIVE evidence the entity is GONE (`removed`). ABSENCE
// of evidence — the producer was unavailable, errored, or could not parse the
// stack — NEVER resolves a Claim; it keeps the Claim OPEN (the defect still stands
// until proven otherwise). This is the inverse of the §3.1 risk oracle's `unknown`
// default, and it is deliberate: a missing entity-analysis must never silently
// dismiss a real defect.
//
// GENERALITY (the oracle-taxonomy generality mechanism): the probe outcome is
// STACK-AGNOSTIC. An entity is any first-class unit the producer extracts (a
// function/class/type for code; a chapter/stanza for a non-code project); the
// outcomes (`present`/`modified`/`renamed`/`removed`/`unavailable`) describe its
// fate by IDENTITY, not by language. Same decision function for any stack.
//
// This is PURE: no IO, no clock, no environment read. The wiring layer
// (claimSelfValidationDriver.ts) runs the producer over the runner, maps its
// output into an `EntityProbeOutcome`, calls this, persists the transition, and
// emits the observable event.

// ── The neutral entity-presence probe outcome (the oracle's input) ────────────

// What the entity producer found for a Claim's anchor identity, by STRUCTURAL
// IDENTITY (not file:line):
//   present      — the entity exists, unchanged in any material way.
//   modified     — the entity exists (same identity) but its body changed; the
//                  defect MAY persist or MAY be fixed — an agent must judge.
//   renamed      — the entity exists under a new name/path but the SAME structural
//                  identity (the refactor a line-anchored claim would lose); the
//                  Claim follows it — still OPEN, re-anchored.
//   removed      — POSITIVE evidence the entity is GONE (deleted / refactored away
//                  with no surviving identity). The ONLY outcome that self-resolves.
//   unavailable  — no entity producer ran / it errored / it could not parse the
//                  stack. ABSENCE of evidence → the Claim stays OPEN, never resolves.
export type EntityProbeStatus = "present" | "modified" | "renamed" | "removed" | "unavailable";

// Why the probe was `unavailable`, so the wiring layer honours the no-silent-
// fallback doctrine: `producer-errored` is logged LOUDLY (unexpected), while
// `no-producer` / `producer-unsupported` stay quiet (legitimate absence). Mirrors
// the risk oracle's `EntityRiskProvenance` vocabulary.
export type ProbeUnavailableReason = "no-producer" | "producer-unsupported" | "producer-errored";

// The neutral probe outcome a producer hands the oracle. On a `renamed` outcome
// the producer reports the NEW name/path so the Claim's display anchor can follow
// the entity; on `removed`/`present`/`modified` those are absent/unchanged.
export interface EntityProbeOutcome {
  status: EntityProbeStatus;
  // Set ONLY when `status === "unavailable"` — distinguishes the loud vs quiet
  // absence. Ignored for every present-evidence status.
  unavailableReason?: ProbeUnavailableReason;
  // On a `renamed`, the entity's new human-readable name (display follow). The
  // structural IDENTITY is unchanged — that is why it is a rename, not a removal.
  renamedToName?: string;
  // On a `renamed`, the entity's new file path. Same: a locator follow, not an
  // identity change.
  renamedToPath?: string;
  // A short, producer-supplied, NON-secret rationale (e.g. "sem reports entity
  // identity absent at HEAD"). Surfaced in the persisted read-out + the event.
  rationale?: string;
}

// ── The oracle's verdict ──────────────────────────────────────────────────────

// The Claim status transition the oracle decides. `open` = no change (keep open);
// the other two are terminal-resolution transitions the driver persists. NOTE:
// `agent_resolved` is NEVER decided by this oracle (it is an agent's call, not a
// structural one) — it is part of the store vocabulary, not an oracle outcome.
export type ClaimSelfValidationTransition = "open" | "self_resolved";

// The DECIDABILITY tier of THIS validation (§3.3 / lodestar decidability tiers):
//   decidable    — the oracle reached a confident verdict from positive evidence
//                  (a clean `removed`, or a clean `present`/`renamed` keep-open).
//   needs_agent  — the evidence is ambiguous (`modified`: present-but-changed —
//                  the defect may or may not persist); an AGENT must judge. The
//                  Claim stays OPEN until then (never auto-resolved on ambiguity).
//   unchecked    — only used as the anchor-time default in the store; the oracle
//                  never RETURNS `unchecked` (it always ran a check). Re-exported
//                  here so the store + oracle share one vocabulary.
export type ClaimDecidability = "decidable" | "needs_agent" | "unchecked";

export interface ClaimSelfValidationVerdict {
  // The status transition to persist (`open` = no transition).
  transition: ClaimSelfValidationTransition;
  // The decidability tier of this validation.
  decidability: ClaimDecidability;
  // True iff the entity's identity is GONE and the Claim self-resolved on positive
  // evidence — the durable §2.3 stale-issue resolution.
  selfResolved: boolean;
  // True for the loud `producer-errored` unavailable case (vs the quiet legitimate-
  // absent paths) — the wiring layer logs THIS loudly per no-silent-fallback. False
  // for every present-evidence status and for the legitimate-absent paths.
  unexpectedUnavailable: boolean;
  // On a `renamed`, the new name/path the Claim's display anchor follows to (the
  // identity is unchanged). Absent otherwise.
  followToName?: string;
  followToPath?: string;
  // A human-readable rationale composed from the probe + the decision.
  rationale: string;
}

// ── The pure deterministic decision ───────────────────────────────────────────

// Decide a Claim's self-validation verdict from a neutral probe outcome. PURE +
// DETERMINISTIC: same input ⇒ same output, no IO/clock/env. The cornerstone
// invariant: a Claim self-resolves ONLY on `removed` (positive evidence the entity
// is gone). EVERY other outcome — including every `unavailable` (absence of
// evidence) — keeps the Claim OPEN. A missing entity-analysis NEVER dismisses a
// defect.
export function validateClaimAgainstEntity(probe: EntityProbeOutcome): ClaimSelfValidationVerdict {
  switch (probe.status) {
    case "removed":
      // POSITIVE evidence the entity is gone → the defect can no longer live there.
      // The durable form of §2.3's stale-issue resolution. Confidently decidable.
      return {
        transition: "self_resolved",
        decidability: "decidable",
        selfResolved: true,
        unexpectedUnavailable: false,
        rationale: probe.rationale ?? "Entity identity is absent in the current code; the defect's anchor is gone.",
      };

    case "present":
      // The entity exists, materially unchanged → the defect stands. Keep OPEN,
      // confidently decidable (we have positive evidence it is still there).
      return {
        transition: "open",
        decidability: "decidable",
        selfResolved: false,
        unexpectedUnavailable: false,
        rationale: probe.rationale ?? "Entity is still present and unchanged; the Claim stands.",
      };

    case "renamed":
      // The SAME structural identity under a new name/path — the refactor a line-
      // anchored claim would lose. The Claim FOLLOWS the entity (stays OPEN, re-
      // anchored to the new display name/path). Confidently decidable: identity held.
      return {
        transition: "open",
        decidability: "decidable",
        selfResolved: false,
        unexpectedUnavailable: false,
        ...(probe.renamedToName !== undefined && { followToName: probe.renamedToName }),
        ...(probe.renamedToPath !== undefined && { followToPath: probe.renamedToPath }),
        rationale:
          probe.rationale ??
          `Entity survived a rename/move (identity preserved)${probe.renamedToName === undefined ? "" : ` → ${probe.renamedToName}`}; the Claim follows it and stands.`,
      };

    case "modified":
      // The entity exists (same identity) but its body changed — the defect MAY be
      // fixed or MAY persist. AMBIGUOUS: do NOT auto-resolve. Keep OPEN and flag
      // `needs_agent` so an agent judges whether the change fixed the defect.
      return {
        transition: "open",
        decidability: "needs_agent",
        selfResolved: false,
        unexpectedUnavailable: false,
        rationale:
          probe.rationale ??
          "Entity is present but its body changed; the defect may or may not be fixed — needs agent judgement.",
      };

    case "unavailable":
      // ABSENCE of evidence. The producer was unavailable / errored / could not
      // parse the stack. NEVER self-resolve — keep the Claim OPEN. `needs_agent`
      // tier (a human/agent must establish the entity's fate by other means). Per
      // no-silent-fallback, surface the loud `producer-errored` case separately.
      return {
        transition: "open",
        decidability: "needs_agent",
        selfResolved: false,
        unexpectedUnavailable: probe.unavailableReason === "producer-errored",
        rationale: unavailableRationale(probe),
      };
  }
}

function unavailableRationale(probe: EntityProbeOutcome): string {
  if (probe.rationale !== undefined) return probe.rationale;
  switch (probe.unavailableReason) {
    case "producer-errored":
      return "Entity producer errored; no evidence either way — the Claim stays OPEN (never auto-resolved on a failure).";
    case "producer-unsupported":
      return "Entity producer cannot parse this stack; no evidence — the Claim stays OPEN.";
    default:
      return "No entity producer available; no evidence — the Claim stays OPEN (absence of evidence never resolves).";
  }
}
