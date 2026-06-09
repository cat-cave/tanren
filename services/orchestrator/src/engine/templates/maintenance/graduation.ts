// The NIGHTLY→LTS GRADUATION GATE (docs/roadmap/templating-system.md §4 — "nightly
// = canary"). Because the nightly template re-validates the FULL harness on every
// aggressive bump, a breaking upstream release fails the NIGHTLY validation FIRST —
// before it ever reaches an LTS template or a real project. The maintenance loop's
// response is three-part:
//   (a) keep the LTS template pinned SAFE (the lts channel never auto-takes the
//       cutting-edge bump),
//   (b) file the breakage as a finding/spec (the maintenance pass does this), and
//   (c) only GRADUATE a version nightly→lts once the nightly validation is GREEN
//       and has STAYED green for an aging window — the gate THIS module decides.
//
// The aging window is the canary's whole point: a version that is green at this
// instant might break on the next aggressive bump; only a version that has been
// green CONTINUOUSLY for the window has earned promotion to the conservative LTS
// floor. PURE + clock-injected — the gate is a deterministic predicate over the
// nightly template's proof, so it is conformance-tested with no DB / no harness.

import { templateValidates } from "../validationProof.js";
import type { TemplateValidationProof } from "../manifest.js";

// The default aging window: a nightly version must have been validated GREEN for at
// least 7 days before it is eligible to graduate to lts. Long enough that a
// subsequent breaking bump would have failed the nightly canary in the interim;
// short enough that lts still tracks a reasonably current floor. Overridable per
// call (tests pass a tight window).
export const DEFAULT_GRADUATION_AGING_MS = 7 * 24 * 60 * 60_000;

/** Why a candidate is NOT yet eligible to graduate (for narration + tests). */
export type GraduationIneligibility =
  // The nightly template has no proof at all (never validated).
  | "unvalidated"
  // The nightly validation is not green (a declared gate unproven / positive
  // controls failed / auditor dirty — the canary is RED, the breakage it caught).
  | "validation-not-green"
  // The validation is green but has not aged the required window yet.
  | "not-aged"
  // The proof's `validatedAt` cannot be parsed — fail-closed, never graduate.
  | "proof-undateable";

export interface GraduationDecision {
  // Whether the nightly version is eligible to promote to the lts channel now.
  eligible: boolean;
  // When ineligible, why (PURE narration; absent when eligible).
  reason?: GraduationIneligibility;
}

/**
 * Decide whether a NIGHTLY template's current version is eligible to graduate to
 * the lts channel as of `now`. PURE + clock-injected. Eligible IFF:
 *   1. the nightly proof is present (the version has been validated), AND
 *   2. `templateValidates(proof)` is true (the canary is GREEN — positive controls
 *      pass, every declared negative control proven, auditor clean), AND
 *   3. the green proof has AGED at least `agingMs` (it has stayed green long enough
 *      that an interim breaking bump would have turned the canary red).
 * FAIL-CLOSED: a `null` proof, a non-green proof, or an undateable `validatedAt`
 * are all ineligible — a version only graduates on affirmative, aged evidence.
 */
export function graduationDecision(input: {
  proof: TemplateValidationProof | null;
  now: Date;
  agingMs?: number;
}): GraduationDecision {
  const { proof, now } = input;
  const agingMs = input.agingMs ?? DEFAULT_GRADUATION_AGING_MS;

  if (proof === null) return { eligible: false, reason: "unvalidated" };
  if (!templateValidates(proof)) return { eligible: false, reason: "validation-not-green" };

  const validatedAt = Date.parse(proof.validatedAt);
  if (Number.isNaN(validatedAt)) return { eligible: false, reason: "proof-undateable" };
  if (now.getTime() - validatedAt < agingMs) return { eligible: false, reason: "not-aged" };

  return { eligible: true };
}

/** Convenience predicate over {@link graduationDecision} — green-and-aged ⇒ true. */
export function eligibleToGraduate(input: {
  proof: TemplateValidationProof | null;
  now: Date;
  agingMs?: number;
}): boolean {
  return graduationDecision(input).eligible;
}
