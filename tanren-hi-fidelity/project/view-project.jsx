// view-project.jsx — 03 · Project View.
// Two modes (toggled by Tweaks/header button):
//   chat-primary — Forge narration leads, DAG snapshot alongside
//   dag-primary  — Full DAG canvas, Forge collapsed to a pill

// =====================================================================
// DAG SNAPSHOT (svg)
// Every node click opens the SpecDrawer (via onOpenSpec) — live, review,
// done, blocked, and queued all surface the same finished spec detail.
// =====================================================================

// Attention-queue badges: maps a node text to its priority number (1, 2, 3).
// Ties the at-a-glance numbered overlay on the DAG to the 3-item attention queue.
const ATTENTION_BADGES = {
  "supplier scorecard": { n: 1, kind: "review" },   // PR #142 — review-ready
  "edi mapping ui":     { n: 3, kind: "blocked" },  // stuck behind budget decision
  // #2 is "raise budget for M5" — surfaced via the M5 milestone label
};
const ATTENTION_BADGE_MILESTONES = {
  "M5": { n: 2, kind: "budget" },  // M5 cluster will need claude credits
};

const DAG_CAMERA = {
  fit: { x: -50, y: -25, width: 1200, height: 510 },
  minZoom: 90,
  maxZoom: 110,
  step: 10,
};

const DagSnapshot = ({ onNodeClick, zoom }) => {
  const viewBox = zoom === undefined
    ? "0 0 1100 460"
    : (() => {
      const scale = 100 / zoom;
      const width = DAG_CAMERA.fit.width * scale;
      const height = DAG_CAMERA.fit.height * scale;
      const x = DAG_CAMERA.fit.x + (DAG_CAMERA.fit.width - width) / 2;
      const y = DAG_CAMERA.fit.y + (DAG_CAMERA.fit.height - height) / 2;
      return `${x} ${y} ${width} ${height}`;
  })();

  return (
    <svg viewBox={viewBox} preserveAspectRatio="xMidYMid meet">
    <defs>
      <marker id="bparr-cool" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6" fill="var(--line-2)" />
      </marker>
      <marker id="bparr-hot" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6" fill="var(--ember-08)" />
      </marker>
    </defs>

    {/* Milestone column headers — with budget-attention ring on M5 */}
    {DAG_MILESTONES.map((m) => {
      const badge = ATTENTION_BADGE_MILESTONES[m.label];
      return (
        <g key={m.label}>
          {badge && (
            <g transform={`translate(${m.x + 50}, 20)`}>
              <circle r="11" fill="var(--status-warn)" stroke="var(--bg-canvas)" strokeWidth="2">
                <animate attributeName="r" values="11;13;11" dur="2s" repeatCount="indefinite" />
              </circle>
              <text x="0" y="3.5" fill="var(--ink-12)" fontFamily="var(--font-mono)"
                    fontSize="11" fontWeight="700" textAnchor="middle">{badge.n}</text>
            </g>
          )}
          <text x={m.x + 50} y={48}
            fill={m.live ? "var(--ember-08)" : m.done ? "var(--status-ok)" : badge ? "var(--status-warn)" : "var(--fg-3)"}
            fontFamily="var(--font-mono)" fontSize="10" textAnchor="middle"
            letterSpacing="0.18em" fontWeight="700">{m.label}</text>
          <text x={m.x + 50} y={62}
            fill={m.live ? "var(--ember-08)" : m.done ? "var(--status-ok)" : badge ? "var(--status-warn)" : "var(--fg-3)"}
            fontFamily="var(--font-mono)" fontSize="9.5" textAnchor="middle">{m.n}</text>
        </g>
      );
    })}

    {/* Nodes — shifted down 30px to make room for the milestone badge row */}
    {DAG_NODES.map((n, i) => {
      const colors = {
        done:    { fill: "oklch(58% 0.18 155 / 0.14)",   stroke: "var(--status-ok)",   text: "var(--fg-2)" },
        live:    { fill: "var(--accent-tint)",            stroke: "var(--ember-08)",    text: "var(--ember-08)" },
        review:  { fill: "oklch(70% 0.16 75 / 0.22)",    stroke: "var(--status-warn)", text: "var(--status-warn)" },
        blocked: { fill: "oklch(60% 0.18 25 / 0.14)",    stroke: "var(--status-fail)", text: "var(--status-fail)" },
        queued:  { fill: "var(--bg-canvas)",              stroke: "var(--line-2)",      text: "var(--fg-3)" },
      };
      const c = colors[n.s] || colors.queued;
      const glyph = n.s === "done" ? "✓" : n.s === "live" ? "↻" : n.s === "review" ? "!" : n.s === "blocked" ? "⏳" : "";
      const badge = ATTENTION_BADGES[n.t];
      const pulses = n.s === "live" || n.s === "review" || n.s === "blocked";
      const pulseColor = n.s === "live" ? "var(--ember-08)"
                       : n.s === "review" ? "var(--status-warn)"
                       : "var(--status-fail)";
      const ny = n.y + 30; // shift to make space for milestone badges
      return (
        <g
          key={i}
          className="dag-node"
          transform={`translate(${n.x}, ${ny})`}
          onClick={() => onNodeClick?.(n)}
          style={{ cursor: "pointer" }}
        >
          {pulses && (
            <rect
              x="-2" y="-2" width="104" height="26" rx="3"
              fill="none" stroke={pulseColor} strokeWidth="1.5" opacity="0.6"
            >
              <animate attributeName="opacity" values="0.6;0;0.6" dur="1.6s" repeatCount="indefinite" />
              <animate attributeName="stroke-width" values="1.5;3;1.5" dur="1.6s" repeatCount="indefinite" />
            </rect>
          )}
          <rect width="100" height="22" rx="2" fill={c.fill} stroke={c.stroke} strokeWidth={pulses ? 1.5 : 1} />
          <text x={6} y={15} fill={c.text} fontFamily="var(--font-mono)" fontSize="9.5">
            {glyph}{glyph && " "}{n.t}
          </text>
          {/* Numbered attention badge */}
          {badge && (
            <g transform="translate(95, -3)">
              <circle r="9" fill="var(--ember-08)" stroke="var(--bg-canvas)" strokeWidth="2"/>
              <text x="0" y="3.5" fill="var(--ink-12)" fontFamily="var(--font-mono)"
                    fontSize="10" fontWeight="700" textAnchor="middle">{badge.n}</text>
            </g>
          )}
        </g>
      );
    })}

    {/* Edges — y values bumped by 30 to match the shifted nodes */}
    {DAG_EDGES.map((e, i) => {
      const shift = (xy) => {
        const [x, y] = xy.split(",").map(Number);
        return `${x},${y + 30}`;
      };
      return (
        <path
          key={i}
          d={`M${shift(e[0])} L${shift(e[1])}`}
          stroke={e[2] ? "var(--ember-08)" : "var(--line-2)"}
          strokeWidth={e[2] ? 1.5 : 1}
          fill="none"
          markerEnd={e[2] ? "url(#bparr-hot)" : "url(#bparr-cool)"}
        />
      );
    })}
    </svg>
  );
};

const VelocityCard = ({ compact }) => (
  <div className="velocity">
    <div className="head">
      <span className="l">velocity</span>
      <span className="s">↗ +2.1d ahead · 5.2/d</span>
    </div>
    <div className="spark" style={{ height: compact ? 22 : 28 }}>
      {[18, 22, 28, 24, 32, 38, 30, 42, 36, 44, 38, 46, 40].map((h, i) => (
        <i key={i} className={i >= 9 ? "hot" : ""} style={{ height: `${h * (compact ? 0.55 : 0.7)}px` }}></i>
      ))}
    </div>
    <div className="foot">
      <span className="k">m7 perf · eta</span>
      <span className="v">june 18</span>
      <span className="t">on track</span>
    </div>
  </div>
);

// =====================================================================
// FORGE NARRATION CARD (chat-primary mode)
// =====================================================================
const ForgeNarrationCard = ({ onAttn, onSubopt, showSubopt, onNav }) => {
  const F = PROJECT_FORGE;
  const [verifiedSubopts, setVerifiedSubopts] = React.useState({});

  return (
    <div className="forge-card">
      <div className="head">
        <span className="stamp">鍛</span>
        <span className="title">forge · <em>your attention queue</em></span>
        <span className="meta">updated 12s ago · live</span>
      </div>
      <div className="body">
        {/* ----- 1. STATE: one-sentence pulse */}
        <ForgeTurn>
          <div className="state-card">
            <div className="label">▮ project pulse</div>
            <div className="text">{F.state.headline}</div>
            <div className="sub-text">{F.state.sub}</div>
          </div>
        </ForgeTurn>

        {/* ----- 2. ATTENTION QUEUE: ranked things-that-need-you */}
        <ForgeTurn>
          <div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--status-warn)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700, marginBottom: 8 }}>
              ▮ {F.attention.length} things need you · ranked
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {F.attention.map(a => (
                <div
                  key={a.id}
                  className={"attn-row" + (a.hot ? " hot" : a.priority === "budget" ? " warn" : "")}
                  onClick={() => onAttn?.(a)}
                >
                  <span className="priority">{a.priority}</span>
                  <div>
                    <div className="t">{a.title}</div>
                    <div className="s">{a.sub}</div>
                  </div>
                  <span className="arrow">↗</span>
                </div>
              ))}
            </div>
          </div>
        </ForgeTurn>

        {/* ----- 3. SUBOPTIMAL: workflow-quality findings */}
        {showSubopt && (
          <ForgeTurn>
            <div>
              <div style={{ fontFamily: "var(--font-ui)", fontSize: 13, color: "var(--fg-1)", lineHeight: 1.55, marginBottom: 8 }}>
                I also noticed <b style={{ color: "var(--status-warn)" }}>{F.subopt.length} things</b> that could be smoother. None are blocking — but they're costing you time or money you don't have to spend.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {F.subopt.map(s => (
                  <Subopt key={s.id} data={s} onAction={(label) => {
                    setVerifiedSubopts(v => ({ ...v, [s.id]: label }));
                  }} />
                ))}
              </div>
            </div>
          </ForgeTurn>
        )}

        {/* ----- 4. PROMPTS: suggested next questions */}
        <ForgeTurn>
          <div>
            <div style={{ fontFamily: "var(--font-ui)", fontSize: 13, color: "var(--fg-2)", marginBottom: 8 }}>Ask anything:</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {F.prompts.map((p, i) => (
                <span key={i} className="chip"><span className="pre">↑</span> {p}</span>
              ))}
            </div>
          </div>
        </ForgeTurn>
      </div>
      <div className="forge-input">
        <span className="stamp">鍛</span>
        <input placeholder="type · or click any node in the dag →" />
        <span className="kbd">↵</span>
      </div>
    </div>
  );
};

// =====================================================================
// PROJECT VIEW · CHAT-PRIMARY
// =====================================================================
const ProjectViewChat = ({ onNav, onOpenSpec, mode, setMode, showSubopt }) => (
  <>
    <PageHead
      eyebrow="▮ project · tanren-fixture-easy"
      title={<>what needs <em>your attention</em>?</>}
      actions={
        <>
          <span className="pill run"><span className="d"></span>forge live · 12s ago</span>
          <button className="btn" onClick={() => setMode("dag")}>↹ full dag</button>
          <button className="btn primary notched" onClick={() => onNav?.("discovery")}>+ discover spec ↗</button>
        </>
      }
    />
    <KpiStrip items={PROJECT_KPIS} />
    <div className="page-body">
      <div className="split-row split-chat">
        <ForgeNarrationCard onNav={onNav} showSubopt={showSubopt}
          onAttn={(a) => {
            const route = a.route === "budget" ? "costs" : a.route;
            if (["review", "discovery", "costs"].includes(route)) onNav?.(route);
          }}
        />
        <div className="col" style={{ gap: 12, minHeight: 0 }}>
          <div className="dag-shell">
            <div className="grid-bg"></div>
            <div className="dag-head">
              <span className="pill run"><span className="d"></span>dag · live</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)" }}>2 in flight · click any node</span>
              <button className="seg-btn" style={{ marginLeft: "auto" }} onClick={() => setMode("dag")}>expand ⤢</button>
            </div>
            <div className="dag-canvas">
              <DagSnapshot onNodeClick={(n) => onOpenSpec?.(n)} />
            </div>
          </div>
          <VelocityCard />
        </div>
      </div>
    </div>
  </>
);

// =====================================================================
// PROJECT VIEW · DAG-PRIMARY
// =====================================================================
const ProjectViewDag = ({ onNav, onOpenSpec, setMode, showSubopt }) => {
  const [group, setGroup] = React.useState("milestone");
  const [zoom, setZoom] = React.useState(100);
  const zoomIn = () => setZoom(current => Math.min(DAG_CAMERA.maxZoom, current + DAG_CAMERA.step));
  const zoomOut = () => setZoom(current => Math.max(DAG_CAMERA.minZoom, current - DAG_CAMERA.step));
  const fitCanvas = () => setZoom(100);
  return (
    <>
      <PageHead
        eyebrow="▮ project · tanren-fixture-easy · full dag"
        title={<>the <em>smithy</em>, top-down</>}
        actions={
          <>
            <span className="pill run"><span className="d"></span>2 in flight</span>
            <span className="pill warn"><span className="d"></span>3 need you</span>
            <button className="btn" onClick={() => setMode("chat")}>
              <span style={{ fontFamily: "var(--font-jp)", fontSize: 13, color: "var(--ember-08)" }}>鍛</span> expand forge
            </button>
            <button className="btn primary notched" onClick={() => onNav?.("discovery")}>+ discover spec ↗</button>
          </>
        }
      />
      <KpiStrip items={PROJECT_KPIS} />
      <div className="page-body">
        <div className="split-row split-dag">
          <div className="dag-shell">
            <div className="grid-bg"></div>
            {/* "Needs you" strip — replicates the chat-primary attention queue
                as a DAG-canvas-aware overlay. Numbers tie to the badges on
                the actual nodes (1 ↔ supplier scorecard, 2 ↔ M5 cluster,
                3 ↔ edi mapping ui). */}
            <div className="needs-strip">
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--status-warn)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700, marginRight: 4 }}>
                ▮ 3 need you
              </span>
              {[
                { n: 1, kind: "review",  t: "PR #142 · supplier scorecard",   sub: "review-ready · 2h",   act: () => onNav?.("review") },
                { n: 2, kind: "budget",  t: "M5 will need claude credits",    sub: "forecast · 9d out",   act: () => onNav?.("costs") },
                { n: 3, kind: "blocked", t: "edi-mapping-ui · 4h 12m stuck",  sub: "behind M5 decision",  act: () => onOpenSpec?.({ t: "edi mapping ui", s: "blocked" }) },
              ].map((item) => (
                <div key={item.n} className={"needs-item kind-" + item.kind} onClick={() => item.act && item.act()}>
                  <span className={"badge-num kind-" + item.kind}>{item.n}</span>
                  <div>
                    <div className="t">{item.t}</div>
                    <div className="s">{item.sub}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="dag-head" style={{ marginTop: 4 }}>
              <span className="pill cold" style={{ fontSize: 9 }}><span className="d"></span>71 specs · 38 done · 2 live · 12 critical-path</span>
              <span className="pill ok" style={{ fontSize: 9 }}><span className="d"></span>tied to 14 behaviors</span>
              <div style={{ marginLeft: "auto", display: "flex", gap: 4, alignItems: "center" }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)", marginRight: 4 }}>group by</span>
                {["milestone", "behavior", "priority"].map(g => (
                  <button key={g} className={"seg-btn" + (group === g ? " active" : "")} onClick={() => setGroup(g)}>{g}</button>
                ))}
                <span style={{ color: "var(--line-1)", margin: "0 4px" }}>·</span>
                <button type="button" className="seg-btn" onClick={fitCanvas} aria-label="Fit DAG canvas to view" disabled={zoom === 100}>fit</button>
                <span aria-live="polite" aria-label="DAG canvas zoom" style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)", minWidth: 30, textAlign: "center" }}>{zoom}%</span>
                <button type="button" className="seg-btn" onClick={zoomIn} aria-label="Zoom in DAG canvas" disabled={zoom === DAG_CAMERA.maxZoom}>+</button>
                <button type="button" className="seg-btn" onClick={zoomOut} aria-label="Zoom out DAG canvas" disabled={zoom === DAG_CAMERA.minZoom}>−</button>
              </div>
            </div>
            <div className="dag-canvas">
              <DagSnapshot zoom={zoom} onNodeClick={(n) => onOpenSpec?.(n)} />
            </div>

            {/* Legend — bottom-left, anchored. Reads as a graphical key, not chrome. */}
            <div className="dag-legend">
              <div className="legend-title">legend</div>
              {[
                { k: "done",    glyph: "✓", color: "var(--status-ok)",    bg: "oklch(58% 0.18 155 / 0.14)" },
                { k: "live",    glyph: "↻", color: "var(--ember-08)",     bg: "var(--accent-tint)",       pulse: true },
                { k: "review",  glyph: "!", color: "var(--status-warn)",  bg: "oklch(70% 0.16 75 / 0.22)", pulse: true },
                { k: "blocked", glyph: "⏳", color: "var(--status-fail)",  bg: "oklch(60% 0.18 25 / 0.14)", pulse: true },
                { k: "queued",  glyph: "○", color: "var(--fg-3)",          bg: "var(--bg-canvas)" },
              ].map((r) => (
                <div key={r.k} className="legend-row">
                  <div className={"swatch" + (r.pulse ? " pulse" : "")} style={{ background: r.bg, borderColor: r.color, color: r.color }}>
                    {r.glyph}
                  </div>
                  <span className="k">{r.k}</span>
                </div>
              ))}
              <div className="legend-divider"></div>
              <div className="legend-row">
                <div className="num-swatch">N</div>
                <span className="k">attention #</span>
              </div>
            </div>

            <div style={{
              position: "absolute", left: 14, bottom: 14,
              fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)",
              padding: "6px 10px", background: "var(--bg-canvas)", border: "1px solid var(--line-1)",
              borderRadius: 2, zIndex: 3, display: "none",
            }}>
              ↑ click any node · pulsing = needs action · → drilldown
            </div>
          </div>

          {/* Right rail: Forge pill + velocity + activity */}
          <div className="col" style={{ gap: 12, minHeight: 0 }}>
            <div
              className="forge-card"
              style={{ flexShrink: 0, cursor: "pointer" }}
              onClick={() => setMode("chat")}
            >
              <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontFamily: "var(--font-jp)", fontSize: 18, color: "var(--ember-08)" }}>鍛</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>forge · collapsed</span>
                  <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--status-warn)" }}>{PROJECT_FORGE.attention.length} need you</span>
                  {showSubopt && PROJECT_FORGE.subopt.length > 0 && (
                    <span className="pill warn" style={{ fontSize: 8 }}>
                      <span className="d"></span>quality · {PROJECT_FORGE.subopt.length}
                    </span>
                  )}
                </div>
                <div style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-1)", lineHeight: 1.4 }}>
                  {PROJECT_FORGE.state.headline}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>
                  <span>↑ click to expand · ⌘K</span>
                  <span>12s ago</span>
                </div>
              </div>
            </div>

            <VelocityCard compact />

            <div className="activity">
              <div className="panel-head">
                <h3>activity · <em>live</em></h3>
                <span className="pill run" style={{ fontSize: 8 }}><span className="d"></span>↻</span>
              </div>
              <div className="body">
                {ACTIVITY.slice(0, 9).map((a, i) => (
                  <div key={i} className="row">
                    <span className="t">{a.t}</span>
                    <span className={"icn " + a.k}>
                      {a.k === "ok" ? "✓" : a.k === "run" ? "↻" : a.k === "warn" ? "!" : "▮"}
                    </span>
                    <div>
                      <div className="ev">{a.ev}</div>
                      <div className="det">{a.det}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

// =====================================================================
// EXPORT
// =====================================================================
const ProjectView = ({ onNav, onOpenSpec, mode, setMode, showSubopt }) => {
  return mode === "dag"
    ? <ProjectViewDag onNav={onNav} onOpenSpec={onOpenSpec} setMode={setMode} showSubopt={showSubopt} />
    : <ProjectViewChat onNav={onNav} onOpenSpec={onOpenSpec} mode={mode} setMode={setMode} showSubopt={showSubopt} />;
};

window.ProjectView = ProjectView;
