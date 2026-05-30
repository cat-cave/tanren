/**
 * P3-0018 subscription-window utilization heatmap — pure aggregation. Derives a
 * 30-day × 5-window fill matrix (+ per-window average fill) from the SAME
 * P2A-0011 cost records the costs dashboard already gathers. No new data
 * collection, no migration: we read records whose `billingMode === "subscription"`
 * — the server-enforced subscription windows (chatgpt / claude / zai bundles) —
 * and bucket their token volume by when it was recorded.
 *
 * ## How "fill" is derived from existing data
 *
 * A subscription credential bills against a rolling, server-enforced window
 * (PROJECT_BRIEF §4.3) — there is no per-call dollar basis and we never store a
 * hard token cap, so an absolute "% of cap" would be fabricated. What we DO have
 * is the token volume of every subscription call and its `recordedAt`. So fill
 * is a RELATIVE utilization: for each (day × 5-hour-window) cell we sum the
 * subscription tokens recorded in it, then normalize against the busiest cell in
 * the grid. Fill 1.0 = the window you filled hardest; fill ~0 = a window you
 * paid for and barely touched. The pattern (dark night/evening cells) is the
 * honest signal — it shows where the engine could run harder on capacity already
 * paid for, which is exactly what the "schedule overnight audits" affordance acts
 * on. Empty grid (no subscription records) → all zeros, never invented data.
 */

import type { CostRecord } from "../../api/types.js";

/** Days of history the heatmap spans (matches the hi-fi 30-day grid). */
export const HEATMAP_DAYS = 30;

/** The five fixed daily 5-hour windows, in row order (top → bottom). */
export const WINDOW_LABELS: readonly { range: string; sub: string }[] = [
  { range: "00 – 05", sub: "night" },
  { range: "05 – 10", sub: "morning" },
  { range: "10 – 15", sub: "midday" },
  { range: "15 – 20", sub: "afternoon" },
  { range: "20 – 00", sub: "evening" },
];

/** Number of windows per day (5 × ~5-hour bands covering 24h). */
export const WINDOW_COUNT = WINDOW_LABELS.length;

/** Hours per window band. */
const WINDOW_HOURS = 24 / WINDOW_COUNT;

/** A single heatmap cell: its fill [0,1] and the raw tokens behind it. */
export interface HeatmapCell {
  /** Normalized utilization in [0,1] (cell tokens / peak cell tokens). */
  fill: number;
  /** Raw subscription tokens recorded in this cell. */
  tokens: number;
}

/** A per-window row: 30 day-cells + the row's average fill [0,1]. */
export interface HeatmapRow {
  /** Window band label, e.g. "00 – 05". */
  range: string;
  /** Window sub-label, e.g. "night". */
  sub: string;
  /** 30 cells, oldest day → newest (today is the last cell). */
  cells: HeatmapCell[];
  /** Mean fill across the 30 day-cells, in [0,1]. */
  avgFill: number;
}

export interface HeatmapMatrix {
  /** Five window rows, top (night) → bottom (evening). */
  rows: HeatmapRow[];
  /** ISO day key (YYYY-MM-DD) for each of the 30 columns, oldest → newest. */
  dayKeys: string[];
  /** Total subscription records that landed inside the 30-day window. */
  records: number;
  /** Total subscription tokens across the grid. */
  totalTokens: number;
  /** Peak single-cell token volume (the normalization basis). */
  peakCellTokens: number;
  /** True when no subscription records fell in the window (render empty state). */
  empty: boolean;
}

/** Which 5-hour window band (0..4) a UTC hour falls in. */
function windowIndex(hour: number): number {
  const idx = Math.floor(hour / WINDOW_HOURS);
  return Math.min(WINDOW_COUNT - 1, Math.max(0, idx));
}

/** UTC day key (YYYY-MM-DD); empty string when the stamp is unparseable. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/**
 * Build the 30-day × 5-window subscription utilization matrix from cost
 * records. Only `billingMode === "subscription"` records inside the trailing
 * `HEATMAP_DAYS` window (ending at `now`, UTC days) contribute; everything else
 * is ignored. Fill is each cell's tokens normalized against the busiest cell.
 */
export function buildHeatmap(records: readonly CostRecord[], opts: { now?: Date } = {}): HeatmapMatrix {
  const now = opts.now ?? new Date();

  // The 30 UTC day keys, oldest → newest (today last), and a key → column map.
  const dayKeys: string[] = [];
  const columnOf = new Map<string, number>();
  for (let i = HEATMAP_DAYS - 1; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    columnOf.set(key, dayKeys.length);
    dayKeys.push(key);
  }

  // tokenGrid[window][day] accumulates subscription token volume.
  const tokenGrid: number[][] = WINDOW_LABELS.map(() => Array.from({ length: HEATMAP_DAYS }, () => 0));
  let recordCount = 0;
  let totalTokens = 0;
  let peakCellTokens = 0;

  for (const r of records) {
    if (r.billingMode !== "subscription") continue;
    const key = dayKey(r.recordedAt);
    const col = columnOf.get(key);
    // outside the 30-day window
    if (col === undefined) continue;
    const cellRow = tokenGrid[windowIndex(new Date(r.recordedAt).getUTCHours())];
    if (cellRow === undefined) continue;
    const tokens = Number.isFinite(r.totalTokens) && r.totalTokens > 0 ? r.totalTokens : 0;
    const next = (cellRow[col] ?? 0) + tokens;
    cellRow[col] = next;
    recordCount += 1;
    totalTokens += tokens;
    if (next > peakCellTokens) peakCellTokens = next;
  }

  const rows: HeatmapRow[] = WINDOW_LABELS.map((label, w) => {
    const tokenRow = tokenGrid[w] ?? [];
    const cells: HeatmapCell[] = tokenRow.map((tokens) => ({
      tokens,
      fill: peakCellTokens > 0 ? tokens / peakCellTokens : 0,
    }));
    const avgFill = cells.length > 0 ? cells.reduce((s, c) => s + c.fill, 0) / cells.length : 0;
    return { range: label.range, sub: label.sub, cells, avgFill };
  });

  return {
    rows,
    dayKeys,
    records: recordCount,
    totalTokens,
    peakCellTokens,
    empty: recordCount === 0,
  };
}

/**
 * The windows whose average fill is below `threshold` (default 0.30) — the
 * use-it-or-lose-it headroom that the "schedule overnight audits" affordance
 * targets. Returned in row order so the body can name them in the pattern line.
 */
export function underfilledWindows(matrix: HeatmapMatrix, threshold = 0.3): HeatmapRow[] {
  return matrix.rows.filter((row) => row.avgFill < threshold);
}
