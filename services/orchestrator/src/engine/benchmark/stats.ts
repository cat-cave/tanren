// Small, self-contained nonparametric statistics for the benchmark (§3.2). The
// data is small-N, non-normal, and some metrics are bounded ([0,1] CFR-like),
// so we deliberately AVOID t-tests/normal assumptions: a percentile bootstrap
// CI for dispersion and Mann–Whitney U for a two-sample comparison. Both are
// well-understood and implemented directly — no heavy stats dependency.
//
// Determinism: the bootstrap resampler takes an injectable RNG (default a
// seeded LCG) so a scorecard recomputes identically — a benchmark result must
// be reproducible from its inputs, not vary run-to-run.

/** A deterministic [0,1) generator. */
export type Rng = () => number;

/**
 * A small seeded LCG (mulberry32). Good enough for bootstrap resampling and,
 * crucially, deterministic — the same seed yields the same CI every time.
 */
export function seededRng(seed: number): Rng {
  // The `>>> 0` / `| 0` here are intentional 32-bit wraparound (the mulberry32
  // contract), NOT integer truncation — Math.trunc would not wrap and would
  // break the generator. (The lint heuristic that suggests Math.trunc here is a
  // non-blocking warning; the bitwise form is required.)
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function percentile(sorted: readonly number[], p: number): number {
  // Linear interpolation between order statistics (sorted ascending).
  if (sorted.length === 1) return sorted[0]!;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

export interface ConfidenceInterval {
  /** Median (point estimate) of the sample. */
  point: number | null;
  /** Lower bound of the (1 - alpha) CI. */
  lower: number | null;
  /** Upper bound of the (1 - alpha) CI. */
  upper: number | null;
  /** Sample size the figure was computed from. */
  sample: number;
}

export interface BootstrapOptions {
  /** Resample count (default 2000 — plenty for a percentile CI at small N). */
  iterations?: number;
  /** Two-sided alpha (default 0.05 → a 95% CI). */
  alpha?: number;
  rng?: Rng;
}

/**
 * Percentile bootstrap CI for the MEDIAN of a sample. Resamples WITH
 * replacement `iterations` times, takes each resample's median, and reads the
 * alpha/2 and 1-alpha/2 percentiles of that bootstrap distribution. Empty
 * sample → all-null (honest). N=1 → a degenerate point CI [x,x].
 */
export function bootstrapMedianCI(values: readonly number[], options: BootstrapOptions = {}): ConfidenceInterval {
  const sample = values.length;
  if (sample === 0) return { point: null, lower: null, upper: null, sample: 0 };
  const point = median(values)!;
  if (sample === 1) return { point, lower: point, upper: point, sample };

  const iterations = options.iterations ?? 2000;
  const alpha = options.alpha ?? 0.05;
  const rng = options.rng ?? seededRng(0x9e_37_79_b9);

  const medians: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const resample: number[] = [];
    for (let j = 0; j < sample; j += 1) {
      resample.push(values[Math.floor(rng() * sample)]!);
    }
    medians.push(median(resample)!);
  }
  medians.sort((a, b) => a - b);
  return {
    point,
    lower: percentile(medians, alpha / 2),
    upper: percentile(medians, 1 - alpha / 2),
    sample,
  };
}

export interface MannWhitneyResult {
  /** The U statistic (min of U_a, U_b). */
  u: number;
  /** Normal-approximation two-sided p-value (tie-corrected). */
  pValue: number;
  /** Rank-biserial effect size in [-1, 1]: 0 = no effect, ±1 = full separation. */
  effectSize: number;
  nA: number;
  nB: number;
}

/**
 * Mann–Whitney U (Wilcoxon rank-sum) two-sided test with a tie-corrected
 * normal approximation and a rank-biserial effect size. Nonparametric — no
 * normality assumption (§3.2). For very small N the normal-approximation
 * p-value is conservative; the effect size + the bootstrap CI overlap are the
 * primary signal, the p-value a secondary guard. Returns p=1 / effect=0 when
 * either sample is empty (no comparison possible).
 */
export function mannWhitneyU(a: readonly number[], b: readonly number[]): MannWhitneyResult {
  const nA = a.length;
  const nB = b.length;
  if (nA === 0 || nB === 0) return { u: 0, pValue: 1, effectSize: 0, nA, nB };

  // Pooled mid-ranks.
  const pooled = [...a.map((v) => ({ v, group: "a" as const })), ...b.map((v) => ({ v, group: "b" as const }))].sort(
    (x, y) => x.v - y.v,
  );
  const ranks = Array.from<number>({ length: pooled.length });
  const tieGroupSizes: number[] = [];
  let i = 0;
  while (i < pooled.length) {
    let j = i;
    while (j + 1 < pooled.length && pooled[j + 1]!.v === pooled[i]!.v) j += 1;
    // Average rank for the tie block [i, j] (ranks are 1-based).
    const avgRank = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k += 1) ranks[k] = avgRank;
    if (j > i) tieGroupSizes.push(j - i + 1);
    i = j + 1;
  }

  let rankSumA = 0;
  for (let k = 0; k < pooled.length; k += 1) {
    if (pooled[k]!.group === "a") rankSumA += ranks[k]!;
  }
  const uA = rankSumA - (nA * (nA + 1)) / 2;
  const uB = nA * nB - uA;
  const u = Math.min(uA, uB);

  // Tie-corrected variance for the normal approximation.
  const n = nA + nB;
  const tieCorrection = tieGroupSizes.reduce((acc, t) => acc + (t ** 3 - t), 0);
  const meanU = (nA * nB) / 2;
  const varU = ((nA * nB) / 12) * (n + 1 - tieCorrection / (n * (n - 1)));
  let pValue = 1;
  if (varU > 0) {
    // Continuity-corrected z.
    const z = (Math.abs(u - meanU) - 0.5) / Math.sqrt(varU);
    pValue = Math.min(1, 2 * (1 - normalCdf(z)));
  }

  // Rank-biserial effect size: signed so a>b reads positive.
  const effectSize = (uA - uB) / (nA * nB);
  return { u, pValue, effectSize, nA, nB };
}

/** Standard-normal CDF via the Abramowitz–Stegun erf approximation. */
function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26 — max error ~1.5e-7, ample for a p-value guard.
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.327_591_1 * ax);
  const y =
    1 -
    ((((1.061_405_429 * t - 1.453_152_027) * t + 1.421_413_741) * t - 0.284_496_736) * t + 0.254_829_592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}
