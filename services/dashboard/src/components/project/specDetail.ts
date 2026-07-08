/**
 * Spec-detail model — shapes the spec drawer + full page from the
 * orchestrator primitives (spec + its dependency edges + run history). Pure +
 * I/O-free so the route handler stays thin and the derivation is testable.
 *
 * Economics doctrine: uncomputable figures render as "—", never a fake $0.00.
 * `costTotalUsd` arrives as a string (often "0" when no priced records exist);
 * only strictly-positive finite amounts count as real spend.
 */

import { RECOVERABLE_OUTCOMES } from "@tanren/db";
import type { DagStatus } from "../../api/projectDag.js";
import type { RunListItem, SpecSummary } from "../../api/types.js";

export interface SpecRunRow {
  runId: string;
  outcome: string;
  status: string;
  /** ISO stamp for the run's most recent activity (started / last event). */
  when: string;
  /**
   * Display cost for this run: `"$12.50"` when a positive priced total exists,
   * otherwise `"—"` (unpriced / uncomputable — never a fabricated `$0.00`).
   */
  costLabel: string;
  href: string | null;
  live: boolean;
}

export interface SpecDepChip {
  specId: string;
  title: string;
  status: DagStatus;
}

/** Economics figures for the full-page panel (and the lighter drawer strip). */
export interface SpecEconomics {
  /**
   * Known real spend (`"$12.50"`) summed over priced attempts only, or `"—"`
   * when no attempt has a positive priced total. Never invents $0 for unpriced
   * runs. When `unpricedAttempts > 0` this is a known-lower-bound, not a
   * complete total — the panel surfaces that.
   */
  spendUsd: string;
  /** Attempt count, or `"—"` when runs are unavailable / empty. */
  attempts: string;
  /**
   * Average over **priced** attempts only, or `"—"`. Unpriced attempts are
   * excluded from both numerator and denominator (not treated as $0).
   */
  avgCostUsd: string;
  /** How many runs contributed a positive priced total. */
  pricedAttempts: number;
  /** How many runs had no priced total (unpriced / `"0"` / unparseable). */
  unpricedAttempts: number;
}

export interface SpecDetail {
  specId: string;
  projectId: string;
  title: string;
  description: string;
  status: DagStatus;
  /** Human status label ("merged"/"forging"/"review-ready"/"blocked"/"queued"). */
  statusLabel: string;
  pill: "ok" | "run" | "warn" | "fail" | "cold";
  glyph: string;
  acceptance: string[];
  dependsOn: SpecDepChip[];
  blocks: SpecDepChip[];
  runs: SpecRunRow[];
  /**
   * False when the run-list orchestrator read failed. Panels must show
   * "unavailable" rather than empty/zero figures.
   */
  runsAvailable: boolean;
  latestRun: SpecRunRow | null;
  /** A short "why blocked" line when the spec is blocked, else null. */
  blockedReason: string | null;
  /** Spend to date — mirrors `economics.spendUsd` for the drawer strip. */
  spendUsd: string;
  economics: SpecEconomics;
  /** Primary action route per status, or null (queued/blocked handled inline). */
  primaryAction: { label: string; href: string } | null;
}

const STATUS_META: Record<DagStatus, { label: string; pill: SpecDetail["pill"]; glyph: string }> = {
  done: { label: "merged", pill: "ok", glyph: "✓" },
  live: { label: "forging", pill: "run", glyph: "↻" },
  review: { label: "review-ready", pill: "warn", glyph: "!" },
  blocked: { label: "blocked", pill: "fail", glyph: "⏳" },
  queued: { label: "queued", pill: "cold", glyph: "○" },
};

// HALTED-outcome policy set imported from @tanren/db — the prior private copy
// was missing `convergence_stalled` + `window_exhausted`, so a spec whose latest
// run halted for those reasons did not colour blocked in the drawer.

function statusForSpec(specStatus: string, latest: RunListItem | undefined): DagStatus {
  if (latest !== undefined) {
    if (latest.needsReview) return "review";
    if (latest.status === "running") return "live";
    if (latest.outcome !== null && RECOVERABLE_OUTCOMES.has(latest.outcome)) return "blocked";
    if (latest.status === "completed") return "done";
    if (latest.status === "queued") return "queued";
  }
  const s = specStatus.toLowerCase();
  if (s === "merged") return "done";
  if (s === "in_flight" || s === "running") return "live";
  if (s === "review") return "review";
  if (s === "blocked" || s === "halted") return "blocked";
  return "queued";
}

function runHref(projectId: string, runId: string): string {
  return `/projects/${projectId}/runs/${runId}`;
}

/**
 * Parse a run's `costTotalUsd` into a positive finite amount, or null when the
 * figure is uncomputable. The run-list API COALESCE-defaults missing sums to
 * `"0"`, which is NOT trustworthy real spend — treat ≤0 / NaN as unpriced.
 */
export function parsePricedUsd(costTotalUsd: string | null | undefined): number | null {
  if (costTotalUsd === null || costTotalUsd === undefined || costTotalUsd === "") return null;
  const n = Number(costTotalUsd);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Format a positive amount as `$12.50`; null → `"—"`. */
export function formatPricedUsd(amount: number | null): string {
  if (amount === null) return "—";
  return `$${amount.toFixed(2)}`;
}

function toRunRow(projectId: string, run: RunListItem): SpecRunRow {
  const live = run.status === "running" || run.needsReview;
  return {
    runId: run.runId,
    outcome: run.outcome ?? run.status,
    status: run.status,
    when: run.lastEventAt ?? run.startedAt,
    costLabel: formatPricedUsd(parsePricedUsd(run.costTotalUsd)),
    href: runHref(projectId, run.runId),
    live,
  };
}

/**
 * Roll run costs into economics figures.
 *
 * Real spend is the sum of **positive priced** totals only — unpriced /
 * COALESCE-`"0"` runs never contribute a fake zero to the sum. When some
 * attempts are unpriced the spend figure is still the known real dollars
 * (matching the org costs dashboard), but `unpricedAttempts` is set so the
 * panel can label the figure as incomplete rather than a silent full total.
 */
export function buildEconomics(runs: readonly RunListItem[], runsAvailable: boolean): SpecEconomics {
  if (!runsAvailable) {
    return { spendUsd: "—", attempts: "—", avgCostUsd: "—", pricedAttempts: 0, unpricedAttempts: 0 };
  }
  let total = 0;
  let pricedAttempts = 0;
  for (const run of runs) {
    const priced = parsePricedUsd(run.costTotalUsd);
    if (priced !== null) {
      total += priced;
      pricedAttempts += 1;
    }
  }
  const unpricedAttempts = runs.length - pricedAttempts;
  const attempts = runs.length > 0 ? String(runs.length) : "—";
  // Known real spend only. Incomplete coverage is signalled via unpricedAttempts
  // (never by inventing $0 rows or zeroing the whole aggregate).
  const spendUsd = formatPricedUsd(pricedAttempts > 0 ? total : null);
  const avgCostUsd = formatPricedUsd(pricedAttempts > 0 ? total / pricedAttempts : null);
  return { spendUsd, attempts, avgCostUsd, pricedAttempts, unpricedAttempts };
}

export interface BuildSpecDetailInput {
  spec: SpecSummary;
  /** All specs in the project (for dep-chip titles + "blocks" reverse edges). */
  allSpecs: SpecSummary[];
  /** Runs for THIS spec, newest first. Empty when unavailable or none yet. */
  runs: RunListItem[];
  /** Latest run per dep spec id → status (for dep-chip colours). */
  statusBySpecId: Map<string, DagStatus>;
  /**
   * False when the run-list read failed. Defaults to true (caller has runs or
   * confirmed an empty successful list).
   */
  runsAvailable?: boolean;
}

function depChip(specId: string, allSpecs: SpecSummary[], statusBySpecId: Map<string, DagStatus>): SpecDepChip {
  const found = allSpecs.find((s) => s.specId === specId);
  return {
    specId,
    title: found?.title ?? specId,
    status: statusBySpecId.get(specId) ?? "queued",
  };
}

export function buildSpecDetail(input: BuildSpecDetailInput): SpecDetail {
  const { spec, allSpecs, runs } = input;
  const runsAvailable = input.runsAvailable !== false;
  const latest = runsAvailable ? runs[0] : undefined;
  const status = statusForSpec(spec.status, latest);
  const meta = STATUS_META[status];
  const projectId = spec.projectId;

  const dependsOn = spec.dependsOn.map((id) => depChip(id, allSpecs, input.statusBySpecId));
  const blocks = allSpecs
    .filter((s) => s.dependsOn.includes(spec.specId))
    .map((s) => depChip(s.specId, allSpecs, input.statusBySpecId));

  const runRows = runsAvailable ? runs.map((run) => toRunRow(projectId, run)) : [];
  const latestRun = runRows[0] ?? null;
  const economics = buildEconomics(runsAvailable ? runs : [], runsAvailable);

  const blockedDeps = dependsOn.filter((d) => d.status !== "done");
  const blockedReason =
    status === "blocked"
      ? blockedDeps.length > 0
        ? `Waiting on ${blockedDeps.map((d) => d.title).join(", ")} — ${blockedDeps.length} upstream dep(s) not yet merged.`
        : "This spec's latest run halted. Open the run to see why."
      : null;

  let primaryAction: SpecDetail["primaryAction"] = null;
  if (status === "review" && latestRun !== null) {
    primaryAction = { label: "open review ↗", href: `/runs/${latestRun.runId}/review` };
  } else if (status === "live" && latestRun !== null) {
    primaryAction = { label: "open live run ↗", href: runHref(projectId, latestRun.runId) };
  } else if (status === "done" && latestRun !== null) {
    primaryAction = { label: "view merged run ↗", href: runHref(projectId, latestRun.runId) };
  } else if (status === "queued") {
    primaryAction = { label: "forge it now ↗", href: `/projects/${projectId}/specs/new` };
  }

  return {
    specId: spec.specId,
    projectId,
    title: spec.title,
    description: spec.description,
    status,
    statusLabel: meta.label,
    pill: meta.pill,
    glyph: meta.glyph,
    acceptance: spec.acceptanceCriteria,
    dependsOn,
    blocks,
    runs: runRows,
    runsAvailable,
    latestRun,
    blockedReason,
    spendUsd: economics.spendUsd,
    economics,
    primaryAction,
  };
}
