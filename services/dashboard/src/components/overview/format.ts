/**
 * Overview display helpers — pure string/math for the org command deck.
 * Uncomputable / missing figures always become "—", never fabricated zeros.
 *
 * Budget honesty:
 *   - Org budget is an inheritance DEFAULT, not a portfolio-wide cap.
 *   - Project `spentUsd` is over each project's configured period (not always
 *     month-to-date). The card labels period honestly / "mixed".
 *   - Portfolio % uses the sum of resolved project ceilings that contributed
 *     spend — never org default vs summed project spend.
 */

import type { BudgetPeriod, OrgBudgetView, ProjectBudgetView } from "../../api/budget.js";
import { budgetPeriodLabel, budgetUsd } from "../budget/format.js";

export { budgetPeriodLabel, budgetUsd };

/** Compact relative time for activity rows ("3m", "2h", "1d"); "—" when invalid. */
export function relativeCompact(iso: string | null | undefined, now: Date = new Date()): string {
  if (iso === null || iso === undefined || iso === "") return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Event type → short human label (underscores/dots → spaces). */
export function humanizeEvent(eventType: string): string {
  return eventType.replaceAll(/[._]/gu, " ");
}

/** Activity row kind from event type — matches project-view activity coloring. */
export function activityKind(eventType: string): "ok" | "run" | "warn" | "info" {
  if (/fail|error|halt|reject/u.test(eventType)) return "warn";
  if (/complete|merged|succeed|pass|done/u.test(eventType)) return "ok";
  if (/start|run|task|queue/u.test(eventType)) return "run";
  return "info";
}

/**
 * Spend is uncomputable when fail-closed or no resolved ceiling (gate skips the
 * cost sum and returns placeholder zeros that must never render as measured).
 */
export function isSpendUncomputable(b: ProjectBudgetView): boolean {
  if (b.failClosed !== undefined && b.failClosed !== null) return true;
  return b.ceilingUsd === null;
}

/** Org portfolio budget aggregation for the overview card. */
export interface OrgMtdBudget {
  /**
   * Org inheritance default ceiling only — NOT a portfolio-wide cap.
   * Shown as context; never used as the denominator for portfolio %.
   */
  orgDefaultCeilingUsd: number | null;
  orgDefaultPeriodLabel: string;
  /**
   * Sum of resolved project ceilings for projects that contributed spend.
   * Honest portfolio denominator for % of gated spend. `undefined` when no
   * computable spend sample.
   */
  projectCeilingsSumUsd: number | undefined;
  /**
   * Shared period label across contributing projects, or `"mixed"` when they
   * disagree, or `"—"` when there is no sample.
   */
  spendPeriodLabel: string;
  /**
   * Sum of computable project real spends. `undefined` when no project yielded a
   * trustworthy spent figure. Genuine zero after a successful sum is still `0`.
   */
  spentUsd: number | undefined;
  /** Count of projects whose spend contributed to the sum. */
  spendSample: number;
  /** Count of project budget reads that failed. */
  failedReads: number;
  /** True when any project budget is paused. */
  anyPaused: boolean;
}

/**
 * Aggregate portfolio budget from the org default + per-project observations.
 * Does not invent spend when every project is uncomputable / failed, and does
 * not treat the org default as a portfolio cap.
 */
export function aggregateOrgMtd(
  orgBudget: OrgBudgetView | undefined,
  projectBudgets: Array<ProjectBudgetView | undefined>,
): OrgMtdBudget {
  const orgDefaultCeilingUsd = orgBudget?.ceilingUsd ?? null;
  const orgDefaultPeriodLabel = budgetPeriodLabel(orgBudget?.period);

  let spentSum = 0;
  let ceilingsSum = 0;
  let spendSample = 0;
  let failedReads = 0;
  let anyPaused = false;
  const periods = new Set<BudgetPeriod>();

  for (const b of projectBudgets) {
    if (b === undefined) {
      failedReads += 1;
      continue;
    }
    if (b.paused) anyPaused = true;
    if (isSpendUncomputable(b)) continue;
    // ceilingUsd is non-null when computable (guarded by isSpendUncomputable).
    spentSum += b.spentUsd;
    ceilingsSum += b.ceilingUsd as number;
    periods.add(b.period);
    spendSample += 1;
  }

  let spendPeriodLabel = "—";
  if (spendSample > 0) {
    if (periods.size === 1) {
      const only = periods.values().next().value;
      spendPeriodLabel = budgetPeriodLabel(only);
    } else {
      spendPeriodLabel = "mixed";
    }
  }

  return {
    orgDefaultCeilingUsd,
    orgDefaultPeriodLabel,
    projectCeilingsSumUsd: spendSample > 0 ? ceilingsSum : undefined,
    spendPeriodLabel,
    spentUsd: spendSample > 0 ? spentSum : undefined,
    spendSample,
    failedReads,
    anyPaused,
  };
}

/** Percent of ceiling used; "—" when either side is missing / non-finite / zero ceiling. */
export function percentOfCap(spent: number | undefined, ceiling: number | null | undefined): string {
  if (spent === undefined || ceiling === null || ceiling === undefined) return "—";
  if (!Number.isFinite(spent) || !Number.isFinite(ceiling) || ceiling <= 0) return "—";
  return `${Math.round((spent / ceiling) * 100)}%`;
}

/** Width % for the progress bar fill (0–100), or null when uncomputable. */
export function capBarWidth(spent: number | undefined, ceiling: number | null | undefined): number | null {
  if (spent === undefined || ceiling === null || ceiling === undefined) return null;
  if (!Number.isFinite(spent) || !Number.isFinite(ceiling) || ceiling <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((spent / ceiling) * 100)));
}
