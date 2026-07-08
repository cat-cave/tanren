/**
 * Budget display formatters — pure string helpers for the budget-halt panel.
 * Each guards `null`/non-finite inputs to "—" so an uncomputable figure never
 * renders a fabricated zero. Real zeros (e.g. spentUsd = 0 after a successful
 * read) stay numeric.
 */

import type { BudgetPeriod } from "../../api/budget.js";

/** Dollars → "$12.34" / "—" when null or non-finite. */
export function budgetUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

/** Period enum → short label, or "—" when missing. */
export function budgetPeriodLabel(period: BudgetPeriod | null | undefined): string {
  if (period === undefined || period === null) return "—";
  if (period === "monthly") return "monthly";
  if (period === "quarterly") return "quarterly";
  if (period === "annual") return "annual";
  if (period === "total") return "total (all time)";
  return "—";
}
