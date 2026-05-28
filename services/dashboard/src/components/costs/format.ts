/**
 * P2B-0005 display formatters — pure string helpers shared by the costs +
 * history views. Kept separate so the aggregation stays presentation-free.
 */

/** Dollars → "$12.34". Negative/NaN guarded to "$0.00". */
export function usd(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `$${safe.toFixed(2)}`;
}

/** A percent fraction [0,1] → "45%" (or "4.5%" under 10%). */
export function pct(fraction: number): string {
  const p = Number.isFinite(fraction) ? fraction * 100 : 0;
  return p < 10 && p > 0 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}

/** Token count → compact "284k" / "1.2M" / "61". */
export function tokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** ISO timestamp → "may 28 · 14:32" (UTC). Empty/invalid → "—". */
export function timestamp(iso: string | null): string {
  if (iso === null || iso === "") return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toLowerCase();
  const day = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${month} ${day} · ${hh}:${mm}`;
}

/** A short relative duration between two ISO stamps, e.g. "21h" / "3m" / "—". */
export function duration(startIso: string, endIso: string | null): string {
  if (endIso === null) return "running";
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "—";
  const mins = Math.round((end - start) / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = mins / 60;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  return `${Math.round(hours / 24)}d`;
}
