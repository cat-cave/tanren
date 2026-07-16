// CI-intelligence PR3 — the GENERATIVE loop's shared source identity.
//
// A flaky/slow CI signal becomes an auto-routed inbox candidate → root-cause
// triage → a new spec → auto-shipped through the DAG. That candidate funnels
// through ONE auto-routing system source — the CI-insights source — exactly as
// the scheduled-audit scheduler funnels its findings through the "scheduled
// audits" source. This module single-sources that source's identity (its name +
// the `config` marker that flags it as CI-insight-grain) and the external-id
// namespacing, so the emitter (`ciInsightsCandidates.ts`), the triage prompt
// branch (`prompt.ts`), and the connector map all agree on one set of constants.
//
// WHY a `system`-kind source (not a dedicated `ci_insights` kind): the
// `inbox_sources` table CHECK-constrains `kind` to a fixed set, so a new kind
// value would force a DB migration on that CHECK. The constraint already admits
// `system` (the auto-routing system-source kind the deterministic answerer treats
// as auto-routable), so the CI-insights source is a `system` source distinguished
// by its stable `name` + a `config.ciInsights` marker — no migration, the source
// is just a row in the existing table (the PR3 constraint).

import { SystemSourceConfig, type InboxSource } from "./types.js";

/** The stable display name of the org-wide CI-insights system source (one per org). */
export const CI_INSIGHTS_SOURCE_NAME = "ci insights";

/** The `config` marker that flags a `system` source as the CI-insights grain. */
export const CI_INSIGHTS_CONFIG_MARKER = "ciInsights";

/** The external-id namespace for a flaky-test candidate: one per genuine flaky test. */
export function flakyExternalId(testId: string): string {
  return `ci-flaky:${testId}`;
}

/** The external-id namespace for a slow-suite candidate: one per genuinely-slow suite. */
export function slowExternalId(suite: string): string {
  return `ci-slow:${suite}`;
}

/**
 * Whether a source is the CI-insights system source — the signal the triage
 * prompt branch keys on to reason about a CI root cause. True for a `system`
 * source carrying the CI-insights `config` marker (the find-or-create stamps it).
 */
export function isCiInsightSource(source: Pick<InboxSource, "kind" | "config">): boolean {
  return source.kind === "system" && SystemSourceConfig.safeParse(source.config).success;
}
