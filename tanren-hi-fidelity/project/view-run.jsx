// view-run.jsx — 05 · Run Detail.
// Unified cost bar + trajectory (left) + reasoning (right).

const CostBar = () => (
  <div className="cost-bar">
    {/* per-token cost */}
    <div className="cost-cell">
      <div className="row1">
        <span className="swatch" style={{ background: "var(--cost-token)" }}></span>
        <span className="l" style={{ color: "var(--cost-token)" }}>per-token</span>
        <span className="v">{RUN_COSTS.perToken.v}</span>
      </div>
      <div className="bar"><i style={{ width: `${RUN_COSTS.perToken.pct}%`, background: "var(--cost-token)" }}></i></div>
      <div className="k">{RUN_COSTS.perToken.pct}% of {RUN_COSTS.perToken.cap} soft cap</div>
    </div>
    {/* window */}
    <div className="cost-cell">
      <div className="row1">
        <span className="swatch" style={{ background: "var(--cost-window)" }}></span>
        <span className="l" style={{ color: "var(--cost-window)" }}>window</span>
        <span className="v">{RUN_COSTS.window.v}</span>
      </div>
      <div className="bar"><i style={{ width: RUN_COSTS.window.v, background: "var(--cost-window)" }}></i></div>
      <div className="k">{RUN_COSTS.window.sub}</div>
    </div>
    {/* tokens in/out */}
    <div className="cost-cell">
      <div className="row1">
        <span className="l" style={{ color: "var(--fg-3)" }}>tokens · in / out</span>
        <span className="v" style={{ fontSize: 15 }}>
          {RUN_COSTS.tokens.in} <span style={{ color: "var(--fg-4)", margin: "0 2px" }}>/</span> {RUN_COSTS.tokens.out}
        </span>
      </div>
      <div style={{ display: "flex", gap: 2, height: 4 }}>
        <div style={{ flex: 14.3, background: "var(--steel-08)", opacity: 0.7 }}></div>
        <div style={{ flex: 6.8, background: "var(--cost-token)" }}></div>
      </div>
      <div className="k">cached {RUN_COSTS.tokens.cached}</div>
    </div>
    {/* spend rate */}
    <div className="cost-cell" style={{ minWidth: 0 }}>
      <div className="row1" style={{ justifyContent: "space-between" }}>
        <span className="l" style={{ color: "var(--fg-3)" }}>spend rate · 60s</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-1)" }}>{RUN_COSTS.spendRate}</span>
      </div>
      <div style={{ overflow: "hidden", height: 36, position: "relative" }}>
        <div className="spend-spark">
          {[18, 24, 12, 28, 22, 36, 24, 30, 42, 30, 38, 28, 44, 38, 28, 32, 24, 30, 36, 28, 32, 40, 36, 30, 44, 38, 42, 36, 30, 28, 36, 42, 30, 38].map((h, i) => (
            <i key={i} className={i >= 18 ? "hot" : ""} style={{ height: `${h}px`, opacity: 0.4 + (i / 80) }}></i>
          ))}
        </div>
      </div>
    </div>
    {/* run meta */}
    <div className="cost-cell meta-cell">
      <div className="grid">
        <span className="k">cli</span><b>{RUN.cli}</b>
        <span className="k">attempt</span><b>{RUN.attempt}</b>
        <span className="k">elapsed</span><b>{RUN.elapsed}</b>
        <span className="k">retries</span><b style={{ color: "var(--status-ok)" }}>{RUN.retries}</b>
      </div>
    </div>
  </div>
);

// Trajectory spine: gradient based on done/live progress
const TrajectorySpine = () => {
  const total = TRAJECTORY.length;
  const doneCount = TRAJECTORY.filter(e => e.st === "done").length;
  const livePos = TRAJECTORY.findIndex(e => e.st === "live");
  const donePct = (doneCount / total) * 100;
  const livePct = ((livePos + 1) / total) * 100;
  return (
    <div className="spine" style={{
      background: `linear-gradient(to bottom,
        var(--status-ok) 0%,
        var(--status-ok) ${donePct}%,
        var(--ember-08) ${donePct}%,
        var(--ember-08) ${livePct}%,
        var(--line-2) ${livePct}%)`,
    }}></div>
  );
};

const Trajectory = ({ selectedIdx, setSelectedIdx }) => (
  <div className="panel trajectory">
    <div className="panel-head">
      <h3>trajectory</h3>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ember-08)", letterSpacing: "0.06em" }}>↻ live</span>
    </div>
    <div className="body">
      <TrajectorySpine />
      {TRAJECTORY.map((e, i) => (
        <div
          key={i}
          className={"traj-row" + (i === selectedIdx ? " selected" : "") + (e.st === "queued" ? " queued" : "")}
          onClick={() => setSelectedIdx(i)}
        >
          <span className={"dot " + e.st}>
            {e.st === "done" ? "✓" : e.st === "live" ? "↻" : ""}
          </span>
          <div className="body-cell">
            <div className={"ph " + e.st}>{e.ph} · {e.dt}</div>
            <div className="t">{e.t}</div>
            {e.io && <div className="io">{e.io}</div>}
          </div>
        </div>
      ))}
    </div>
    <div style={{ padding: "8px 14px", borderTop: "1px solid var(--line-1)", background: "var(--bg-sunken)", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)", flexShrink: 0 }}>
      click any moment · spine fills as the run progresses
    </div>
  </div>
);

const Reasoning = ({ showSubopt }) => (
  <div className="panel" style={{ minHeight: 0, overflow: "hidden" }}>
    <div className="panel-head">
      <h3>writer's <em>reasoning</em></h3>
      <span className="pill run" style={{ marginLeft: "auto" }}>
        <span className="d"></span>codex jsonl · live
      </span>
    </div>
    <div className="reason">
      {/* Moment header */}
      <div>
        <div className="moment-eyebrow">moment · M4-S02 · subtask 2</div>
        <h2>wire <em>localstorage</em> persistence</h2>
      </div>

      {/* Suboptimal callout (in run context: pace anomaly) */}
      {showSubopt && <Subopt data={RUN_SUBOPT} />}

      {/* Intent + BDD side-by-side */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          <h4>intent</h4>
          <div className="intent">
            Wire the dropdown's selected value into localStorage. Use a useEffect for persistence so we don't risk SSR mismatches. Defer the profile-sync hook to subtask 3 — keeps this commit atomic.
          </div>
        </div>
        <div>
          <h4>demonstrates · bdd</h4>
          <div className="bdd">
            <div><span className="kw">given</span> · authenticated user on settings</div>
            <div><span className="kw">when</span> · they pick a theme from the dropdown</div>
            <div><span className="kw">then</span> · the choice persists across reloads via <code>localStorage</code></div>
          </div>
        </div>
      </div>

      {/* Tools called */}
      <div>
        <h4>tools called · {RUN_TOOLS.length}</h4>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
          {RUN_TOOLS.map((tool, i) => (
            <div key={i} className={"tool-row" + (tool.state === "live" ? " live" : "")}>
              <span className="g">{tool.g}</span>
              <div>
                <div className="name"><b>{tool.t}</b> <span className="arg">{tool.arg}</span></div>
                <div className="out">↑ {tool.out}</div>
              </div>
              <span className="state">{tool.state}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Decisions */}
      <div>
        <h4>decisions</h4>
        <ul className="decisions">
          {RUN_DECISIONS.map((d, i) => (
            <li key={i}>
              {d.t}{d.code && <code>{d.code}</code>}{d.rest}
            </li>
          ))}
        </ul>
      </div>

      {/* Ask forge CTA */}
      <div className="ask-forge-cta">
        <div className="l">↑ ask forge</div>
        <div className="t">why did the writer choose useEffect over a global theme provider?</div>
      </div>
    </div>
  </div>
);

window.RunView = ({ onNav, showSubopt }) => {
  const [selectedIdx, setSelectedIdx] = React.useState(3); // subtask 2 (the live one)
  return (
    <>
      <PageHead
        eyebrow="▮ trajectory · scrub through everything"
        title={<>the agent's <em>thinking</em></>}
        sub={<>{RUN.id} · {RUN.spec} · started {RUN.startedAgo} · branch <b>{RUN.branch}</b></>}
        actions={
          <>
            <span className="pill run"><span className="d"></span>writer · subtask 2/3</span>
            <button className="btn ghost" onClick={() => onNav?.("project")}>← back to project</button>
            <button className="btn" style={{ color: "var(--ember-08)" }}>
              <span style={{ fontFamily: "var(--font-jp)", fontSize: 13 }}>鍛</span> ask why
            </button>
            <button className="btn">tail logs</button>
            <button className="btn danger">cancel</button>
          </>
        }
      />
      <div style={{ marginTop: 12 }}></div>
      <CostBar />
      <div className="page-body">
        <div className="split-row split-run">
          <Trajectory selectedIdx={selectedIdx} setSelectedIdx={setSelectedIdx} />
          <Reasoning showSubopt={showSubopt} />
        </div>
      </div>
    </>
  );
};
