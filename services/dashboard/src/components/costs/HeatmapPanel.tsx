/**
 * subscription-window utilization heatmap panel (server-rendered).
 * Recreates the hi-fi `view-costs` heatmap: a 30-day × 5-window grid of fill
 * cells, a per-window avg-fill column, the "every dark cell is paid-for capacity
 * you didn't use" framing, and the "ask forge to schedule overnight audits"
 * affordance. Presentation only — every figure comes from `buildHeatmap`
 * (heatmap.ts); the panel never invents data.
 *
 * The affordance opens the existing Forge palette (the ⌘K island) pre-seeded
 * with the audit prompt via `data-island-trigger="palette"` + a prefill, so it
 * stays inside the declared Forge surface and adds no new write path.
 */

import { pct, tokens } from "./format.js";
import { type HeatmapMatrix, underfilledWindows } from "./heatmap.js";

/** The seed query the overnight-audits affordance drops into the Forge palette. */
const FORGE_AUDIT_PROMPT =
  "schedule overnight audits — security scans, dependency updates, mutation tests — " +
  "to fill the subscription windows I'm already paying for";

export interface HeatmapPanelProps {
  matrix: HeatmapMatrix;
}

/** Fill [0,1] → the design-token ember cell background at that opacity. */
function cellBackground(fill: number): string {
  // Match the hi-fi: ember hue, opacity ramped 0.05 → 0.90 by fill.
  const alpha = (0.05 + Math.min(1, Math.max(0, fill)) * 0.85).toFixed(3);
  return `oklch(60% 0.22 36 / ${alpha})`;
}

/** Avg-fill tier → the status-token class (hi / mid / lo). */
function avgClass(fill: number): string {
  if (fill >= 0.7) return "hi";
  if (fill >= 0.3) return "mid";
  return "lo";
}

export function HeatmapPanel(props: HeatmapPanelProps) {
  const { matrix } = props;
  if (matrix.empty) {
    return (
      <section class="panel">
        <div class="panel-head" style="border-bottom:none;padding:12px 16px 0">
          <h3>
            subscription window <em>utilization</em>
          </h3>
          <span class="meta">5-hour windows · 30d · relative fill</span>
        </div>
        <div class="empty">
          No subscription-window usage in the last 30 days. Once a run forges with a subscription credential (chatgpt /
          claude / a bundle), every call lands here and this heatmap shows which windows you're filling — and which
          paid-for capacity is going unused.
        </div>
      </section>
    );
  }
  return (
    <section class="panel">
      <div class="panel-head" style="border-bottom:none;padding:12px 16px 0">
        <h3>
          subscription window <em>utilization</em>
        </h3>
        <span class="meta">5-hour windows · 30d · % of peak filled</span>
      </div>
      <div class="hm-intro">
        Every dark cell is subscription capacity you paid for and didn't use; light cells are windows you filled well.
        Fill is each window's token volume relative to your busiest window — the pattern reveals where the engine could
        run harder on capacity you've already bought.
      </div>
      <div class="heatmap-grid">
        <div class="heatmap-labels-y">
          {matrix.rows.map((row) => (
            <div>
              {row.range}
              <br />
              <span class="sub">{row.sub}</span>
            </div>
          ))}
        </div>
        <div class="heatmap-body">
          <div class="heatmap-rows">
            {matrix.rows.map((row) => (
              <div class="heatmap-row">
                {row.cells.map((cell, dayCol) => {
                  const isToday = dayCol === row.cells.length - 1;
                  return (
                    <div
                      class={`heatmap-cell${isToday ? " today" : ""}`}
                      style={`background:${cellBackground(cell.fill)}`}
                      title={`${matrix.dayKeys[dayCol] ?? ""} · ${row.range} · ${pct(cell.fill)} · ${tokens(cell.tokens)} tok`}
                    >
                      {isToday ? <div class="now-label">now</div> : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div class="heatmap-axis">
            <span>{shortDay(matrix.dayKeys[0])}</span>
            <span>{shortDay(matrix.dayKeys.at(-1))}</span>
          </div>
        </div>
        <div class="heatmap-avg">
          <div class="avg-head">avg fill</div>
          {matrix.rows.map((row) => (
            <div class={`cell ${avgClass(row.avgFill)}`}>{pct(row.avgFill)}</div>
          ))}
        </div>
      </div>
      <PatternCallout matrix={matrix} />
    </section>
  );
}

/** UTC day key (YYYY-MM-DD) → "may 28"; empty/invalid → "". */
function shortDay(key: string | undefined): string {
  if (key === undefined || key === "") return "";
  const d = new Date(`${key}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return "";
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toLowerCase();
  return `${month} ${d.getUTCDate()}`;
}

/**
 * The pattern insight + the "ask forge to schedule overnight audits" affordance.
 * Names the underfilled windows from real avg-fill so the callout is grounded in
 * data, not a fixed script.
 */
function PatternCallout(props: { matrix: HeatmapMatrix }) {
  const low = underfilledWindows(props.matrix);
  const names = low.map((row) => row.sub).join(" and ");
  return (
    <div class="hm-callout">
      <span class="tag">↑ pattern</span>
      <div class="body">
        {low.length > 0 ? (
          <>
            {capitalize(names)} window{low.length > 1 ? "s" : ""} average <b class="bad">under 30% fill</b>. You're
            paying for the subscription window but only filling it during operator-hours.{" "}
            <b class="hot">Scheduled audits could run then</b> — security scans, dependency updates, mutation tests —
            using subscription capacity you've already paid for.
          </>
        ) : (
          <>
            Every window is averaging healthy fill. <b class="hot">Scheduled overnight audits</b> can still keep
            paid-for capacity busy through quieter days without raising the cap.
          </>
        )}
      </div>
      <button type="button" class="btn primary" data-island-trigger="palette" data-palette-prefill={FORGE_AUDIT_PROMPT}>
        ask forge to schedule overnight audits
      </button>
      {/* direct route to the scheduled-audits library (the surface
          that turns this idle-window pitch into real recurring passes). */}
      <a class="btn ghost" href="/audits" data-audits-cta>
        open scheduled audits ↗
      </a>
    </div>
  );
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
