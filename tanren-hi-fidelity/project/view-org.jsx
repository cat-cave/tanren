// view-org.jsx — org-level command deck: the cross-project overview.
// Per the hi-fi vision direction these surfaces live ahead of code. They use
// shared design vocabulary (col-card, row-card, pill, matrix) and don't carry
// phase / SOON badges. Sibling surfaces (notifications, roadmap, personas,
// DORA) were split out into their own view-*.jsx modules under the 500-line cap.

const ORG_PROJECTS = [
  {
    name: "tanren-fixture-easy",
    desc: "smoke fixture for the agentic loop",
    state: "live",
    specs: { done: 24, live: 2, queued: 9, blocked: 1 },
    needs: 3,
    weekSpend: "$12.84",
    cap: "$50",
    velocity: "5.2/d",
    nextMs: "M4 · handheld",
    hot: true,
  },
  {
    name: "supply-chain-os",
    desc: "ops & line-worker tooling · mid-market manufacturers",
    state: "interview",
    specs: { done: 0, live: 0, queued: 71, blocked: 0 },
    needs: 1,
    weekSpend: "$0.00",
    cap: "$200",
    velocity: "—",
    nextMs: "M1 · scaffold",
  },
  {
    name: "cat-cave-www",
    desc: "marketing site · editorial",
    state: "idle",
    specs: { done: 38, live: 0, queued: 3, blocked: 0 },
    needs: 0,
    weekSpend: "$2.18",
    cap: "$25",
    velocity: "0.4/d",
    nextMs: "schedule · audit",
  },
];

const ORG_KPIS = [
  { l: "in flight",     v: "2",      k: "across 1 project" },
  { l: "needs you",     v: "4",      k: "1 review · 3 decisions", hot: true },
  { l: "week · spend",   v: "$15.02",   k: "of $275 cap · 5.5%" },
  { l: "loops/day",     v: "5.6",    k: "rolling 7d" },
  { l: "halted runs",   v: "1",      k: "edi-mapping · 4h 12m", warn: true },
];

window.OverviewView = ({ onNav, onAsk }) => (
  <>
    <PageHead
      eyebrow="▮ org · cat-cave"
      title={<>the <em>command deck</em></>}
      sub={<>3 projects · 1 mid-loop, 1 onboarding, 1 idle · forge knows the whole portfolio</>}
      actions={
        <>
          <button className="btn ghost" onClick={() => onNav?.("onb-new")}>+ new project</button>
          <button className="btn ghost" onClick={() => onNav?.("onb-exist")}>+ link existing</button>
        </>
      }
    />
    <div className="page-body scrolls">
      <KpiStrip items={ORG_KPIS} />

      <div className="split-row" style={{ gridTemplateColumns: "1.55fr 1fr", minHeight: 440 }}>
        <div className="panel" style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div className="panel-head">
            <h3>projects · <em>the portfolio</em></h3>
            <span className="meta">click any tile to jump in</span>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignContent: "start" }}>
            {ORG_PROJECTS.map((p, i) => (
              <ProjectTile key={i} p={p} onNav={onNav} />
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
          <div className="col-card" style={{ gap: 10 }}>
            <div className="h"><span>budget · <em style={{ color: "var(--ember-08)" }}>month-to-date</em></span><span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>resets in 12d</span></div>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8, alignItems: "baseline" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 28, fontWeight: 600, color: "var(--fg-1)" }}>$84.20</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>of $275 monthly cap</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ember-08)" }}>30%</span>
            </div>
            <div style={{ height: 6, background: "var(--bg-sunken)", border: "1px solid var(--line-1)", position: "relative", borderRadius: 1 }}>
              <div style={{ position: "absolute", inset: 0, width: "30%", background: "var(--ember-08)" }}></div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginTop: 6 }}>
              {[
                ["tokens",       "$72.40", "86%"],
                ["infra",        "$11.80", "14%"],
                ["forecast eom", "$152",   "55% of cap"],
              ].map(([l, v, k], j) => (
                <div key={j} style={{ padding: 8, background: "var(--bg-sunken)", border: "1px solid var(--line-1)", borderRadius: 2 }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.16em", textTransform: "uppercase" }}>{l}</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600, color: "var(--fg-1)", marginTop: 2 }}>{v}</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>{k}</div>
                </div>
              ))}
            </div>
            <a style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ember-08)", cursor: "pointer" }} onClick={() => onNav?.("costs")}>history & costs ↗</a>
          </div>

          <div className="forge-card" style={{ padding: 12, gap: 8 }}>
            <div className="head">
              <span className="stamp">鍛</span>
              <span className="title">forge · <em>org-wide</em></span>
              <span className="meta">ask across all projects</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "stretch", background: "var(--bg-sunken)", border: "1px solid var(--line-1)", borderRadius: 2 }}>
              {[
                ["org_budget_risk", "which project will hit budget first?"],
                ["org_halted_runs", "any halted runs older than 2h?"],
                ["org_loop_speed", "where is the loop slowest?"],
              ].map(([key, question], i) => (
                <button
                  key={key}
                  type="button"
                  className="btn ghost"
                  style={{ justifyContent: "flex-start", border: 0, borderBottom: i < 2 ? "1px solid var(--line-1)" : 0, borderRadius: 0, padding: "7px 10px", fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-2)" }}
                  onClick={() => onAsk?.(key)}
                >
                  <span style={{ color: "var(--ember-08)", marginRight: 8 }}>▸</span>
                  {question}
                </button>
              ))}
            </div>
          </div>

          <div className="col-card" style={{ gap: 8, minHeight: 0, overflow: "hidden" }}>
            <div className="h"><span>activity · <em>last hour</em></span><span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>cross-project</span></div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.55 }}>
              {[
                ["3m",  "tanren-fixture-easy", "writer.subtask.started · clock-in 2/3", "run"],
                ["12m", "tanren-fixture-easy", "PR #142 ready",                         "warn"],
                ["28m", "supply-chain-os",     "interview · personas captured (3)",     "info"],
                ["47m", "tanren-fixture-easy", "run.merged · supplier model · $0.41",   "ok"],
                ["52m", "cat-cave-www",        "schedule.audit.found · a11y · 2 issues", "warn"],
              ].map(([t, proj, ev, kind], i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "32px 1.1fr 2.4fr", gap: 8, padding: "4px 0", borderBottom: i < 4 ? "1px solid var(--line-1)" : "none" }}>
                  <span style={{ color: "var(--fg-3)" }}>{t}</span>
                  <span style={{ color: "var(--ember-08)" }}>{proj}</span>
                  <span style={{ color: kind === "warn" ? "var(--status-warn)" : kind === "ok" ? "var(--status-ok)" : kind === "run" ? "var(--ember-08)" : "var(--fg-2)" }}>{ev}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  </>
);

const ProjectTile = ({ p, onNav }) => {
  const stateColor = p.state === "live" ? "var(--ember-08)" : p.state === "interview" ? "var(--status-warn)" : "var(--fg-3)";
  return (
    <div
      className={"col-card" + (p.hot ? " live" : "")}
      style={{ padding: 14, gap: 8, cursor: "pointer" }}
      onClick={() => onNav?.("project")}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 15, color: "var(--fg-1)", textTransform: "lowercase", letterSpacing: "-0.02em" }}>{p.name}</div>
        <span className={"pill " + (p.state === "live" ? "run" : p.state === "interview" ? "warn" : "cold")} style={{ marginLeft: "auto", fontSize: 9 }}>
          <span className="d"></span>{p.state}
        </span>
      </div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-3)" }}>{p.desc}</div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4, marginTop: 4 }}>
        {[
          ["done",    p.specs.done,    "var(--status-ok)"],
          ["live",    p.specs.live,    "var(--ember-08)"],
          ["queued",  p.specs.queued,  "var(--fg-2)"],
          ["blocked", p.specs.blocked, p.specs.blocked > 0 ? "var(--status-fail)" : "var(--fg-3)"],
        ].map(([l, v, c], i) => (
          <div key={i} style={{ padding: 6, background: "var(--bg-sunken)", border: "1px solid var(--line-1)", borderRadius: 1, textAlign: "center" }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, color: "var(--fg-3)", letterSpacing: "0.16em", textTransform: "uppercase" }}>{l}</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, color: c, fontWeight: 600 }}>{v}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-2)", flexWrap: "wrap" }}>
        <span>next · <b style={{ color: "var(--fg-1)" }}>{p.nextMs}</b></span>
        <span style={{ marginLeft: "auto" }}>velocity · <b style={{ color: "var(--fg-1)" }}>{p.velocity}</b></span>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", paddingTop: 4, borderTop: "1px solid var(--line-1)" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-2)" }}>week · <b style={{ color: "var(--fg-1)" }}>{p.weekSpend}</b> of {p.cap}</span>
        {p.needs > 0 && (
          <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ember-08)", letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 700 }}>
            {p.needs} need{p.needs > 1 ? "s" : ""} you ↗
          </span>
        )}
      </div>
    </div>
  );
};
