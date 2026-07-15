// view-roadmap.jsx — org-level roadmap: cross-project milestones in a
// horizontal timeline, groupable by project or by quarter.

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
