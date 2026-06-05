// Cross-trial aggregation reducers (docs/roadmap/tanren-method-benchmark.md
// §3.2, §4.2.3). Pure, in the spirit of `deriveDoraMetrics`:
//
//   - `deriveCellScorecard(trials[])` → per-metric median + bootstrap CI across
//     a cell's trials, flagging "CI too wide to call" when dispersion is high.
//   - `compareCells(cellA, cellB)` → per-metric diff-of-medians + Mann–Whitney
//     U + effect size, and a winner/no-call/regression verdict — REFUSING the
//     comparison if the cells differ in more than one knob (§3.3).
//
// Thin DB loaders that materialize a cell's TrialScorecards live in
// scorecard.ts (`loadTrialScorecard` per run); these reducers take the already-
// projected scorecards so they stay pure + unit-testable.

import { z } from "zod";
import type { TrialScorecard } from "./scorecard.js";
import { type ConfidenceInterval, bootstrapMedianCI, median, mannWhitneyU } from "./stats.js";

// ---- The numeric metrics we aggregate across trials -----------------------

// Each metric: a label, an extractor (a trial → number | null; null drops the
// trial from THAT metric's sample, e.g. a non-merged trial has no lead time),
// whether LOWER is better (drives the verdict direction), and whether it is
// bounded [0,1] (CFR-like — affects the "too wide" heuristic).
interface MetricDef {
  key: string;
  extract: (t: TrialScorecard) => number | null;
  lowerIsBetter: boolean;
  bounded01: boolean;
}

// `mergeSuccessRate` (§2.1 reframed deploy-frequency) and `acceptGreenRate` are
// cell-level proportions, derived separately below — not per-trial extractors.
const METRICS: readonly MetricDef[] = [
  { key: "leadTimeSeconds", extract: (t) => t.leadTimeSeconds, lowerIsBetter: true, bounded01: false },
  { key: "activeExecutionSeconds", extract: (t) => t.activeExecutionSeconds, lowerIsBetter: true, bounded01: false },
  { key: "plannerReruns", extract: (t) => t.plannerReruns, lowerIsBetter: true, bounded01: false },
  { key: "writerIterations", extract: (t) => t.writerIterations, lowerIsBetter: true, bounded01: false },
  { key: "gateFailures", extract: (t) => t.gateFailures, lowerIsBetter: true, bounded01: false },
  { key: "reviewIterations", extract: (t) => t.reviewIterations, lowerIsBetter: true, bounded01: false },
  { key: "auditedConcerns", extract: (t) => t.auditedConcerns, lowerIsBetter: true, bounded01: false },
  { key: "totalTokens", extract: (t) => t.tokens.total, lowerIsBetter: true, bounded01: false },
  { key: "costUsd", extract: (t) => t.costUsd, lowerIsBetter: true, bounded01: false },
];

// ---- deriveCellScorecard --------------------------------------------------

export const CellMetricFigure = z
  .object({
    point: z.number().nullable(),
    lower: z.number().nullable(),
    upper: z.number().nullable(),
    sample: z.number().int().nonnegative(),
    /** True when the CI is too wide relative to the point to call (§3.2). */
    tooWideToCall: z.boolean(),
  })
  .strict();
export type CellMetricFigure = z.infer<typeof CellMetricFigure>;

export const CellScorecard = z
  .object({
    cellId: z.string().min(1).nullable(),
    trials: z.number().int().nonnegative(),
    /** Per-metric median + bootstrap CI, keyed by metric name. */
    metrics: z.record(z.string(), CellMetricFigure),
    /** merges / attempts in the cell (§2.1 reframed deploy frequency). */
    mergeSuccessRate: z.number().min(0).max(1).nullable(),
    /** post-merge hidden-accept-green / evaluated trials (§2.1). Null if none. */
    acceptGreenRate: z.number().min(0).max(1).nullable(),
  })
  .strict();
export type CellScorecard = z.infer<typeof CellScorecard>;

export interface DeriveCellOptions {
  /** Bootstrap iterations (default 2000). */
  iterations?: number;
  /** Two-sided alpha (default 0.05). */
  alpha?: number;
  /**
   * "Too wide to call" trips when the CI half-width exceeds this fraction of
   * the point estimate (default 0.5 = CI wider than the median itself). For a
   * bounded [0,1] metric the absolute half-width is used against this fraction.
   */
  tooWideRatio?: number;
}

const MERGED_STATUSES = new Set(["completed"]);

function toFigure(ci: ConfidenceInterval, def: MetricDef, tooWideRatio: number): CellMetricFigure {
  let tooWideToCall = false;
  if (ci.point !== null && ci.lower !== null && ci.upper !== null && ci.sample > 1) {
    const halfWidth = (ci.upper - ci.lower) / 2;
    const denom = def.bounded01 ? 1 : Math.abs(ci.point);
    // A zero-point unbounded metric with any spread is uncallable; a tight
    // exact-zero CI (lower==upper==0) is callable.
    tooWideToCall = denom === 0 ? halfWidth > 0 : halfWidth > tooWideRatio * denom;
  }
  return { point: ci.point, lower: ci.lower, upper: ci.upper, sample: ci.sample, tooWideToCall };
}

/**
 * Reduce a cell's trial scorecards to per-metric median + bootstrap CI plus the
 * cell-level merge-success and accept-green proportions. Pure: the same trials
 * (and default seeded RNG) always yield the same scorecard.
 */
export function deriveCellScorecard(trials: readonly TrialScorecard[], options: DeriveCellOptions = {}): CellScorecard {
  const iterations = options.iterations ?? 2000;
  const alpha = options.alpha ?? 0.05;
  const tooWideRatio = options.tooWideRatio ?? 0.5;

  const metrics: Record<string, CellMetricFigure> = {};
  for (const def of METRICS) {
    const sample = trials.map((t) => def.extract(t)).filter((v): v is number => v !== null);
    const ci = bootstrapMedianCI(sample, { iterations, alpha });
    metrics[def.key] = toFigure(ci, def, tooWideRatio);
  }

  const mergeSuccessRate =
    trials.length === 0
      ? null
      : trials.filter((t) => MERGED_STATUSES.has(t.terminalStatus ?? "")).length / trials.length;

  const evaluated = trials.filter((t) => t.reachedAcceptGreen !== null);
  const acceptGreenRate =
    evaluated.length === 0 ? null : evaluated.filter((t) => t.reachedAcceptGreen === true).length / evaluated.length;

  return CellScorecard.parse({
    cellId: trials[0]?.cellId ?? null,
    trials: trials.length,
    metrics,
    mergeSuccessRate,
    acceptGreenRate,
  });
}

// ---- compareCells ---------------------------------------------------------

export const ComparisonVerdict = z.enum(["winner_a", "winner_b", "no_call", "regression"]);
export type ComparisonVerdict = z.infer<typeof ComparisonVerdict>;

export const MetricComparison = z
  .object({
    /** medianA - medianB (in the metric's native unit). Null if either empty. */
    diffOfMedians: z.number().nullable(),
    medianA: z.number().nullable(),
    medianB: z.number().nullable(),
    /** Mann–Whitney two-sided p-value (tie-corrected normal approx). */
    pValue: z.number(),
    /** Rank-biserial effect size in [-1, 1] (positive ⇒ A's values run higher). */
    effectSize: z.number(),
    /** Whether lower values are better for this metric (verdict direction). */
    lowerIsBetter: z.boolean(),
    /** Per-metric verdict (§3.2 winner / no-call / regression). */
    verdict: ComparisonVerdict,
  })
  .strict();
export type MetricComparison = z.infer<typeof MetricComparison>;

export const CellComparison = z
  .object({
    /** Per-metric comparison keyed by metric name. */
    metrics: z.record(z.string(), MetricComparison),
    nA: z.number().int().nonnegative(),
    nB: z.number().int().nonnegative(),
  })
  .strict();
export type CellComparison = z.infer<typeof CellComparison>;

export interface CompareCellsOptions {
  /** Significance threshold for the Mann–Whitney p-value (default 0.05). */
  pThreshold?: number;
  /** Min |effectSize| to call a winner (default 0.3 — a medium rank-biserial). */
  minEffectSize?: number;
}

export class OneKnobViolationError extends Error {
  constructor(public readonly differingKeys: readonly string[]) {
    super(
      `cells differ in more than one knob (${differingKeys.join(", ")}); a comparison with >1 varying dimension is malformed (§3.3) and is refused`,
    );
    this.name = "OneKnobViolationError";
  }
}

// The frozen-config dimensions the one-knob invariant checks. Each maps a
// FrozenConfig to a canonical string so "differs" is a stable equality test.
const CONFIG_DIMENSIONS = ["routing", "escapeHatches", "ciTiers", "governance", "mergeIntegration"] as const;

/**
 * The §3.3 one-knob invariant: two comparable cells may differ in EXACTLY one
 * frozen-config dimension. Returns the set of differing dimensions so the caller
 * can refuse (>1) or record which knob is under test (==1). Order-independent
 * via canonical JSON of each dimension.
 */
export function differingKnobs(configA: Record<string, unknown>, configB: Record<string, unknown>): string[] {
  const differing: string[] = [];
  for (const dim of CONFIG_DIMENSIONS) {
    if (JSON.stringify(configA[dim] ?? null) !== JSON.stringify(configB[dim] ?? null)) {
      differing.push(dim);
    }
  }
  return differing;
}

function metricVerdict(
  cmp: { diffOfMedians: number | null; pValue: number; effectSize: number },
  def: MetricDef,
  pThreshold: number,
  minEffectSize: number,
): ComparisonVerdict {
  if (cmp.diffOfMedians === null) return "no_call";
  const significant = cmp.pValue <= pThreshold && Math.abs(cmp.effectSize) >= minEffectSize;
  if (!significant) return "no_call";
  // effectSize > 0 ⇒ A's values run HIGHER than B's. "Better" depends on
  // direction: for a lower-is-better metric, A higher ⇒ A worse ⇒ B wins.
  const aIsHigher = cmp.effectSize > 0;
  const aIsBetter = def.lowerIsBetter ? !aIsHigher : aIsHigher;
  return aIsBetter ? "winner_a" : "winner_b";
}

/**
 * Compare two cells' trial scorecards: per-metric diff-of-medians + Mann–Whitney
 * U + effect size + a winner/no-call verdict. The optional frozen configs ENFORCE
 * the §3.3 one-knob invariant — passing both configs makes the comparison REFUSE
 * (throw `OneKnobViolationError`) when they differ in >1 dimension. Omit the
 * configs to skip the guard (e.g. comparing already-validated cells).
 *
 * "regression" is a verdict the CALLER assigns by orienting A=baseline, B=change
 * and reading per-metric `winner_a` on a tracked metric; this reducer reports
 * the symmetric `winner_a`/`winner_b`/`no_call` and leaves regression framing to
 * the report surface (a follow-up).
 */
export function compareCells(
  trialsA: readonly TrialScorecard[],
  trialsB: readonly TrialScorecard[],
  options: CompareCellsOptions & {
    configA?: Record<string, unknown>;
    configB?: Record<string, unknown>;
  } = {},
): CellComparison {
  if (options.configA !== undefined && options.configB !== undefined) {
    const differing = differingKnobs(options.configA, options.configB);
    if (differing.length > 1) throw new OneKnobViolationError(differing);
  }

  const pThreshold = options.pThreshold ?? 0.05;
  const minEffectSize = options.minEffectSize ?? 0.3;

  const metrics: Record<string, MetricComparison> = {};
  for (const def of METRICS) {
    const sampleA = trialsA.map((t) => def.extract(t)).filter((v): v is number => v !== null);
    const sampleB = trialsB.map((t) => def.extract(t)).filter((v): v is number => v !== null);
    const medianA = median(sampleA);
    const medianB = median(sampleB);
    const diffOfMedians = medianA === null || medianB === null ? null : medianA - medianB;
    const mw = mannWhitneyU(sampleA, sampleB);
    const verdict = metricVerdict(
      { diffOfMedians, pValue: mw.pValue, effectSize: mw.effectSize },
      def,
      pThreshold,
      minEffectSize,
    );
    metrics[def.key] = {
      diffOfMedians,
      medianA,
      medianB,
      pValue: mw.pValue,
      effectSize: mw.effectSize,
      lowerIsBetter: def.lowerIsBetter,
      verdict,
    };
  }

  return CellComparison.parse({ metrics, nA: trialsA.length, nB: trialsB.length });
}
