// scheduled-audits: forge-recommended coverage gaps.
//
// The "forge recommends" panel (hi-fi `AUDIT_RECOMMENDED`) surfaces audit kinds
// the org is NOT yet running, with a grounded "why" and a target window to fill.
// This is a pure read over the org's existing jobs: it diffs the configured
// kinds against the recommendable set and emits the gaps. No provider call —
// the recommendation is deterministic (the surface lets the operator one-click
// schedule a gap into a real job via the composer).

import type { AuditJob, AuditKind } from "./types.js";

export interface AuditRecommendation {
  kind: AuditKind;
  name: string;
  why: string;
  window: string;
  cadence: "nightly" | "weekly" | "monthly";
}

// The recommendable coverage set, grounded in PROJECT_BRIEF §2.2. Each entry is
// emitted only when the org has no enabled job of that kind.
const CATALOG: ReadonlyArray<AuditRecommendation> = [
  {
    kind: "perf",
    name: "performance budget",
    why: "perf milestones depend on a baseline you're not yet measuring nightly.",
    window: "evening (20–00) · low fill",
    cadence: "nightly",
  },
  {
    kind: "license",
    name: "license compliance",
    why: "transitive deps can change license class silently — currently unaudited.",
    window: "night (00–05) · low fill",
    cadence: "weekly",
  },
  {
    kind: "security",
    name: "security scan",
    why: "advisories land daily; a nightly scan surfaces them before they bite.",
    window: "night (00–05) · low fill",
    cadence: "nightly",
  },
  {
    kind: "deps",
    name: "dependency freshness",
    why: "stale deps accrue silently between releases — a nightly sweep keeps them current.",
    window: "night (00–05) · low fill",
    cadence: "nightly",
  },
  {
    kind: "a11y",
    name: "accessibility (a11y)",
    why: "contrast + landmark regressions slip past CI; a weekly sweep catches them.",
    window: "night (00–05) · low fill",
    cadence: "weekly",
  },
  {
    kind: "mutation",
    name: "mutation tests",
    why: "test-suite gaps hide in green CI; mutation runs prove your tests bite.",
    window: "self-host gpu (idle)",
    cadence: "weekly",
  },
  {
    kind: "stale_specs",
    name: "stale-spec sweep",
    why: "queued specs drift from reality; a monthly sweep flags ones to revisit.",
    window: "night (00–05) · low fill",
    cadence: "monthly",
  },
];

// Recommend the kinds the org has no ENABLED job for, capped to the top gaps so
// the panel stays a focused two-up grid (matches the hi-fi).
export function recommendCoverage(jobs: ReadonlyArray<AuditJob>, limit = 4): AuditRecommendation[] {
  const covered = new Set(jobs.filter((j) => j.enabled).map((j) => j.kind));
  return CATALOG.filter((rec) => !covered.has(rec.kind)).slice(0, limit);
}
