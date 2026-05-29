/**
 * P3-0014 discovery seed insights — the three hi-fi `view-discovery` variants
 * (feature / bug / strategic) pre-filled into the insight form so an operator
 * can classify immediately or edit the body first. These are starting points,
 * not fixtures: the form posts whatever the operator submits.
 */

import type { DiscoveryInsight, DiscoveryVariant } from "../../api/discoveryTypes.js";

export const SEED_INSIGHTS: Record<DiscoveryVariant, DiscoveryInsight> = {
  feature: {
    variant: "feature",
    source: "hubspot · acme co",
    sourceLabel: "sales call note",
    who: "dani · ae",
    when: "2h ago",
    glyph: "⌥",
    body: "acme's ops director said their finance team won't sign off on a renewal unless they can export the stats page to csv. they pull these monthly for a board pack — copy-paste isn't acceptable. closing call is friday."
  },
  bug: {
    variant: "bug",
    source: "github · #142",
    sourceLabel: "trouble ticket",
    who: "auto-triaged",
    when: "flaky for 2 weeks",
    glyph: "⌬",
    body: "user logins are flaky · multiple users report 1–3 retries to sign in. ci shows the auth e2e test failing intermittently — currently quarantined as @flaky. 22 production retries in the last 7 days."
  },
  strategic: {
    variant: "strategic",
    source: "strategy doc · qa-conference-notes.md",
    sourceLabel: "exec note",
    who: "cio",
    when: "yesterday",
    glyph: "↗",
    body: "future of acme SaaS is becoming a first-party ads tool. every B2B marketing team uses these channels now — we should let them launch + tune + report from inside our app. this is a Q2 priority."
  }
};

export const VARIANT_EYEBROW: Record<DiscoveryVariant, string> = {
  feature: "▮ spec discovery · from insight",
  bug: "▮ spec discovery · triage",
  strategic: "▮ spec discovery · strategic addition"
};

export function isVariant(value: string): value is DiscoveryVariant {
  return value === "feature" || value === "bug" || value === "strategic";
}
