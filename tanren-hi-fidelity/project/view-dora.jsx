// view-dora.jsx — org-level DORA: observed delivery metrics (lead time,
// deploy frequency, change failure rate, mean time to restore) across all
// projects over rolling windows.

const DORA_RANGES = {
  "30d": {
    label: "rolling 30d",
    shortLabel: "30d",
    metrics: [
      { l: "lead time · spec → merge", v: "4h 12m", d: "median · 24 merges", trend: "↓ 59% · chart start → today", elite: true },
      { l: "deploy frequency", v: "2.1/d", d: "rolling 7d · weekday avg", trend: "↑ 0.4/d", elite: true },
      { l: "change failure rate", v: "8.3%", d: "2 of 24 merges reverted", trend: "↓ from 12%", elite: false },
      { l: "mean time to restore", v: "32m", d: "from revert merged", trend: "↓ 18m", elite: true },
    ],
    chart: {
      heading: "30-day trend",
      points: [22, 30, 18, 25, 20, 16, 14, 12, 18, 22, 14, 11, 9, 13, 17, 11, 9, 14, 12, 8, 10, 7, 11, 9],
      max: 32,
      scaleTop: "32h",
      axisStart: "apr 28",
      axisEnd: "today",
      narrative: <><span style={{ color: "var(--ember-08)" }}>↓ 59%</span> from the first to latest observed merge. M3 specs (smaller, well-scoped) drove the cliff at week 3. M5's larger specs may flatten it.</>,
    },
    rows: [
      { p: "tanren-fixture-easy", lead: "4h 12m", dep: "2.4/d", cfr: "8.3%" },
      { p: "supply-chain-os", lead: "—", dep: "—", cfr: "—" },
      { p: "cat-cave-www", lead: "1d 4h", dep: "0.4/d", cfr: "0%" },
    ],
  },
  "90d": {
    label: "rolling 90d",
    shortLabel: "90d",
    metrics: [
      { l: "lead time · spec → merge", v: "6h 48m", d: "median · 61 merges", trend: "↓ 66% · chart start → today", elite: true },
      { l: "deploy frequency", v: "1.7/d", d: "rolling 30d · weekday avg", trend: "↑ 0.2/d", elite: true },
      { l: "change failure rate", v: "9.8%", d: "6 of 61 merges reverted", trend: "↓ from 13.1%", elite: false },
      { l: "mean time to restore", v: "46m", d: "from incident resolved", trend: "↓ 11m", elite: true },
    ],
    chart: {
      heading: "90-day trend",
      points: [35, 31, 29, 27, 32, 25, 28, 24, 26, 22, 25, 21, 19, 23, 20, 18, 21, 17, 19, 15, 16, 13, 15, 12],
      max: 40,
      scaleTop: "40h",
      axisStart: "feb 27",
      axisEnd: "today",
      narrative: <><span style={{ color: "var(--ember-08)" }}>↓ 66%</span> from the first to latest observed merge. Smaller milestone slices are holding lead time below one workday despite the recent M5 ramp.</>,
    },
    rows: [
      { p: "tanren-fixture-easy", lead: "6h 48m", dep: "1.9/d", cfr: "9.8%" },
      { p: "supply-chain-os", lead: "—", dep: "—", cfr: "—" },
      { p: "cat-cave-www", lead: "1d 9h", dep: "0.3/d", cfr: "0%" },
    ],
  },
  all: {
    label: "all-time",
    shortLabel: "all-time",
    metrics: [
      { l: "lead time · spec → merge", v: "8h 06m", d: "median · 98 merges", trend: "↓ 75% · chart start → today", elite: true },
      { l: "deploy frequency", v: "1.3/d", d: "all observed weekdays", trend: "↑ 0.8/d", elite: true },
      { l: "change failure rate", v: "11.2%", d: "11 of 98 merges reverted", trend: "↓ from 16.7%", elite: false },
      { l: "mean time to restore", v: "54m", d: "from incident resolved", trend: "↓ 28m", elite: true },
    ],
    chart: {
      heading: "all-time trend",
      points: [48, 43, 46, 39, 37, 40, 34, 32, 35, 29, 31, 27, 25, 28, 23, 22, 20, 24, 18, 17, 15, 13, 14, 12],
      max: 56,
      scaleTop: "56h",
      axisStart: "first merge",
      axisEnd: "today",
      narrative: <><span style={{ color: "var(--ember-08)" }}>↓ 75%</span> from the first to latest observed merge. The portfolio has steadily shortened the path from scoped spec to merged change.</>,
    },
    rows: [
      { p: "tanren-fixture-easy", lead: "7h 24m", dep: "1.5/d", cfr: "11.2%" },
      { p: "supply-chain-os", lead: "—", dep: "—", cfr: "—" },
      { p: "cat-cave-www", lead: "1d 14h", dep: "0.2/d", cfr: "0%" },
    ],
  },
};

window.DoraView = ({ onNav }) => {
  const [range, setRange] = React.useState("30d");
  const data = DORA_RANGES[range];
  const { chart } = data;
  const eliteY = 240 - (24 / chart.max) * 200;

  return (
  <>
    <PageHead
      eyebrow="▮ org · cat-cave"
      title={<>DORA · <em>observed</em></>}
      sub={<>delivery metrics across all projects · tanren reports your numbers; setting targets comes after you find steady-state</>}
      actions={
        <>
          {Object.entries(DORA_RANGES).map(([key, option]) => {
            const active = key === range;
            return <button key={key} type="button" className={"btn" + (active ? "" : " ghost")} aria-pressed={active} onClick={() => setRange(key)}>{option.label}</button>;
          })}
        </>
      }
    />
    <div className="page-body scrolls">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        {data.metrics.map((m, i) => (
          <div key={i} className={"col-card" + (m.elite ? " live" : "")} style={{ padding: 14, gap: 6, position: "relative" }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>{m.l}</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 28, fontWeight: 600, color: "var(--fg-1)", lineHeight: 1, marginTop: 4 }}>{m.v}</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-3)" }}>{m.d}</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ember-08)", marginTop: 2 }}>{m.trend}</div>
            {m.elite && <div style={{ position: "absolute", top: 10, right: 12, fontFamily: "var(--font-mono)", fontSize: 8.5, color: "var(--ember-08)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700, padding: "2px 6px", border: "1px solid var(--ember-08)", borderRadius: 1 }}>elite</div>}
          </div>
        ))}
      </div>

      <div className="split-row" style={{ gridTemplateColumns: "1.5fr 1fr", minHeight: 360 }}>
        <div className="col-card" style={{ padding: 14, gap: 10 }}>
          <div className="h"><span>lead time · <em style={{ color: "var(--ember-08)" }}>{chart.heading}</em></span><span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>per merge · lower is better</span></div>
          <svg viewBox="0 0 600 260" preserveAspectRatio="none" style={{ width: "100%", height: 260, background: "var(--bg-sunken)", border: "1px solid var(--line-1)" }}>
            <defs>
              <pattern id="dora-grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="var(--line-1)" strokeWidth="1" />
              </pattern>
            </defs>
            <rect width="600" height="260" fill="url(#dora-grid)" />
            <text x="5" y="14" fontFamily="var(--font-mono)" fontSize="9" fill="var(--fg-3)">{chart.scaleTop}</text>
            <text x="5" y="240" fontFamily="var(--font-mono)" fontSize="9" fill="var(--fg-3)">0h</text>
            <line x1="0" y1={eliteY} x2="600" y2={eliteY} stroke="var(--steel-08)" strokeWidth="1" strokeDasharray="3 3" />
            <text x="595" y={eliteY - 4} textAnchor="end" fontFamily="var(--font-mono)" fontSize="9" fill="var(--steel-08)">elite · &lt; 1d</text>
            {(() => {
              const pts = chart.points;
              const max = chart.max;
              const path = pts.map((p, i) => {
                const x = 20 + (i * 560) / (pts.length - 1);
                const y = 240 - (p / max) * 200;
                return `${i === 0 ? "M" : "L"} ${x} ${y}`;
              }).join(" ");
              const area = path + ` L ${20 + 560} 240 L 20 240 Z`;
              return (
                <>
                  <path d={area} fill="oklch(68% 0.22 40 / 0.15)" />
                  <path d={path} fill="none" stroke="var(--ember-08)" strokeWidth="1.5" />
                  {pts.map((p, i) => {
                    const x = 20 + (i * 560) / (pts.length - 1);
                    const y = 240 - (p / max) * 200;
                    return <circle key={i} cx={x} cy={y} r={i === pts.length - 1 ? 3.5 : 1.5} fill={i === pts.length - 1 ? "var(--ember-08)" : "var(--ember-06)"} />;
                  })}
                </>
              );
            })()}
            <text x="20"  y="255" fontFamily="var(--font-mono)" fontSize="9" fill="var(--fg-3)">{chart.axisStart}</text>
            <text x="580" y="255" textAnchor="end" fontFamily="var(--font-mono)" fontSize="9" fill="var(--fg-3)">{chart.axisEnd}</text>
          </svg>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-2)", lineHeight: 1.55 }}>
            {chart.narrative}
          </div>
        </div>

        <div className="col-card" style={{ padding: 14, gap: 8 }}>
          <div className="h"><span>per-project · <em style={{ color: "var(--ember-08)" }}>{data.shortLabel}</em></span></div>
          <div className="matrix-head" style={{ gridTemplateColumns: "1.4fr 0.7fr 0.7fr 0.7fr" }}>
            <span>project</span>
            <span style={{ textAlign: "right" }}>lead</span>
            <span style={{ textAlign: "right" }}>deploys</span>
            <span style={{ textAlign: "right" }}>cfr</span>
          </div>
          {data.rows.map((r, i) => (
            <div key={i} className="matrix-row" style={{ gridTemplateColumns: "1.4fr 0.7fr 0.7fr 0.7fr" }}>
              <span style={{ color: "var(--fg-1)" }}>{r.p}</span>
              <span style={{ textAlign: "right", color: "var(--fg-1)" }}>{r.lead}</span>
              <span style={{ textAlign: "right", color: "var(--fg-1)" }}>{r.dep}</span>
              <span style={{ textAlign: "right", color: "var(--fg-1)" }}>{r.cfr}</span>
            </div>
          ))}

          <div style={{ marginTop: 8, padding: 10, background: "var(--bg-sunken)", border: "1px solid var(--line-1)", borderLeft: "2px solid var(--ember-08)", borderRadius: 2 }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>steady-state first</div>
            <div style={{ fontFamily: "var(--font-ui)", fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.45 }}>
              tanren observes your numbers for 30 days before suggesting targets or alert thresholds. set them yourself anytime in <a style={{ color: "var(--ember-08)", cursor: "pointer" }} onClick={() => onNav?.("settings")}>routing &amp; limits</a>.
            </div>
          </div>
        </div>
      </div>
    </div>
  </>
  );
};
