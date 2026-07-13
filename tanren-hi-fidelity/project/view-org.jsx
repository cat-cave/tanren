// view-org.jsx — org-level surfaces:
//   • Overview     — the command deck across all projects
//   • Notifications — per-user channel prefs + delivery history
//   • Roadmap      — milestones across the project portfolio
//   • Personas     — cross-project people-models
//   • DORA         — observed delivery metrics
//
// Per the hi-fi vision direction, these surfaces live ahead of code.
// They use shared design vocabulary (col-card, row-card, pill, matrix) and
// don't carry phase / SOON badges.

// =====================================================================
// OVERVIEW · org command deck
// =====================================================================

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

// =====================================================================
// NOTIFICATIONS · per-user channel prefs + delivery history
// =====================================================================

const ME_CHANNELS = [
  { n: "slack · dm",          v: "@tw · cat-cave.slack.com",            on: true,  glyph: "⌥" },
  { n: "ntfy",                v: "ntfy://tw-personal",                  on: true,  glyph: "▮" },
  { n: "email",               v: "tw@cat-cave.dev · digest · 09:00",   on: true,  glyph: "✉" },
  { n: "sms · twilio",         v: "+1 · hard fails only",                on: false, glyph: "▢" },
  { n: "browser push",        v: "this device · enabled",               on: true,  glyph: "◈" },
];

const ME_DELIVERY = [
  { t: "2m",   ev: "PR #142 ready · supplier scorecard", proj: "tanren-fixture-easy", ch: ["slack", "push"], sev: "warn" },
  { t: "23m",  ev: "writer.retried · session middleware", proj: "tanren-fixture-easy", ch: ["push"],          sev: "info" },
  { t: "1h",   ev: "cred.expiring · codex chatgpt · 6d",  proj: "org",                  ch: ["slack", "ntfy"], sev: "warn" },
  { t: "2h",   ev: "budget.warn · $42 · 84% of $50",      proj: "tanren-fixture-easy", ch: ["slack", "ntfy"], sev: "warn" },
  { t: "3h",   ev: "schedule.audit.found · a11y · 2",     proj: "cat-cave-www",        ch: ["slack"],         sev: "warn" },
  { t: "4h",   ev: "run.merged · supplier model",          proj: "tanren-fixture-easy", ch: ["push"],          sev: "ok" },
  { t: "6h",   ev: "auditor.verdict.pass · magic link",    proj: "tanren-fixture-easy", ch: ["push"],          sev: "ok" },
  { t: "1d",   ev: "external.push · main · by sb",        proj: "tanren-fixture-easy", ch: ["slack", "email"], sev: "warn" },
  { t: "1d",   ev: "ci.failed · typecheck",                proj: "supply-chain-os",     ch: ["slack"],         sev: "fail" },
];

window.NotificationsView = ({ onNav }) => {
  const [pause, setPause] = React.useState(false);
  return (
    <>
      <PageHead
        eyebrow="▮ you · tw@cat-cave"
        title={<>what tanren tells <em>you</em></>}
        sub={<>your channels and per-event overrides · layered on top of cat-cave's org defaults</>}
        actions={
          <>
            <button
              className={"btn" + (pause ? " primary notched" : "")}
              onClick={() => setPause(p => !p)}
            >
              {pause ? "resume · deliver again" : "pause · deep work mode"}
            </button>
            <button className="btn ghost" onClick={() => onNav?.("onb-org")}>view org defaults</button>
          </>
        }
      />
      <div className="page-body scrolls">
        {pause && (
          <div className="col-card live" style={{ padding: "10px 14px", flexDirection: "row", gap: 10, alignItems: "center" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ember-08)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>▮ paused</span>
            <span style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-1)" }}>tanren is queueing non-critical notifications. hard fails still come through.</span>
            <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>auto-resume · 17:00 local</span>
          </div>
        )}

        <div className="split-row" style={{ gridTemplateColumns: "1fr 1.6fr", minHeight: 460 }}>
          <div className="col-card" style={{ gap: 8, minHeight: 0, overflow: "auto" }}>
            <div className="h"><span>your <em style={{ color: "var(--ember-08)" }}>channels</em></span><span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>personal</span></div>
            {ME_CHANNELS.map((c, i) => (
              <div key={i} className={"row-card " + (c.on ? "on" : "")}>
                <span className="glyph">{c.glyph}</span>
                <div>
                  <div className="name">{c.n}</div>
                  <div className="desc">{c.v}</div>
                </div>
                <Toggle on={c.on} />
              </div>
            ))}
            <button className="btn ghost" style={{ fontSize: 11, color: "var(--ember-08)", justifyContent: "flex-start" }}>+ add another channel</button>

            <div style={{ marginTop: 8, padding: "10px 12px", background: "var(--bg-sunken)", border: "1px solid var(--line-1)", borderLeft: "2px solid var(--ember-08)", borderRadius: 2 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>quiet hours</div>
              <div style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-2)", lineHeight: 1.45 }}>22:00 – 07:00 local · weekends muted</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)", marginTop: 4 }}>hard fails + budget caps still wake you</div>
            </div>
          </div>

          <div className="col-card" style={{ padding: 0, overflow: "hidden", minHeight: 0 }}>
            <div className="h" style={{ padding: "12px 16px", borderBottom: "1px solid var(--line-1)" }}>
              <span>your <em style={{ color: "var(--ember-08)" }}>overrides</em></span>
              <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ember-08)" }}>layered on cat-cave's org defaults</span>
            </div>
            <div className="matrix-head" style={{ gridTemplateColumns: "1.4fr repeat(3, 0.7fr) 0.6fr" }}>
              <span>event</span>
              <span style={{ textAlign: "center" }}>slack</span>
              <span style={{ textAlign: "center" }}>email</span>
              <span style={{ textAlign: "center" }}>push</span>
              <span style={{ textAlign: "center" }}>sev</span>
            </div>
            <div style={{ flex: 1, overflow: "auto" }}>
              {[
                { e: "run.failed · hard",          s: 1, em: 1, p: 1, sev: "fail" },
                { e: "run.needs_review",            s: 1, em: 0, p: 1, sev: "warn" },
                { e: "auditor.verdict · pass",     s: 0, em: 0, p: 1, sev: "ok" },
                { e: "writer.retried · soft",      s: 0, em: 0, p: 1, sev: "info" },
                { e: "cred.expiring · ≤ 7d",     s: 1, em: 0, p: 0, sev: "warn" },
                { e: "budget.warn (soft cap)",      s: 1, em: 0, p: 1, sev: "warn" },
                { e: "budget.hard cap hit",         s: 1, em: 1, p: 1, sev: "fail" },
                { e: "external.push · main",       s: 1, em: 1, p: 0, sev: "warn" },
                { e: "ci.failed",                   s: 1, em: 0, p: 0, sev: "warn" },
              ].map((r, i) => (
                <div key={i} className="matrix-row" style={{ gridTemplateColumns: "1.4fr repeat(3, 0.7fr) 0.6fr" }}>
                  <span>{r.e}</span>
                  <div className={"matrix-check " + (r.s ? "on" : "")}>{r.s ? "✓" : ""}</div>
                  <div className={"matrix-check " + (r.em ? "on" : "")}>{r.em ? "✓" : ""}</div>
                  <div className={"matrix-check " + (r.p ? "on" : "")}>{r.p ? "✓" : ""}</div>
                  <span className={"matrix-sev " + r.sev}>{r.sev}</span>
                </div>
              ))}
            </div>
            <div style={{ padding: "10px 16px", borderTop: "1px solid var(--line-1)", background: "var(--bg-sunken)", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)", display: "flex", justifyContent: "space-between" }}>
              <span>+ add personal route</span>
              <span>blank rows inherit org defaults</span>
            </div>
          </div>
        </div>

        <div className="col-card" style={{ padding: 0, overflow: "hidden", minHeight: 280 }}>
          <div className="h" style={{ padding: "12px 16px", borderBottom: "1px solid var(--line-1)" }}>
            <span>delivery <em style={{ color: "var(--ember-08)" }}>history</em></span>
            <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>last 24h · click an event to see the full payload</span>
          </div>
          <div style={{ overflow: "auto" }}>
            {ME_DELIVERY.map((d, i) => (
              <div key={i} style={{
                display: "grid",
                gridTemplateColumns: "48px 1.4fr 1fr 1.4fr 60px",
                gap: 10, alignItems: "center",
                padding: "8px 16px", borderBottom: "1px solid var(--line-1)",
                fontFamily: "var(--font-mono)", fontSize: 11, cursor: "pointer",
              }}>
                <span style={{ color: "var(--fg-3)" }}>{d.t}</span>
                <span style={{ color: "var(--fg-1)" }}>{d.ev}</span>
                <span style={{ color: "var(--ember-08)" }}>{d.proj}</span>
                <span style={{ color: "var(--fg-2)", display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {d.ch.map((c, j) => (
                    <span key={j} style={{ padding: "1px 6px", background: "var(--bg-sunken)", border: "1px solid var(--line-1)", fontSize: 10, borderRadius: 1 }}>{c}</span>
                  ))}
                </span>
                <span className={"matrix-sev " + d.sev}>{d.sev}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
};

// =====================================================================
// ROADMAP · cross-project milestones in a horizontal timeline
// =====================================================================

const ROADMAP_MONTHS = ["may", "jun", "jul", "aug", "sep", "oct"];

const ROADMAP_PROJECTS = [
  {
    proj: "tanren-fixture-easy",
    track: "live",
    ms: [
      { col: 0, w: 1, state: "done",  label: "M1–M2" },
      { col: 1, w: 1, state: "done",  label: "M3 · ops dash" },
      { col: 2, w: 1, state: "live",  label: "M4 · handheld" },
      { col: 3, w: 1, state: "queue", label: "M5 · edi" },
      { col: 4, w: 1, state: "queue", label: "M6 · cfo" },
      { col: 5, w: 1, state: "queue", label: "M7 · perf" },
    ],
  },
  {
    proj: "supply-chain-os",
    track: "interview",
    ms: [
      { col: 0, w: 1, state: "interview", label: "interview" },
      { col: 1, w: 2, state: "plan",      label: "M1–M2 · scaffold + auth" },
      { col: 3, w: 1, state: "plan",      label: "M3 · ops" },
      { col: 4, w: 1, state: "plan",      label: "M4 · handheld" },
      { col: 5, w: 1, state: "plan",      label: "M5 · edi" },
    ],
  },
  {
    proj: "cat-cave-www",
    track: "idle",
    ms: [
      { col: 0, w: 1, state: "done", label: "launch" },
      { col: 2, w: 1, state: "plan", label: "case studies" },
      { col: 4, w: 1, state: "plan", label: "blog v2" },
    ],
  },
];

const RoadmapMilestone = ({ milestone }) => {
  const bg = milestone.state === "live" ? "var(--ember-08)" : milestone.state === "done" ? "var(--status-ok)" : "var(--bg-canvas)";
  const fg = milestone.state === "live" || milestone.state === "done" ? "var(--ink-12)" : "var(--fg-1)";
  return (
    <div style={{
      gridColumn: milestone.gridColumn || `span ${milestone.w}`,
      height: 32, padding: "4px 8px",
      background: bg, color: fg,
      border: "1px solid " + (milestone.state === "live" ? "var(--ember-08)" : milestone.state === "done" ? "var(--status-ok)" : "var(--line-2)"),
      display: "flex", alignItems: "center",
      fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 600,
      borderRadius: 1, position: "relative",
      ...(milestone.state === "live" ? { backgroundImage: "repeating-linear-gradient(135deg, transparent 0, transparent 4px, oklch(60% 0.22 40) 4px, oklch(60% 0.22 40) 5px)" } : {}),
    }}>
      {milestone.label}
    </div>
  );
};

const RoadmapProject = ({ project, onNav }) => (
  <div onClick={project.proj === "tanren-fixture-easy" ? () => onNav?.("project") : undefined} style={{ cursor: project.proj === "tanren-fixture-easy" ? "pointer" : "default" }}>
    <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 13, color: "var(--fg-1)", textTransform: "lowercase" }}>{project.proj}</div>
    <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: project.track === "live" ? "var(--ember-08)" : project.track === "interview" ? "var(--status-warn)" : "var(--fg-3)", letterSpacing: "0.16em", textTransform: "uppercase" }}>{project.track}</div>
  </div>
);

window.RoadmapView = ({ onNav }) => {
  const [grouping, setGrouping] = React.useState("project");
  const quarterGroups = [
    { label: "Q2 · May–Jun", start: 0, end: 1 },
    { label: "Q3 · Jul–Sep", start: 2, end: 4 },
    { label: "Q4 · Oct", start: 5, end: 5 },
  ];
  const rowsByQuarter = quarterGroups.map((quarter) => ({
    ...quarter,
    rows: ROADMAP_PROJECTS.flatMap((project) => project.ms
      .filter((milestone) => milestone.col <= quarter.end && milestone.col + milestone.w - 1 >= quarter.start)
      .map((milestone) => {
        const start = Math.max(milestone.col, quarter.start);
        const end = Math.min(milestone.col + milestone.w - 1, quarter.end);
        return {
          project,
          milestone: {
            ...milestone,
            w: end - start + 1,
            gridColumn: `${start - quarter.start + 2} / span ${end - start + 1}`,
            label: start > milestone.col ? `↳ ${milestone.label}` : milestone.label,
          },
        };
      })),
  }));

  return (
    <>
    <PageHead
      eyebrow="▮ org · cat-cave"
      title={<>the <em>roadmap</em></>}
        sub={<>milestones across all projects · forge tracks dependencies; you set the order</>}
        actions={
          <>
            <button type="button" className={"btn" + (grouping === "project" ? " primary notched" : " ghost")} aria-pressed={grouping === "project"} onClick={() => setGrouping("project")}>group · by project</button>
            <button type="button" className={"btn" + (grouping === "quarter" ? " primary notched" : " ghost")} aria-pressed={grouping === "quarter"} onClick={() => setGrouping("quarter")}>group · by quarter</button>
          </>
        }
      />
      <div className="page-body scrolls">
        <div className="col-card" style={{ padding: 14, gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: grouping === "project" ? "180px repeat(6, 1fr)" : "180px 1fr", gap: 8, paddingBottom: 8, borderBottom: "1px solid var(--line-1)" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>{grouping === "project" ? "project ↓" : "quarter ↓"}</span>
            {grouping === "project" ? ROADMAP_MONTHS.map((m, i) => (
              <span key={i} style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: i === 0 ? "var(--ember-08)" : "var(--fg-3)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700, textAlign: "center" }}>{m} · 2026</span>
            )) : <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>milestone · project attribution</span>}
          </div>

          {grouping === "project" ? ROADMAP_PROJECTS.map((project) => (
            <div key={project.proj} style={{ display: "grid", gridTemplateColumns: "180px repeat(6, 1fr)", gap: 8, alignItems: "center" }}>
              <RoadmapProject project={project} onNav={onNav} />
              {[0, 1, 2, 3, 4, 5].map((col) => {
                const milestone = project.ms.find((item) => item.col === col);
                const covered = project.ms.some((item) => item.col <= col && item.col + item.w > col);
                return milestone ? <RoadmapMilestone key={col} milestone={{ ...milestone, gridColumn: `${col + 2} / span ${milestone.w}` }} /> : !covered && <div key={col} style={{ gridColumn: `${col + 2}`, height: 32, background: "var(--bg-sunken)", border: "1px dashed var(--line-1)", borderRadius: 1 }}></div>;
              })}
            </div>
          )) : rowsByQuarter.map((quarter) => (
            <div key={quarter.label} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ember-08)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700, paddingTop: 4 }}>{quarter.label}</div>
              <div style={{ display: "grid", gridTemplateColumns: `180px repeat(${quarter.end - quarter.start + 1}, 1fr)`, gap: 8 }}>
                <span></span>
                {ROADMAP_MONTHS.slice(quarter.start, quarter.end + 1).map((month) => <span key={month} style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.14em", textAlign: "center", textTransform: "uppercase" }}>{month}</span>)}
              </div>
              {quarter.rows.map(({ project, milestone }) => (
                <div key={`${project.proj}-${milestone.col}-${quarter.label}`} style={{ display: "grid", gridTemplateColumns: `180px repeat(${quarter.end - quarter.start + 1}, 1fr)`, gap: 8, alignItems: "center" }}>
                  <RoadmapProject project={project} onNav={onNav} />
                  <RoadmapMilestone milestone={milestone} />
                </div>
              ))}
            </div>
          ))}

        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--line-1)", display: "flex", gap: 14, flexWrap: "wrap", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>
          <span><span style={{ display: "inline-block", width: 12, height: 8, background: "var(--status-ok)", verticalAlign: "middle", marginRight: 4 }}></span>done</span>
          <span><span style={{ display: "inline-block", width: 12, height: 8, background: "var(--ember-08)", verticalAlign: "middle", marginRight: 4 }}></span>live</span>
          <span><span style={{ display: "inline-block", width: 12, height: 8, background: "var(--bg-canvas)", border: "1px solid var(--line-2)", verticalAlign: "middle", marginRight: 4 }}></span>planned</span>
          <span style={{ marginLeft: "auto" }}>ask forge to re-sequence · dependencies recompute automatically</span>
        </div>
      </div>

      <div className="col-card" style={{ gap: 8 }}>
        <div className="h"><span>upcoming · <em style={{ color: "var(--ember-08)" }}>next 30 days</em></span></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
          {[
            { d: "jun 04", t: "M4 · handheld · last spec", proj: "tanren-fixture-easy", hot: true },
            { d: "jun 11", t: "M5 · edi parser",            proj: "tanren-fixture-easy" },
            { d: "jun 14", t: "M1 · scaffold start",        proj: "supply-chain-os" },
            { d: "jun 18", t: "M6 · cfo reports",           proj: "tanren-fixture-easy" },
            { d: "jun 22", t: "case studies · first batch", proj: "cat-cave-www" },
            { d: "jun 28", t: "M7 · perf budget",           proj: "tanren-fixture-easy" },
          ].map((u, i) => (
            <div key={i} className={"col-card" + (u.hot ? " live" : "")} style={{ padding: 12, gap: 4 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ember-08)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>{u.d}</div>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--fg-1)", textTransform: "lowercase", letterSpacing: "-0.018em" }}>{u.t}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>{u.proj}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
    </>
  );
};

// =====================================================================
// PERSONAS · cross-project people-models
// =====================================================================

const ORG_PERSONAS = [
  {
    name: "developer · fixture operator",
    proj: "tanren-fixture-easy",
    desc: "runs the e2e fixture, no real users · inferred from code",
    behaviors: ["run the e2e fixture", "view current theme", "toggle theme via api", "sync theme to profile"],
    devices: ["desktop"],
    inferred: true,
  },
  {
    name: "ops manager",
    proj: "supply-chain-os",
    desc: "orders, supplier scoring, cross-warehouse view",
    behaviors: ["place a purchase order", "review supplier scorecard", "approve order over $5k"],
    devices: ["desktop"],
  },
  {
    name: "line worker",
    proj: "supply-chain-os",
    desc: "handheld · barcode + bin moves · the hot path",
    behaviors: ["clock in with badge", "pull pick list", "scan item to tote", "confirm scan", "push tote to staging"],
    devices: ["handheld"],
    hot: true,
  },
  {
    name: "cfo",
    proj: "supply-chain-os",
    desc: "monthly reports, edi reconciliation, cost variance",
    behaviors: ["review monthly close", "export to csv", "drill into variance"],
    devices: ["desktop"],
  },
  {
    name: "marketing reader",
    proj: "cat-cave-www",
    desc: "anonymous visitor · case studies + signup",
    behaviors: ["read a case study", "subscribe to updates"],
    devices: ["desktop", "mobile"],
  },
];

window.PersonasView = ({ onNav }) => {
  const [sharedPersona, setSharedPersona] = React.useState(null);
  const [behaviorsView, setBehaviorsView] = React.useState(false);
  const [forgePersona, setForgePersona] = React.useState(null);
  const [shapedPersona, setShapedPersona] = React.useState(null);
  const [forgeInstructions, setForgeInstructions] = React.useState({});
  const [expandedScenarios, setExpandedScenarios] = React.useState({});

  const instructionFor = (persona) => forgeInstructions[persona.name] ?? (persona.draft
    ? "Help define this shared persona and its first behavior."
    : `Refine ${persona.name}'s behaviors for the next spec pass.`);

  const shapePersona = (persona) => {
    const instruction = instructionFor(persona).trim();
    setShapedPersona({
      name: persona.name,
      instruction: instruction || "No additional Forge instructions provided.",
    });
  };
  const personas = sharedPersona ? [...ORG_PERSONAS, sharedPersona] : ORG_PERSONAS;

  const addSharedPersona = () => {
    setSharedPersona({
      name: "new shared persona",
      proj: "all projects",
      desc: "a shared draft ready for Forge to shape into behaviors",
      behaviors: ["describe the first cross-project behavior"],
      devices: ["desktop"],
      draft: true,
    });
    setForgePersona("new shared persona");
  };

  const toggleScenarios = (name) => {
    setExpandedScenarios((current) => ({ ...current, [name]: !current[name] }));
  };

  return (
  <>
    <PageHead
      eyebrow="▮ org · cat-cave"
      title={<>the <em>personas</em></>}
      sub={<>5 personas across 3 projects · each owns the behaviors that drive specs and acceptance tests</>}
      actions={
        <>
          <button className="btn ghost" onClick={addSharedPersona} disabled={Boolean(sharedPersona)}>+ shared persona</button>
          <button className="btn" onClick={() => setBehaviorsView((current) => !current)}>{behaviorsView ? "persona overview ↙" : "behaviors view ↗"}</button>
        </>
      }
    />
    <div className="page-body scrolls">
      <div className="col-card live" style={{ padding: "10px 14px", flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ember-08)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>▸ personas drive specs</span>
        <span style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-2)", lineHeight: 1.45 }}>
          every behavior under a persona becomes a bdd scenario tanren can implement and verify. edit a persona; the spec dag reshapes.
        </span>
      </div>

      {behaviorsView && (
        <div className="col-card live" style={{ padding: "10px 14px", flexDirection: "row", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ember-08)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>▸ behaviors view</span>
          <span style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-2)", lineHeight: 1.45 }}>each card is now organized around its executable behaviors and BDD coverage.</span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
        {personas.map((p, i) => (
          <div key={i} className={"col-card" + (p.hot ? " live" : "")} style={{ padding: 14, gap: 8 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 17, color: "var(--fg-1)", letterSpacing: "-0.025em", textTransform: "lowercase" }}>{p.name}</div>
              {p.inferred && <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--status-warn)", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700 }}>inferred</span>}
              {p.draft && <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700 }}>shared draft</span>}
              <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ember-08)", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700, cursor: "pointer" }} onClick={() => onNav?.("project")}>{p.proj} ↗</span>
            </div>
            {!behaviorsView && <div style={{ fontFamily: "var(--font-ui)", fontSize: 12.5, color: "var(--fg-2)", lineHeight: 1.45 }}>{p.desc}</div>}

            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {p.devices.map((d, j) => (
                <span key={j} style={{ padding: "2px 7px", background: "var(--bg-sunken)", border: "1px solid var(--line-1)", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-2)", borderRadius: 1, letterSpacing: "0.1em", textTransform: "uppercase" }}>{d}</span>
              ))}
            </div>

            <div style={{ paddingTop: 8, borderTop: "1px solid var(--line-1)" }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: behaviorsView ? "var(--ember-08)" : "var(--fg-3)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>{behaviorsView ? "executable behaviors" : "behaviors"} · {p.behaviors.length}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-1)", lineHeight: 1.5 }}>
                {p.behaviors.map((b, j) => (
                  <div key={j}><span style={{ color: "var(--ember-08)", marginRight: 6 }}>b{j+1}</span>{b}</div>
                ))}
              </div>
            </div>

            {forgePersona === p.name && (
              <div style={{ padding: 10, background: "var(--bg-sunken)", border: "1px solid var(--ember-08)", display: "flex", flexDirection: "column", gap: 7 }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 700 }}>▸ Forge · persona narrative</div>
                <div style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-2)", lineHeight: 1.45 }}>Forge is ready to turn this persona’s context into scoped behaviors, BDD scenarios, and acceptance criteria.</div>
                <textarea aria-label={`Forge instructions for ${p.name}`} value={instructionFor(p)} onChange={(event) => setForgeInstructions((current) => ({ ...current, [p.name]: event.target.value }))} style={{ minHeight: 52, resize: "vertical", background: "var(--bg-canvas)", border: "1px solid var(--line-2)", color: "var(--fg-1)", padding: 7, fontFamily: "var(--font-ui)", fontSize: 12 }} />
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="btn" style={{ fontSize: 10 }} onClick={() => shapePersona(p)}>shape with forge</button>
                  <button className="btn ghost" style={{ fontSize: 10 }} onClick={() => setForgePersona(null)}>close</button>
                </div>
                {shapedPersona?.name === p.name && <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--status-ok)", lineHeight: 1.45 }}>▸ Forge shaped the narrative into the next behavior and BDD pass: {shapedPersona.instruction}</div>}
              </div>
            )}

            {expandedScenarios[p.name] && (
              <div style={{ padding: 10, background: "var(--bg-sunken)", border: "1px solid var(--line-1)", display: "flex", flexDirection: "column", gap: 7 }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 700 }}>bdd scenarios · {p.behaviors.length}</div>
                {p.behaviors.map((behavior, j) => (
                  <div key={j} style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-2)", lineHeight: 1.5 }}>
                    <span style={{ color: "var(--fg-1)" }}>scenario {j + 1}:</span> given {p.name} is ready, when they {behavior}, then Tanren verifies the intended outcome.
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: "flex", gap: 6, paddingTop: 4 }}>
              <button className="btn ghost" style={{ fontSize: 11 }} onClick={() => setForgePersona((current) => current === p.name ? null : p.name)}>{forgePersona === p.name ? "close forge" : "edit · ask forge"}</button>
              <button className="btn ghost" style={{ fontSize: 11, color: "var(--ember-08)" }} onClick={() => toggleScenarios(p.name)}>{expandedScenarios[p.name] ? "hide bdd scenarios" : "view bdd scenarios"}</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  </>
  );
};

// =====================================================================
// DORA · observed delivery metrics
// =====================================================================

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
