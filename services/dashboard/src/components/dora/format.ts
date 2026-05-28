/**
 * P3-0019 DORA display formatters — pure string helpers for the metrics panel.
 * Each guards `null`/non-finite inputs to "—" so an uncomputable metric never
 * renders a fabricated zero.
 */

/** Seconds → compact human duration: "45s" / "12m" / "21h" / "3.2d". */
export function doraDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = seconds / 60;
  if (mins < 60) return `${Math.round(mins)}m`;
  const hours = mins / 60;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  const days = hours / 24;
  return `${days.toFixed(days < 10 ? 1 : 0)}d`;
}

/** Deploys/day → "2.1/d" / "0.3/d" / "—". */
export function doraFrequency(perDay: number | null): string {
  if (perDay === null || !Number.isFinite(perDay) || perDay < 0) return "—";
  return `${perDay.toFixed(perDay < 10 ? 1 : 0)}/d`;
}

/** A fraction [0,1] → "4.8%" / "50%" / "—". */
export function doraPercent(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction) || fraction < 0) return "—";
  const p = fraction * 100;
  return p < 10 && p > 0 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}
