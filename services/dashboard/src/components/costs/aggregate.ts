/**
 * P2B-0005 cost aggregation — pure shaping of P2A-0011 cost records (consumed
 * via P2A-0014's run-scoped `/costs` API) into the figures the costs dashboard
 * renders. No I/O, no presentation: the route fetches records, this module
 * rolls them up, and the view composes the markup.
 *
 * ## The three pricing models (PROJECT_BRIEF §4) ↔ the real enum
 *
 * Every record carries the FROZEN P2A-0011 `billingMode` + `costBasis` enums.
 * The operator-facing "three cost models" are the `billingMode` axis:
 *   - per_token    → §4.1 token-billed (real dollars; basis ccusage|provider_pricing)
 *   - subscription → §4.3 subscription-window (no per-call $ basis; costUsd null
 *                    unless ccusage computes one)
 *   - self_hosted  → §4.2 flat-fee / opportunity (utilization, not a cap)
 *
 * `costBasis` is the PROVENANCE of a dollar figure, surfaced per row so every
 * cost row shows its REAL source. `unknown` is an honest, allowed state (token
 * accounting still lands) — never a fabricated placeholder.
 *
 * The hi-fi's older source labels (`provider_direct` / `codexbar` /
 * `opportunity_computed`, and a four-way token/window/opp/infra split) are
 * reconciled here onto the shipped `billingMode` axis. There is no `infra`
 * billing mode in P2A-0011 cost records, so infra is NOT fabricated — only the
 * three real models are surfaced.
 */

import type { BillingMode, CostBasis, CostRecord } from "../../api/types.js";

/** The three pricing models, in display order, keyed by the real billingMode. */
export const PRICING_MODELS: readonly BillingMode[] = ["per_token", "subscription", "self_hosted"];

/** Human label + design-token color + one-line hint for each pricing model. */
export interface PricingModelMeta {
  mode: BillingMode;
  label: string;
  /** §-reference short tag for the operator. */
  model: string;
  /** CSS custom property carrying the source color. */
  colorVar: string;
  hint: string;
}

export const PRICING_MODEL_META: Record<BillingMode, PricingModelMeta> = {
  per_token: {
    mode: "per_token",
    label: "per-token · llm api",
    model: "model 1 · real dollars",
    colorVar: "var(--cost-token)",
    hint: "token-billed api keys · priced from rate tables"
  },
  subscription: {
    mode: "subscription",
    label: "subscription window",
    model: "model 3 · window-equiv",
    colorVar: "var(--cost-window)",
    hint: "chatgpt / claude subscription · window-capped"
  },
  self_hosted: {
    mode: "self_hosted",
    label: "self-hosted · opportunity",
    model: "model 2 · use-it-or-lose-it",
    colorVar: "var(--cost-opportunity)",
    hint: "flat-fee / local gpu · utilization, not a cap"
  }
};

/** Provenance label + dot color for a `costBasis`, surfaced per row. */
export interface CostBasisMeta {
  basis: CostBasis;
  label: string;
}

export const COST_BASIS_META: Record<CostBasis, CostBasisMeta> = {
  ccusage: { basis: "ccusage", label: "ccusage · real billed" },
  provider_pricing: { basis: "provider_pricing", label: "provider pricing · rate table" },
  unknown: { basis: "unknown", label: "no priced basis · tokens only" }
};

/** Parse a nullable dollar string into a number; null/unparseable → 0. */
export function dollars(value: string | null): number {
  if (value === null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** A per-pricing-model rollup: dollars, tokens, record + run counts, share. */
export interface ModelRollup {
  mode: BillingMode;
  meta: PricingModelMeta;
  costUsd: number;
  totalTokens: number;
  records: number;
  runs: number;
  /** Fraction of total spend [0,1]; 0 when total spend is 0. */
  share: number;
}

/**
 * A per-provider breakdown row: the `(cli · model · auth-provider)` triple plus
 * runs, tokens, dollars, share, and the explicit `billingMode` + `costBasis`
 * so the row can color-dot its real source. Rows with a null-priced basis show
 * their tokens and an honest "tokens only" basis — never a fabricated dollar.
 */
export interface ProviderRow {
  cli: string;
  model: string;
  provider: string;
  billingMode: BillingMode;
  costBasis: CostBasis;
  runs: number;
  totalTokens: number;
  costUsd: number;
  /** True when EVERY record in the row had a null `costUsd` (unpriced). */
  priced: boolean;
  share: number;
}

export interface CostSummary {
  /** Total priced spend across all records (subscription/self-hosted may be 0). */
  totalUsd: number;
  totalTokens: number;
  totalRecords: number;
  totalRuns: number;
  /** Rollup per pricing model, in PRICING_MODELS order (always all three). */
  models: ModelRollup[];
  /** Provider breakdown rows, sorted by dollars desc then tokens desc. */
  providers: ProviderRow[];
  /** Count of records whose dollar basis is honestly `unknown`. */
  unpricedRecords: number;
}

/** Roll a flat list of cost records into the dashboard summary. */
export function summarizeCosts(records: readonly CostRecord[]): CostSummary {
  const totalUsd = records.reduce((sum, r) => sum + dollars(r.costUsd), 0);
  const totalTokens = records.reduce((sum, r) => sum + r.totalTokens, 0);
  const runIds = new Set(records.map((r) => r.runId));

  const models = PRICING_MODELS.map((mode) => {
    const inMode = records.filter((r) => r.billingMode === mode);
    const costUsd = inMode.reduce((sum, r) => sum + dollars(r.costUsd), 0);
    return {
      mode,
      meta: PRICING_MODEL_META[mode],
      costUsd,
      totalTokens: inMode.reduce((sum, r) => sum + r.totalTokens, 0),
      records: inMode.length,
      runs: new Set(inMode.map((r) => r.runId)).size,
      share: totalUsd > 0 ? costUsd / totalUsd : 0
    } satisfies ModelRollup;
  });

  const providers = groupProviders(records, totalUsd);

  return {
    totalUsd,
    totalTokens,
    totalRecords: records.length,
    totalRuns: runIds.size,
    models,
    providers,
    unpricedRecords: records.filter((r) => r.costUsd === null).length
  };
}

/**
 * Group records into `(cli · model · provider · billingMode · costBasis)` rows.
 * Two records with the same triple but different cost basis are kept separate
 * so the row's source dot is never ambiguous — every row has ONE explicit
 * source.
 */
function groupProviders(records: readonly CostRecord[], totalUsd: number): ProviderRow[] {
  const byKey = new Map<
    string,
    { sample: CostRecord; runs: Set<string>; tokens: number; usd: number; pricedCount: number; count: number }
  >();
  for (const r of records) {
    const key = `${r.cli}|${r.model}|${r.provider}|${r.billingMode}|${r.costBasis}`;
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = { sample: r, runs: new Set(), tokens: 0, usd: 0, pricedCount: 0, count: 0 };
      byKey.set(key, entry);
    }
    entry.runs.add(r.runId);
    entry.tokens += r.totalTokens;
    entry.usd += dollars(r.costUsd);
    entry.count += 1;
    if (r.costUsd !== null) entry.pricedCount += 1;
  }
  const rows = [...byKey.values()].map((e): ProviderRow => ({
    cli: e.sample.cli,
    model: e.sample.model,
    provider: e.sample.provider,
    billingMode: e.sample.billingMode,
    costBasis: e.sample.costBasis,
    runs: e.runs.size,
    totalTokens: e.tokens,
    costUsd: e.usd,
    priced: e.pricedCount === e.count && e.count > 0,
    share: totalUsd > 0 ? e.usd / totalUsd : 0
  }));
  rows.sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
  return rows;
}

// ---------------------------------------------------------------------------
// Burn projection — daily spend series + a simple linear projection. All
// derived from real recordedAt timestamps + priced dollars; no invented data.
// ---------------------------------------------------------------------------

export interface BurnProjection {
  /** Daily priced-spend buckets over the window, oldest → newest. */
  daily: { day: string; usd: number }[];
  /** Average daily priced spend across the buckets. */
  dailyAvgUsd: number;
  /** Priced spend so far this calendar month. */
  monthToDateUsd: number;
  /** Linear next-30d projection (dailyAvg * 30), rounded to cents. */
  projected30dUsd: number;
  /** Number of days with at least one priced record. */
  activeDays: number;
}

/** UTC day key (YYYY-MM-DD) for a timestamp. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toISOString().slice(0, 10);
}

/**
 * Build a burn projection over the trailing `windowDays` ending at `now`.
 * Buckets priced dollars by UTC day; the projection is a flat linear estimate
 * (dailyAvg × 30) — deliberately simple for v0, refined in Phase 3.
 */
export function projectBurn(
  records: readonly CostRecord[],
  opts: { now?: Date; windowDays?: number } = {}
): BurnProjection {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 14;
  const buckets = new Map<string, number>();
  for (let i = windowDays - 1; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    buckets.set(d.toISOString().slice(0, 10), 0);
  }
  let monthToDateUsd = 0;
  const monthPrefix = now.toISOString().slice(0, 7);
  const activeDaySet = new Set<string>();
  for (const r of records) {
    const usd = dollars(r.costUsd);
    if (usd <= 0) continue;
    const key = dayKey(r.recordedAt);
    if (buckets.has(key)) {
      buckets.set(key, (buckets.get(key) ?? 0) + usd);
      activeDaySet.add(key);
    }
    if (key.startsWith(monthPrefix)) {
      monthToDateUsd += usd;
    }
  }
  const daily = [...buckets.entries()].map(([day, usd]) => ({ day, usd }));
  const total = daily.reduce((sum, d) => sum + d.usd, 0);
  const dailyAvgUsd = daily.length > 0 ? total / daily.length : 0;
  return {
    daily,
    dailyAvgUsd,
    monthToDateUsd,
    projected30dUsd: Math.round(dailyAvgUsd * 30 * 100) / 100,
    activeDays: activeDaySet.size
  };
}

// ---------------------------------------------------------------------------
// Observed metrics (the v0 DORA-like stub) — derived from run outcomes.
// ---------------------------------------------------------------------------

export interface ObservedMetrics {
  specsMerged: number;
  avgCostPerMergedUsd: number | null;
  haltRate: number;
  totalRuns: number;
}

const MERGED_OUTCOMES = new Set([
  "phase1_fixture_complete",
  "phase2_easy_complete",
  "phase2_medium_complete"
]);
const HALTED_OUTCOMES = new Set(["halted", "escape_hatch_hit", "retry_budget_exhausted"]);

/**
 * Observed run metrics for the reported-not-targeted panel. `merged` is keyed
 * on the Phase-1/2 completion outcomes; halt-rate on the escape-hatch family.
 * Cost-per-merged divides total priced spend by the merged-run count.
 */
export function observeMetrics(
  runs: readonly { outcome: string | null }[],
  totalPricedUsd: number
): ObservedMetrics {
  const specsMerged = runs.filter((r) => r.outcome !== null && MERGED_OUTCOMES.has(r.outcome)).length;
  const halted = runs.filter((r) => r.outcome !== null && HALTED_OUTCOMES.has(r.outcome)).length;
  return {
    specsMerged,
    avgCostPerMergedUsd: specsMerged > 0 ? totalPricedUsd / specsMerged : null,
    haltRate: runs.length > 0 ? halted / runs.length : 0,
    totalRuns: runs.length
  };
}
