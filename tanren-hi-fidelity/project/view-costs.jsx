// view-costs.jsx — 09 · History & Costs. All-source spend + utilization heatmap.

// Heatmap: 30 days × 5 daily windows (00-05, 05-10, 10-15, 15-20, 20-00)
const HEATMAP_BASE = [0.08, 0.45, 0.86, 0.72, 0.30];
const heatmapValue = (row, dayCol) => {
  const dayJitter = ((dayCol * 7) % 100) / 100 * 0.3 - 0.15;
  const dayOfWeek = (dayCol + 4) % 7;
  const weekendDip = (dayOfWeek === 5 || dayOfWeek === 6) ? -0.25 : 0;
  return Math.max(0.02, Math.min(1, HEATMAP_BASE[row] + dayJitter + weekendDip));
};
const AVG_FILL = [8, 45, 86, 72, 30];
const WINDOW_LABELS = [
  ["00 – 05", "night"],
  ["05 – 10", "morning"],
  ["10 – 15", "midday"],
  ["15 – 20", "afternoon"],
  ["20 – 00", "evening"],
];

const COST_TABLE = [
  { p: "claude · opus-4.7 · org api key", r: 31, t: "284k", c: "$38.20", share: "45%", source: "token" },
  { p: "codex · gpt-5.5 · dev bundle (TW)", r: 38, t: "412k", c: "$14.60 equiv", share: "17%", source: "window" },
  { p: "opencode · glm-5.1 · zai bundle (TW)", r: 24, t: "238k", c: "$3.80 equiv", share: "4.5%", source: "window" },
  { p: "claude · sonnet-4.6 · org api key", r: 18, t: "94k", c: "$12.80", share: "15%", source: "token" },
  { p: "claude · haiku-4.5 · org api key", r: 47, t: "61k", c: "$3.20", share: "3.8%", source: "token" },
  { p: "codex · gpt-5.5-low · dev bundle", r: 38, t: "48k", c: "$1.20 equiv", share: "1.4%", source: "window" },
  { p: "hetzner · cax21 · runner pool", r: 156, t: "—", c: "$10.80", share: "12.8%", source: "infra" },
  { p: "opportunity · self-host gpu (unused)", r: 0, t: "—", c: "$7.20 equiv", share: "8.5%", source: "opp" },
];

const SOURCE_COLOR = {
  token: "var(--cost-token)",
  window: "var(--cost-window)",
  opp: "var(--cost-opportunity)",
  infra: "var(--steel-08)",
};

window.CostsView = ({ onNav }) => (
  <>
    <PageHead
      eyebrow="▮ history · cost of forging · all sources"
      title={<>where the <em>money</em> goes</>}
      actions={
        <>
          <span className="pill cold">7d</span>
          <span className="pill hot">30d</span>
          <span className="pill cold">90d</span>
          <span className="pill cold">all</span>
          <button className="btn">export csv</button>
        </>
      }
    />
    <div className="page-body scrolls">
      {/* Total spend stacked bar */}
      <div className="panel" style={{ padding: "14px 18px", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.22em", textTransform: "uppercase", fontWeight: 700 }}>total · 30d</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 32, color: "var(--fg-1)", fontWeight: 600, letterSpacing: "-0.025em", fontVariantNumeric: "tabular-nums" }}>$84.62</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--status-ok)" }}>↘ 18% under projected · $103 budget</span>
          </div>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>across 4 cost sources</span>
        </div>

        <div className="cost-stacked" style={{ marginTop: 6 }}>
          <i className="token" style={{ flex: 5840 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-12)", fontWeight: 700, padding: "0 6px", display: "block", lineHeight: "14px" }}>69%</span>
          </i>
          <i className="window" style={{ flex: 1840 }}></i>
          <i className="opp" style={{ flex: 720 }}></i>
          <i className="infra" style={{ flex: 1080 }}></i>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginTop: 6 }}>
          {[
            { l: "per-token · LLM api", v: "$58.40", k: "openai + claude api · ~69%", color: "var(--cost-token)" },
            { l: "subscription window", v: "$18.40 equiv", k: "chatgpt + zai bundle usage · ~22%", color: "var(--cost-window)" },
            { l: "opportunity · gpu", v: "$7.20 equiv", k: "self-hosted runner gpu time · ~9%", color: "var(--cost-opportunity)" },
            { l: "infra · vm hosting", v: "$10.80", k: "hetzner cax21 · 9 spec-hours/day avg", color: "var(--steel-08)" },
          ].map((s, i) => (
            <div key={i} className="cost-source-card">
              <div>
                <span className="swatch" style={{ background: s.color }}></span>
                <span className="l" style={{ color: s.color }}>{s.l}</span>
              </div>
              <div className="v">{s.v}</div>
              <div className="k">{s.k}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Window utilization heatmap */}
      <div className="panel" style={{ padding: "12px 16px", gap: 10 }}>
        <div className="panel-head" style={{ background: "transparent", padding: 0, borderBottom: "none" }}>
          <h3>subscription window <em>utilization</em></h3>
          <span className="meta">chatgpt · 5-hour windows · 30d · % of cap filled</span>
        </div>
        <div style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-2)", lineHeight: 1.45 }}>
          every dark cell is usage you paid for and didn't use. light cells = filling the window well. patterns reveal where the engine could be running harder.
        </div>

        <div className="heatmap-grid">
          <div className="heatmap-labels-y">
            {WINDOW_LABELS.map(([t, sub], i) => (
              <div key={i}>{t}<br /><span className="sub">{sub}</span></div>
            ))}
          </div>
          <div>
            <div className="heatmap-rows">
              {[0, 1, 2, 3, 4].map((row) => (
                <div key={row} className="heatmap-row">
                  {Array.from({ length: 30 }, (_, dayCol) => {
                    const v = heatmapValue(row, dayCol);
                    const isToday = dayCol === 29 && row === 2;
                    return (
                      <div key={dayCol} className={"heatmap-cell" + (isToday ? " today" : "")} style={{ background: `oklch(60% 0.22 36 / ${0.05 + v * 0.85})` }}>
                        {isToday && <div className="now-label">now</div>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(30, 1fr)", gap: 2, marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 8.5, color: "var(--fg-3)", letterSpacing: "0.04em", textAlign: "center" }}>
              <span style={{ gridColumn: "1 / 5" }}>may 13</span>
              <span style={{ gridColumn: "5 / 10" }}>may 18</span>
              <span style={{ gridColumn: "10 / 15" }}>may 23</span>
              <span style={{ gridColumn: "15 / 20" }}>may 28</span>
              <span style={{ gridColumn: "20 / 25" }}>jun 2</span>
              <span style={{ gridColumn: "25 / 30" }}>jun 7</span>
            </div>
          </div>
          <div className="heatmap-avg">
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 700, textAlign: "right", paddingBottom: 4 }}>avg fill</div>
            {AVG_FILL.map((p, i) => (
              <div key={i} className={"cell " + (p >= 70 ? "hi" : p >= 30 ? "mid" : "lo")}>{p}%</div>
            ))}
          </div>
        </div>

        <div className="col-card live" style={{ padding: "10px 12px", flexDirection: "row", alignItems: "center", gap: 14 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ember-08)", letterSpacing: "0.22em", textTransform: "uppercase", fontWeight: 700 }}>↑ pattern</span>
          <div style={{ fontFamily: "var(--font-ui)", fontSize: 12.5, color: "var(--fg-1)", lineHeight: 1.45, flex: 1 }}>
            Night windows (00–05) and evenings (20–00) average <b style={{ color: "var(--status-fail)" }}>under 30% fill</b>. You're paying for the cap but only filling it during operator-hours. <b style={{ color: "var(--ember-08)" }}>Scheduled audits could run overnight</b> — security scans, dependency updates, mutation tests — and use that subscription window you're already paying for.
          </div>
          <button className="btn primary notched" style={{ fontSize: 11 }}>ask forge to schedule overnight audits</button>
        </div>
      </div>

      {/* Breakdown + projections */}
      <div className="split-row" style={{ gridTemplateColumns: "1.2fr 1fr", minHeight: 520 }}>
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <div className="panel-head">
            <h3>breakdown · <em>by provider · 30d</em></h3>
            <span className="meta">per-token + window-equiv + infra share</span>
          </div>
          <div className="cost-table-head">
            <span>cli · model · auth</span>
            <span style={{ textAlign: "right" }}>runs</span>
            <span style={{ textAlign: "right" }}>tokens</span>
            <span style={{ textAlign: "right" }}>$ / equiv</span>
            <span style={{ textAlign: "right" }}>share</span>
          </div>
          <div style={{ flex: 1, overflow: "auto" }}>
            {COST_TABLE.map((r, i) => (
              <div key={i} className="cost-table-row">
                <span className="label">
                  <span className="dot" style={{ background: SOURCE_COLOR[r.source] }}></span>
                  <span>{r.p}</span>
                </span>
                <span className="num">{r.r}</span>
                <span className="num">{r.t}</span>
                <span className="num hi">{r.c}</span>
                <span className="num">{r.share}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="scroll-col">
          <div className="panel" style={{ padding: 12, gap: 6 }}>
            <div className="panel-head" style={{ background: "transparent", padding: 0, borderBottom: "none" }}>
              <h3>burn projection</h3>
              <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--status-ok)" }}>under cap</span>
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 40 }}>
              {[12, 18, 22, 20, 28, 30, 26, 32, 36, 34, 30, 38, 42, 40].map((h, i) => (
                <div key={i} style={{ flex: 1, height: `${h * 0.95}px`, background: i >= 9 ? "var(--ember-08)" : "var(--cost-token)", opacity: 0.6 + i * 0.025 }}></div>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>
              <span>last 14d · daily spend</span>
              <span style={{ color: "var(--fg-1)" }}>$2.82/d avg</span>
            </div>
            <div style={{ paddingTop: 6, borderTop: "1px solid var(--line-1)", display: "grid", gridTemplateColumns: "1fr auto", gap: 4, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-1)" }}>
              <span style={{ color: "var(--fg-3)" }}>at current rate · this month</span><span style={{ color: "var(--ember-08)" }}>$84.62 / $200 cap</span>
              <span style={{ color: "var(--fg-3)" }}>next 30d projection</span><span>$96 ± $14</span>
            </div>
          </div>

          <div className="panel" style={{ padding: 12, gap: 6, borderColor: "oklch(58% 0.18 155 / 0.4)" }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--status-ok)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>headroom · subscription windows</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-1)" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--fg-3)" }}>chatgpt · monthly cap unused</span>
                <span style={{ color: "var(--status-ok)" }}>$28 equiv left over</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--fg-3)" }}>zai · subscription unused</span>
                <span style={{ color: "var(--status-ok)" }}>$12 equiv left over</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--fg-3)" }}>opportunity · gpu (idle)</span>
                <span style={{ color: "var(--status-ok)" }}>~22h/d unused</span>
              </div>
            </div>
            <div style={{ fontFamily: "var(--font-ui)", fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.45, paddingTop: 4, borderTop: "1px solid var(--line-1)" }}>
              <b style={{ color: "var(--ember-08)" }}>↑ if these were filled, agent throughput could grow ~38%</b> without raising the cap.
            </div>
          </div>

          <div className="panel" style={{ padding: 12, gap: 6 }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>observed · 30d (dora-like)</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 5, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-1)" }}>
              <span style={{ color: "var(--fg-3)" }}>specs merged</span><b>42</b>
              <span style={{ color: "var(--fg-3)" }}>avg cost per merged spec</span><b>$2.01</b>
              <span style={{ color: "var(--fg-3)" }}>halt-rate</span><b>4.8%</b>
              <span style={{ color: "var(--fg-3)" }}>median lead time</span><b>21h</b>
              <span style={{ color: "var(--fg-3)" }}>deploy frequency</span><b>2.1/d</b>
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)", lineHeight: 1.4, paddingTop: 4, borderTop: "1px solid var(--line-1)" }}>
              ↑ reported, not targeted. set targets once a steady-state baseline is established (≥ 60d).
            </div>
          </div>
        </div>
      </div>
    </div>
  </>
);
