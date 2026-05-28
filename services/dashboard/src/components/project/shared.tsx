/**
 * Shared presentational building blocks for the P2B-0003 screens — the
 * hi-fi `PageHead` and `KpiStrip` rebuilt as Hono JSX (NOT imported from the
 * prototype). Every screen body wraps its content in `<div class="p2b">` so
 * the inline `ScreenStyles` selectors (`.p2b …`) apply without leaking into
 * the shell chrome.
 */

export interface PageHeadProps {
  eyebrow: string;
  title: unknown;
  sub?: unknown;
  actions?: unknown;
}

export function PageHead(props: PageHeadProps) {
  return (
    <div class="page-head">
      <div>
        <div class="eyebrow">{props.eyebrow}</div>
        <div class="title">{props.title}</div>
        {props.sub !== undefined && <div class="sub">{props.sub}</div>}
      </div>
      {props.actions !== undefined && <div class="head-actions">{props.actions}</div>}
    </div>
  );
}

export interface KpiItem {
  k: string;
  v: string;
  tone?: "hot" | "warn";
}

export function KpiStrip(props: { items: KpiItem[] }) {
  return (
    <div class="kpi-strip">
      {props.items.map((item) => (
        <div class={`kpi${item.tone ? ` ${item.tone}` : ""}`}>
          <span class="k">{item.k}</span>
          <span class="v">{item.v}</span>
        </div>
      ))}
    </div>
  );
}

/** Compact relative-time label for activity rows / live indicators. */
export function relativeTime(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
