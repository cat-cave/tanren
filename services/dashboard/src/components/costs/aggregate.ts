/**
 * cost aggregation — pure shaping of cost records (consumed
 * via the run-scoped `/costs` API) into the figures the costs dashboard
 * renders. No I/O, no presentation: the route fetches records, this module
 * rolls them up, and the view composes the markup.
 *
 * ## The three pricing models (PROJECT_BRIEF §4) ↔ the real enum
 *
 * Every record carries the FROZEN `billingMode` + `costBasis` enums.
 * The operator-facing "three cost models" are the `billingMode` axis:
 *   - per_token    → §4.1 token-billed (real dollars; basis ccusage|provider_response)
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
 * billing mode in cost records, so infra is NOT fabricated — only the
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
    hint: "token-billed api keys · real metered spend (provider charge / ccusage)",
  },
  subscription: {
    mode: "subscription",
    label: "subscription window",
    model: "model 3 · window-equiv",
    colorVar: "var(--cost-window)",
    hint: "chatgpt / claude subscription · window-capped",
  },
  self_hosted: {
    mode: "self_hosted",
    label: "self-hosted · opportunity",
    model: "model 2 · use-it-or-lose-it",
    colorVar: "var(--cost-opportunity)",
    hint: "flat-fee / local gpu · utilization, not a cap",
  },
  // BUDGET-SAFETY C1: NOT a real pricing model — an UNRECOGNIZED credential ref
  // (a misconfig) whose cost could not be priced. Recorded NULL-dollar but
  // FLAGGED (the budget gate fails closed on it). Kept out of PRICING_MODELS (the
  // operator's three real models) but present here so the provider breakdown can
  // color-dot the misconfig distinctly.
  unattributed: {
    mode: "unattributed",
    label: "unattributed · unrecognized ref",
    model: "misconfig · budget fails closed",
    colorVar: "var(--cost-unattributed, var(--status-fail))",
    hint: "unrecognized credential ref · cannot price · fix the credential mapping",
  },
};

/** Provenance label + dot color for a `costBasis`, surfaced per row. */
export interface CostBasisMeta {
  basis: CostBasis;
  label: string;
}

export const COST_BASIS_META: Record<CostBasis, CostBasisMeta> = {
  ccusage: { basis: "ccusage", label: "ccusage · real billed" },
  // The provider's OWN authoritative per-call charge (OpenRouter's `usage.cost`):
  // the REAL deduction with no markup — the most accurate real-spend basis.
  provider_response: { basis: "provider_response", label: "provider response · real charge" },
  credits: { basis: "credits", label: "credits · prepaid drawdown" },
  unknown: { basis: "unknown", label: "no priced basis · tokens only" },
  // BUDGET-SAFETY C1: an UNRECOGNIZED credential ref — cost could not be priced;
  // recorded NULL-dollar but flagged so the budget gate fails closed.
  unattributed: { basis: "unattributed", label: "unattributed · unrecognized ref" },
};

/** Parse a nullable dollar string into a number; null/unparseable → 0. */
export function dollars(value: string | null): number {
  if (value === null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The HEADLINE FIGURE the costs view leads with. Vocabulary discipline
 * (FOCUS-aligned): `real` = real money out the door (BilledCost / `cost_usd`);
 * `equivalent` = the API-equivalent, list-priced ESTIMATE (ListCost /
 * `notional_cost_usd`) — never called "spend".
 *
 * A subscription/Teams org meters NO per-call real spend (`cost_usd` null), so its
 * real total is $0 and a real-led headline would read "$0 trend" — actively
 * misleading. So the headline leads with the EQUIVALENT figure when real spend is
 * absent but notional value exists; otherwise it leads with real spend. Both figures
 * are always shown side-by-side regardless — this only picks which one is the lead.
 */
export type HeadlineBasis = "real" | "equivalent";

export function pickHeadlineBasis(totalUsd: number, notionalUsd: number): HeadlineBasis {
  return totalUsd <= 0 && notionalUsd > 0 ? "equivalent" : "real";
}

/** A per-pricing-model rollup: dollars, tokens, record + run counts, share. */
export interface ModelRollup {
  mode: BillingMode;
  meta: PricingModelMeta;
  /** REAL spend (BilledCost / `cost_usd`) for this model; subscription/self-hosted ≈ 0. */
  costUsd: number;
  /**
   * NOTIONAL / API-EQUIVALENT value (ListCost / `notional_cost_usd`) for this model —
   * the list-priced estimate, non-zero even for subscription/self-hosted. NOT spend.
   */
  notionalUsd: number;
  totalTokens: number;
  records: number;
  runs: number;
  /** Fraction of total REAL spend [0,1]; 0 when total real spend is 0. */
  share: number;
  /** Fraction of total NOTIONAL value [0,1]; 0 when total notional is 0. */
  notionalShare: number;
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
  /** NOTIONAL / API-equivalent value (ListCost / `notional_cost_usd`) for the row. */
  notionalUsd: number;
  /** True when EVERY record in the row had a null `costUsd` (unpriced). */
  priced: boolean;
  /** True when EVERY record in the row had a null `notionalCostUsd`. */
  notionalPriced: boolean;
  share: number;
}

export interface CostSummary {
  /** Total REAL spend across all records (subscription/self-hosted may be 0). */
  totalUsd: number;
  /**
   * Total NOTIONAL / API-EQUIVALENT value (ListCost / `notional_cost_usd`) across all
   * records — the list-priced estimate, non-zero for a subscription/Teams org whose
   * real spend is $0. NOT money out the door; never called "spend".
   */
  totalNotionalUsd: number;
  /** Which figure the headline leads with (real spend, or equivalent when real is $0). */
  headlineBasis: HeadlineBasis;
  totalTokens: number;
  totalRecords: number;
  totalRuns: number;
  /** Rollup per pricing model, in PRICING_MODELS order (always all three). */
  models: ModelRollup[];
  /** Provider breakdown rows, sorted by dollars desc then tokens desc. */
  providers: ProviderRow[];
  /** Count of records whose REAL-spend basis is honestly `unknown` (null `costUsd`). */
  unpricedRecords: number;
}

/** Roll a flat list of cost records into the dashboard summary. */
export function summarizeCosts(records: readonly CostRecord[]): CostSummary {
  const totalUsd = records.reduce((sum, r) => sum + dollars(r.costUsd), 0);
  const totalNotionalUsd = records.reduce((sum, r) => sum + dollars(r.notionalCostUsd), 0);
  const totalTokens = records.reduce((sum, r) => sum + r.totalTokens, 0);
  const runIds = new Set(records.map((r) => r.runId));

  const models = PRICING_MODELS.map((mode) => {
    const inMode = records.filter((r) => r.billingMode === mode);
    const costUsd = inMode.reduce((sum, r) => sum + dollars(r.costUsd), 0);
    const notionalUsd = inMode.reduce((sum, r) => sum + dollars(r.notionalCostUsd), 0);
    return {
      mode,
      meta: PRICING_MODEL_META[mode],
      costUsd,
      notionalUsd,
      totalTokens: inMode.reduce((sum, r) => sum + r.totalTokens, 0),
      records: inMode.length,
      runs: new Set(inMode.map((r) => r.runId)).size,
      share: totalUsd > 0 ? costUsd / totalUsd : 0,
      notionalShare: totalNotionalUsd > 0 ? notionalUsd / totalNotionalUsd : 0,
    } satisfies ModelRollup;
  });

  const providers = groupProviders(records, totalUsd);

  return {
    totalUsd,
    totalNotionalUsd,
    headlineBasis: pickHeadlineBasis(totalUsd, totalNotionalUsd),
    totalTokens,
    totalRecords: records.length,
    totalRuns: runIds.size,
    models,
    providers,
    unpricedRecords: records.filter((r) => r.costUsd === null).length,
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
    {
      sample: CostRecord;
      runs: Set<string>;
      tokens: number;
      usd: number;
      notionalUsd: number;
      pricedCount: number;
      notionalPricedCount: number;
      count: number;
    }
  >();
  for (const r of records) {
    const key = `${r.cli}|${r.model}|${r.provider}|${r.billingMode}|${r.costBasis}`;
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = {
        sample: r,
        runs: new Set(),
        tokens: 0,
        usd: 0,
        notionalUsd: 0,
        pricedCount: 0,
        notionalPricedCount: 0,
        count: 0,
      };
      byKey.set(key, entry);
    }
    entry.runs.add(r.runId);
    entry.tokens += r.totalTokens;
    entry.usd += dollars(r.costUsd);
    entry.notionalUsd += dollars(r.notionalCostUsd);
    entry.count += 1;
    if (r.costUsd !== null) entry.pricedCount += 1;
    if (r.notionalCostUsd !== null) entry.notionalPricedCount += 1;
  }
  const rows = [...byKey.values()].map(
    (e): ProviderRow => ({
      cli: e.sample.cli,
      model: e.sample.model,
      provider: e.sample.provider,
      billingMode: e.sample.billingMode,
      costBasis: e.sample.costBasis,
      runs: e.runs.size,
      totalTokens: e.tokens,
      costUsd: e.usd,
      notionalUsd: e.notionalUsd,
      priced: e.pricedCount === e.count && e.count > 0,
      notionalPriced: e.notionalPricedCount === e.count && e.count > 0,
      share: totalUsd > 0 ? e.usd / totalUsd : 0,
    }),
  );
  rows.sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
  return rows;
}

// ---------------------------------------------------------------------------
// Burn projection — daily spend series + a simple linear projection. All
// derived from real recordedAt timestamps + priced dollars; no invented data.
// ---------------------------------------------------------------------------

/** One day's buckets — REAL spend and NOTIONAL value, kept side-by-side. */
export interface BurnDay {
  day: string;
  /** REAL spend (BilledCost / `cost_usd`) bucketed to this UTC day. */
  usd: number;
  /** NOTIONAL / API-equivalent value (ListCost / `notional_cost_usd`) for the day. */
  notionalUsd: number;
}

export interface BurnProjection {
  /** Daily REAL + NOTIONAL buckets over the window, oldest → newest. */
  daily: BurnDay[];
  /** Average daily REAL spend across the buckets. */
  dailyAvgUsd: number;
  /** Average daily NOTIONAL value across the buckets. */
  notionalDailyAvgUsd: number;
  /** REAL spend so far this calendar month. */
  monthToDateUsd: number;
  /** NOTIONAL value so far this calendar month. */
  notionalMonthToDateUsd: number;
  /** Linear next-30d REAL projection (dailyAvg × 30), rounded to cents. An ESTIMATE. */
  projected30dUsd: number;
  /** Linear next-30d NOTIONAL projection (notionalDailyAvg × 30). An ESTIMATE. */
  projectedNotional30dUsd: number;
  /**
   * Run-rate projection of REAL spend to the END of the current calendar month
   * (month-to-date + dailyAvg × remaining days). An honestly-labeled linear ESTIMATE.
   */
  projectedRealMonthEndUsd: number;
  /** Same run-rate projection over NOTIONAL value. An honestly-labeled ESTIMATE. */
  projectedNotionalMonthEndUsd: number;
  /** Whole UTC days left in the current calendar month (today counts as remaining). */
  daysLeftInMonth: number;
  /** Number of days with at least one priced (real OR notional) record. */
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
 * (dailyAvg × 30) — deliberately simple for v0.
 */
export function projectBurn(
  records: readonly CostRecord[],
  opts: { now?: Date; windowDays?: number } = {},
): BurnProjection {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 14;
  const buckets = new Map<string, { usd: number; notionalUsd: number }>();
  for (let i = windowDays - 1; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    buckets.set(d.toISOString().slice(0, 10), { usd: 0, notionalUsd: 0 });
  }
  let monthToDateUsd = 0;
  let notionalMonthToDateUsd = 0;
  const monthPrefix = now.toISOString().slice(0, 7);
  const activeDaySet = new Set<string>();
  for (const r of records) {
    const usd = dollars(r.costUsd);
    const notionalUsd = dollars(r.notionalCostUsd);
    // A row with NO priced figure on either axis contributes nothing to the burn.
    if (usd <= 0 && notionalUsd <= 0) continue;
    const key = dayKey(r.recordedAt);
    const bucket = buckets.get(key);
    if (bucket !== undefined) {
      bucket.usd += usd;
      bucket.notionalUsd += notionalUsd;
      activeDaySet.add(key);
    }
    if (key.startsWith(monthPrefix)) {
      monthToDateUsd += usd;
      notionalMonthToDateUsd += notionalUsd;
    }
  }
  const daily = [...buckets.entries()].map(([day, b]) => ({ day, usd: b.usd, notionalUsd: b.notionalUsd }));
  const total = daily.reduce((sum, d) => sum + d.usd, 0);
  const notionalTotal = daily.reduce((sum, d) => sum + d.notionalUsd, 0);
  const dailyAvgUsd = daily.length > 0 ? total / daily.length : 0;
  const notionalDailyAvgUsd = daily.length > 0 ? notionalTotal / daily.length : 0;

  // Run-rate to month end: month-to-date + the daily average over the days that
  // REMAIN in the calendar month (today inclusive). A flat linear estimate — labeled
  // as such in the view; we never imply a confidence interval.
  const daysLeftInMonth = utcDaysLeftInMonth(now);
  return {
    daily,
    dailyAvgUsd,
    notionalDailyAvgUsd,
    monthToDateUsd,
    notionalMonthToDateUsd,
    projected30dUsd: Math.round(dailyAvgUsd * 30 * 100) / 100,
    projectedNotional30dUsd: Math.round(notionalDailyAvgUsd * 30 * 100) / 100,
    projectedRealMonthEndUsd: Math.round((monthToDateUsd + dailyAvgUsd * daysLeftInMonth) * 100) / 100,
    projectedNotionalMonthEndUsd:
      Math.round((notionalMonthToDateUsd + notionalDailyAvgUsd * daysLeftInMonth) * 100) / 100,
    daysLeftInMonth,
    activeDays: activeDaySet.size,
  };
}

/** Whole UTC days remaining in `now`'s calendar month, today inclusive (≥ 0). */
function utcDaysLeftInMonth(now: Date): number {
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return Math.max(0, daysInMonth - now.getUTCDate() + 1);
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

const MERGED_OUTCOMES = new Set(["phase1_fixture_complete", "phase2_easy_complete", "phase2_medium_complete"]);
const HALTED_OUTCOMES = new Set(["halted", "escape_hatch_hit", "retry_budget_exhausted"]);

/**
 * Observed run metrics for the reported-not-targeted panel. `merged` is keyed
 * on the completion outcomes; halt-rate on the escape-hatch family.
 * Cost-per-merged divides total priced spend by the merged-run count.
 */
export function observeMetrics(runs: readonly { outcome: string | null }[], totalPricedUsd: number): ObservedMetrics {
  const specsMerged = runs.filter((r) => r.outcome !== null && MERGED_OUTCOMES.has(r.outcome)).length;
  const halted = runs.filter((r) => r.outcome !== null && HALTED_OUTCOMES.has(r.outcome)).length;
  return {
    specsMerged,
    avgCostPerMergedUsd: specsMerged > 0 ? totalPricedUsd / specsMerged : null,
    haltRate: runs.length > 0 ? halted / runs.length : 0,
    totalRuns: runs.length,
  };
}
