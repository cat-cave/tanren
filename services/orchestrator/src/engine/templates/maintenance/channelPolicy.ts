// The CHANNEL UPDATE POLICY (docs/roadmap/templating-system.md §4) — the pure,
// stack-agnostic decision of WHICH upstream versions a template's channel accepts
// and HOW OFTEN it bumps. Two channels:
//
//   - `lts`:     conservative. Accepts ONLY a stable/LTS release; REJECTS a
//                pre-release (alpha/beta/rc/nightly/dev/canary). Slow cadence
//                (monthly) so an LTS template tracks the proven floor.
//   - `nightly`: aggressive. Accepts the latest, INCLUDING pre-releases /
//                cutting-edge tooling. Fast cadence (nightly) so it is the CANARY
//                that hits a breaking upstream release FIRST (§4 — nightly = canary).
//
// EVERY accepted bump (esp. nightly) re-runs the full validation harness — the
// policy here decides only candidacy + cadence; the maintenance pass
// (./maintenancePass.ts) runs the harness. The harness verdict is what protects the
// channel.
//
// STACK-AGNOSTIC by construction: "stable vs pre-release" is decided by a GENERIC
// pre-release marker, not an ecosystem's semver rules — it works for a node/pnpm
// dep, a cargo crate, a python wheel, or any "LTS vs latest" notion (a project's
// `vX.Y.Z-rc.1` / `1.2.3-beta` / `2024-01-15-nightly` all read as pre-release).
// Tanren NEVER hardcodes a stack's release scheme here.

import type { TemplateChannel } from "../manifest.js";

// The cadence (minimum elapsed window) each channel re-checks for upstream updates.
// nightly aggressively re-validates daily (the canary); lts re-checks monthly (the
// conservative floor). Mirrors the audit-loop CADENCE_MS shape so a maintenance job
// reuses the same `cadence` vocabulary the scheduled-audit machinery already speaks.
export const CHANNEL_CADENCE_MS: Record<TemplateChannel, number> = {
  nightly: 24 * 60 * 60_000,
  lts: 30 * 24 * 60 * 60_000,
};

// The audit-cadence label each channel maps to — so a maintenance job registered on
// the scheduled-audit machinery carries the matching cadence enum (`nightly`/`monthly`)
// rather than reinventing a cadence vocabulary. nightly→"nightly", lts→"monthly".
export function channelCadence(channel: TemplateChannel): "nightly" | "monthly" {
  return channel === "nightly" ? "nightly" : "monthly";
}

// A generic pre-release marker: a recognizable pre-release WORD anywhere in the
// label (`alpha`/`beta`/`rc`/`pre`/`nightly`/`dev`/`canary`/`snapshot`/`next`/
// `experimental`/`preview`/`insiders`). This is deliberately scheme-agnostic: it
// does not parse semver, so it works for any ecosystem's "this is not a stable
// release" convention.
const PRERELEASE_WORDS =
  /\b(?:alpha|beta|rc|pre|prerelease|nightly|dev|canary|snapshot|next|experimental|preview|insiders?)\b/iu;

/**
 * Whether a version LABEL denotes a pre-release (cutting-edge / not-yet-stable).
 * PURE + stack-agnostic — reads a generic pre-release marker, never an ecosystem's
 * semver rules. A semver-style `-suffix` (e.g. `1.2.3-rc.1`) OR a pre-release word
 * anywhere in the label counts; a bare stable label (`1.2.3`, `v18.20.0`,
 * `2024.06`) does not.
 */
export function isPrerelease(versionLabel: string): boolean {
  const trimmed = versionLabel.trim();
  if (trimmed.length === 0) return false;
  // A semver pre-release suffix: a `-tag` AFTER the numeric core (e.g. `1.2.3-rc.1`).
  // We split on the FIRST `-` and treat any non-empty suffix as a pre-release tag —
  // but only when the prefix looks like a version core (starts with a digit, possibly
  // a leading `v`), so a stable label that merely contains a dash (`my-stack-1.0`)
  // is not misread.
  const dash = trimmed.indexOf("-");
  if (dash > 0) {
    const core = trimmed.slice(0, dash);
    if (/^v?\d/u.test(core)) return true;
  }
  return PRERELEASE_WORDS.test(trimmed);
}

/**
 * Whether a CHANNEL accepts a candidate upstream version. PURE — the single gate
 * selection consults before deciding to bump + re-validate:
 *   - `lts`     accepts a candidate ONLY when it is a stable release (rejects a
 *               pre-release — the conservative floor).
 *   - `nightly` accepts ANY candidate, including a pre-release (the aggressive
 *               canary that tracks cutting-edge tooling).
 * Reused by the maintenance pass to decide which upstream versions to even attempt;
 * EVERY accepted bump then re-runs the full harness regardless of channel.
 */
export function channelAcceptsVersion(channel: TemplateChannel, versionLabel: string): boolean {
  if (channel === "nightly") return true;
  // lts: accept iff NOT a pre-release.
  return !isPrerelease(versionLabel);
}
