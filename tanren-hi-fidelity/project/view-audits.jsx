// view-audits.jsx — 11 · Scheduled audits (PROJECT_BRIEF §2.2, cron audits).
// Recurring read-only Answerer passes that run on a schedule and fill the
// idle subscription windows the cost view flags. Findings flow into the
// candidate inbox (auto-routed). Reachable from sidebar + the costs CTA.

const AUDIT_KIND_GLYPH = {
  deps: "⬆", security: "⚿", a11y: "◍", mutation: "⊘", perf: "↗", license: "§",
};

// A tiny window-fill bar — the same idle-window story from the costs view.
const WindowFill = () => {
  const windows = [
    { l: "night", pct: 22 }, { l: "morning", pct: 71 }, { l: "midday", pct: 86 },
    { l: "afternoon", pct: 64 }, { l: "evening", pct: 18 },
  ];
  return (
    <div className="window-fill">
      {windows.map((w, i) => (
        <div key={i} className="wf-col">
          <div className="wf-track"><div className="wf-bar" style={{ height: `${w.pct}%`, background: w.pct < 30 ? "var(--status-fail)" : w.pct < 60 ? "var(--status-warn)" : "var(--status-ok)" }}></div></div>
          <div className="wf-pct">{w.pct}%</div>
          <div className="wf-l">{w.l}</div>
        </div>
      ))}
    </div>
  );
};

window.AuditsView = ({ onNav }) => {
  const [jobs, setJobs] = React.useState(window.AUDIT_JOBS);
  const toggle = (i) => setJobs(js => js.map((j, k) => k === i ? { ...j, status: j.status === "on" ? "paused" : "on" } : j));
  const scheduleRecommended = (recommendation) => {
    setJobs(js => js.some(j => j.name === recommendation.name) ? js : [...js, {
      name: recommendation.name,
      kind: recommendation.name.startsWith("performance") ? "perf" : "license",
      status: "on",
      schedule: "nightly · next idle window",
      window: recommendation.window,
      cli: "claude · haiku-4.5",
      lastRun: "scheduled · pending",
      findings: { n: 0, sev: "ok", pending: true, note: "first pass queued for the next window" },
    }]);
  };

  return (
    <>
      <PageHead
        eyebrow="▮ automation · scheduled audits"
        title={<>fill the idle <em>windows</em></>}
        sub={<>recurring read-only audit passes · run on a schedule · findings become candidates</>}
        actions={
          <>
            <button className="btn ghost" onClick={() => onNav?.("costs")}>cost windows ↗</button>
            <button className="btn primary notched">+ new scheduled audit</button>
          </>
        }
      />
      <div className="page-body scrolls">
        {/* The window-fill pitch */}
        <div className="col-card live" style={{ padding: "14px 18px", gap: 12 }}>
          <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ember-08)", letterSpacing: "0.22em", textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>▮ why schedule audits</div>
              <div style={{ fontFamily: "var(--font-ui)", fontSize: 13, color: "var(--fg-1)", lineHeight: 1.55 }}>
                Your <b style={{ color: "var(--status-fail)" }}>night and evening windows sit under 30% filled</b> — you pay for that subscription cap whether you use it or not. Scheduled audits run in those windows: security, dependencies, a11y, mutation tests. They cost you nothing extra and surface work before it bites.
              </div>
            </div>
            <WindowFill />
          </div>
        </div>

        {/* Active jobs */}
        <div className="panel" style={{ padding: 0, overflow: "hidden", flexShrink: 0 }}>
          <div className="panel-head">
            <h3>audit <em>jobs</em></h3>
            <span className="meta">{jobs.filter(j => j.status === "on").length} active · {jobs.length} total</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {jobs.map((j, i) => (
              <div key={i} className={"audit-row" + (j.status !== "on" ? " paused" : "")}>
                <span className="ak">{AUDIT_KIND_GLYPH[j.kind] || "▮"}</span>
                <div className="anames">
                  <div className="an">{j.name}</div>
                  <div className="acli">{j.cli}</div>
                </div>
                <div className="asched">
                  <div className="t">{j.schedule}</div>
                  <div className="w">{j.window}</div>
                </div>
                <div className={"afind sev-" + j.findings.sev} onClick={() => j.findings.n > 0 && onNav?.("inbox")}>
                  <div className="n">{j.findings.pending ? "pending" : j.findings.n > 0 ? `${j.findings.n} found` : "clean"}</div>
                  <div className="note">{j.findings.note}</div>
                </div>
                <div className="alast">last · {j.lastRun}</div>
                <div className={"toggle " + (j.status === "on" ? "on" : "off")} onClick={() => toggle(i)}><div className="knob"></div></div>
              </div>
            ))}
          </div>
          <div style={{ padding: "10px 14px", borderTop: "1px solid var(--line-1)", background: "var(--bg-sunken)", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>
            <span style={{ color: "var(--ember-08)", marginRight: 6 }}>↑</span>audits are Answerers — read-only, no diffs. findings route to the <a style={{ color: "var(--ember-08)", cursor: "pointer" }} onClick={() => onNav?.("inbox")}>candidate inbox ↗</a> automatically.
          </div>
        </div>

        {/* Forge-recommended */}
        <div className="panel" style={{ padding: "14px 16px", gap: 10 }}>
          <div className="spec-h">forge recommends · <span style={{ color: "var(--ember-08)" }}>coverage gaps</span></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {window.AUDIT_RECOMMENDED.map((r, i) => (
              <div key={i} className="audit-rec">
                <div className="rn">+ {r.name}</div>
                <div className="rw">{r.why}</div>
                <div className="foot">
                  <span className="win">{r.window}</span>
                  <button
                    className="btn primary notched"
                    style={{ fontSize: 11 }}
                    disabled={jobs.some(j => j.name === r.name)}
                    onClick={() => scheduleRecommended(r)}
                  >{jobs.some(j => j.name === r.name) ? "scheduled ✓" : "schedule ↗"}</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Composer (visual) */}
        <div className="panel" style={{ padding: "14px 16px", gap: 12 }}>
          <div className="spec-h">new scheduled audit</div>
          <div className="audit-composer">
            <div className="field"><span className="label">kind</span><div className="input filled">security scan <span className="caret">▾</span></div></div>
            <div className="field"><span className="label">cadence</span><div className="input filled">nightly · 03:00 <span className="caret">▾</span></div></div>
            <div className="field"><span className="label">target window</span><div className="input filled">night (00–05) · 22% filled <span className="caret">▾</span></div></div>
            <div className="field"><span className="label">answerer cli</span><div className="input filled">claude · haiku-4.5 <span className="caret">▾</span></div></div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary notched">create audit ↗</button>
            <button className="btn ghost">ask forge to configure it</button>
          </div>
        </div>
      </div>
    </>
  );
};
