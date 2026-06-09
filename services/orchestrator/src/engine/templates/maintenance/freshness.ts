// The DEGRADED-MARKING policy (docs/roadmap/templating-system.md §4) — the pure
// predicate that decides when a template's registry status must drop to `degraded`
// so selection (which already filters degraded) stops choosing it. Two triggers:
//
//   1. FRESHNESS EXPIRY — its `validationProof` is older than a freshness horizon.
//      A proof goes stale: upstream moves, the harness has not re-validated in too
//      long, so the template's "meaningful, not green-by-accident" guarantee can no
//      longer be trusted. An UNVALIDATED template (`validationProof === null`) has
//      no proof to expire — it is never `validated`, so freshness does not apply.
//   2. UNRESOLVED P0/P1 — a maintenance audit pass surfaced a blocking finding the
//      template still carries. A template with an open blocking finding cannot be
//      trusted to seed real projects.
//
// FAIL-CLOSED: a template whose proof we CANNOT date (a malformed/empty
// `validatedAt`) reads as EXPIRED — never as fresh — so an unparseable proof
// degrades rather than silently shipping. Clock is INJECTED (no Date.now) so the
// horizon is testable + deterministic.

import type { TemplateValidationProof } from "../manifest.js";

// The default freshness horizon: 45 days. A `validated` template whose proof is
// older than this is degraded until a maintenance pass re-validates it. Chosen to
// comfortably exceed the lts monthly cadence (so a healthy lts template re-validates
// BEFORE its proof expires) while still expiring a template the maintenance loop has
// stopped reaching. Overridable per call (tests pass a tight horizon).
export const DEFAULT_FRESHNESS_HORIZON_MS = 45 * 24 * 60 * 60_000;

/**
 * Whether a validation proof has EXPIRED as of `now` — older than `horizonMs`.
 * PURE + clock-injected. FAIL-CLOSED: a `null` proof or an undateable `validatedAt`
 * reads as expired (the template cannot prove freshness, so it must degrade).
 */
export function proofExpired(
  proof: TemplateValidationProof | null,
  now: Date,
  horizonMs: number = DEFAULT_FRESHNESS_HORIZON_MS,
): boolean {
  if (proof === null) return true;
  const validatedAt = Date.parse(proof.validatedAt);
  if (Number.isNaN(validatedAt)) return true;
  return now.getTime() - validatedAt >= horizonMs;
}

/**
 * Whether a template must be marked `degraded` as of `now`. PURE. Degrade when the
 * proof has expired (freshness horizon) OR a maintenance pass found an unresolved
 * blocking (P0/P1) finding. Selection already filters degraded, so a `true` here
 * removes the template from the candidate set until a maintenance re-validation
 * clears it.
 */
export function shouldDegrade(input: {
  proof: TemplateValidationProof | null;
  // The count of unresolved P0/P1 findings a maintenance pass surfaced (0 ⇒ none).
  openBlockingFindings: number;
  now: Date;
  horizonMs?: number;
}): boolean {
  if (input.openBlockingFindings > 0) return true;
  return proofExpired(input.proof, input.now, input.horizonMs);
}
