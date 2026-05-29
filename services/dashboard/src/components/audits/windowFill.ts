/**
 * P3-0021 window-fill bar data — derives the per-window fill columns from the
 * P3-0018 subscription-window heatmap (reads existing data; no new collection).
 * Each column is one of the five 5-hour windows with its avg fill % and a
 * status tier (lo < 30% / mid / hi ≥ 70%), exactly the cost-view idle-window
 * story the audits surface ties into.
 */

import type { HeatmapMatrix } from "../costs/heatmap.js";

export interface WindowFillColumn {
  label: string;
  pct: number;
  tier: "lo" | "mid" | "hi";
}

function tierOf(fill: number): WindowFillColumn["tier"] {
  if (fill >= 0.7) return "hi";
  if (fill >= 0.3) return "mid";
  return "lo";
}

/** The five window columns from a heatmap matrix, in clock order. */
export function windowFillColumns(matrix: HeatmapMatrix): WindowFillColumn[] {
  return matrix.rows.map((row) => ({
    label: row.sub,
    pct: Math.round(row.avgFill * 100),
    tier: tierOf(row.avgFill)
  }));
}

/** The names of the under-30%-filled windows (drives the "why schedule" pitch). */
export function underfilledNames(columns: ReadonlyArray<WindowFillColumn>): string[] {
  return columns.filter((c) => c.tier === "lo").map((c) => c.label);
}
