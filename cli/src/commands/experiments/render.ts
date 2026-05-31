// Pure table renderers for `tanren experiments report` / `compare`. The CLI is a
// standalone package (no engine import), so these operate on the JSON response
// shapes the orchestrator returns: a cell `CellScorecard` (median + bootstrap CI
// per metric) and a `CellComparison` (diff-of-medians + nonparametric test +
// effect size + winner/no-call/regression verdict). Pure string builders — no IO
// — so they are unit-testable by value.

export interface MetricFigure {
  point: number | null;
  lower: number | null;
  upper: number | null;
  sample: number;
  tooWideToCall: boolean;
}

export interface CellScorecard {
  cellId: string | null;
  trials: number;
  metrics: Record<string, MetricFigure>;
  mergeSuccessRate: number | null;
  acceptGreenRate: number | null;
}

export interface MetricComparison {
  diffOfMedians: number | null;
  medianA: number | null;
  medianB: number | null;
  pValue: number;
  effectSize: number;
  lowerIsBetter: boolean;
  verdict: string;
}

export interface CellComparison {
  metrics: Record<string, MetricComparison>;
  nA: number;
  nB: number;
}

function fmt(value: number | null): string {
  if (value === null) return "—";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3);
}

function row(cells: readonly string[], widths: readonly number[]): string {
  return cells
    .map((cell, i) => cell.padEnd(widths[i] ?? 0))
    .join("  ")
    .trimEnd();
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const lines = [row(headers, widths), row(headers.map((_, i) => "-".repeat(widths[i] ?? 0)), widths)];
  for (const r of rows) lines.push(row(r, widths));
  return lines.join("\n");
}

/** Render a cell scorecard as a per-metric median + 95% CI table. */
export function renderCellScorecard(scorecard: CellScorecard): string {
  const head = `cell ${scorecard.cellId ?? "—"} · trials=${scorecard.trials} · merge_success=${fmt(scorecard.mergeSuccessRate)} · accept_green=${fmt(scorecard.acceptGreenRate)}`;
  const rows = Object.entries(scorecard.metrics).map(([key, m]) => [
    key,
    fmt(m.point),
    `[${fmt(m.lower)}, ${fmt(m.upper)}]`,
    String(m.sample),
    m.tooWideToCall ? "too-wide" : "",
  ]);
  return `${head}\n${table(["metric", "median", "95% CI", "n", "flag"], rows)}`;
}

const VERDICT_LABEL: Record<string, string> = {
  winner_a: "A wins",
  winner_b: "B wins",
  no_call: "no call",
  regression: "regression",
};

/**
 * Render a cell-vs-cell comparison: per-metric diff-of-medians + Mann–Whitney p +
 * effect size + the winner/no-call/regression verdict. The cell ids label A vs B
 * so the operator can orient baseline→change for a regression read.
 */
export function renderCellComparison(comparison: CellComparison, cellA: string, cellB: string): string {
  const head = `A=${cellA} (n=${comparison.nA})  vs  B=${cellB} (n=${comparison.nB})`;
  const rows = Object.entries(comparison.metrics).map(([key, m]) => [
    key,
    `${fmt(m.medianA)} vs ${fmt(m.medianB)}`,
    fmt(m.diffOfMedians),
    m.pValue.toFixed(4),
    m.effectSize.toFixed(3),
    m.lowerIsBetter ? "lower" : "higher",
    VERDICT_LABEL[m.verdict] ?? m.verdict,
  ]);
  return `${head}\n${table(["metric", "A vs B", "diff", "p", "effect", "better", "verdict"], rows)}`;
}
