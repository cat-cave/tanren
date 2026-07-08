/**
 * Merge-queue display formatters — pure string helpers for the panels. Each
 * guards `null`/non-finite inputs to "—" so an uncomputable figure never renders
 * a fabricated zero.
 */

/** Seconds → compact human duration: "45s" / "12m" / "21h" / "3.2d" / "—". */
export function mqDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = seconds / 60;
  if (mins < 60) return `${Math.round(mins)}m`;
  const hours = mins / 60;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  const days = hours / 24;
  return `${days.toFixed(days < 10 ? 1 : 0)}d`;
}

/** Token count → compact "1.2k" / "0.9M" / "840" / "—". */
export function mqTokens(tokens: number | null): string {
  if (tokens === null || !Number.isFinite(tokens) || tokens < 0) return "—";
  if (tokens < 1000) return `${Math.round(tokens)}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** A fraction [0,1] → "4.8%" / "50%" / "—". */
export function mqPercent(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction) || fraction < 0) return "—";
  const p = fraction * 100;
  return p < 10 && p > 0 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}

/** An integer figure → its number, or "—" when null/non-finite. */
export function mqInt(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${Math.round(n)}`;
}
