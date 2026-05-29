// view-spec.jsx — 04 · Spec surface (closes the DAG dead-end).
// Clicking any node opens SpecDrawer (minimal slide-in). From there you can
// open the full SpecView page. Both read the same spec via specForNode().
// Spec schema follows PROJECT_BRIEF §9 (specs/runs) + persona→behavior→spec.

const STATUS_META = {
  done:    { pill: "ok",   label: "merged",   glyph: "✓" },
  live:    { pill: "run",  label: "forging",  glyph: "↻" },
  review:  { pill: "warn", label: "review-ready", glyph: "!" },
  blocked: { pill: "fail", label: "blocked",  glyph: "⏳" },
  queued:  { pill: "cold", label: "queued",   glyph: "○" },
};

// Acceptance criteria as BDD lines (shared by drawer + full page).
const Acceptance = ({ rows }) => (
  <div className="spec-bdd">
    {rows.map((r, i) => (
      <div key={i}><span className="kw">{r.kw}</span> · {r.t}</div>
    ))}
  </div>
);

// Dependency chips — clickable to walk the graph inside the drawer.
const DepChips = ({ titles, onOpenSpec, dir }) => (
  <div className="dep-chips">
    {titles.length === 0
      ? <span className="dep-none">{dir === "up" ? "no upstream deps · can start anytime" : "nothing waits on this"}</span>
      : titles.map((t, i) => {
          const s = (window.SPECS[t] && window.SPECS[t].status) || "queued";
          return (
            <span key={i} className={"dep-chip s-" + s} onClick={() => onOpenSpec?.({ t, s })}>
              <span className="g">{dir === "up" ? "↑" : "↓"}</span>{t}
            </span>
          );
        })}
  </div>
);

// Contextual primary action per status.
const specActions = (spec, onNav, onAsk) => {
  switch (spec.status) {
    case "review":  return [{ label: "open review ↗", primary: true, go: () => onNav?.("review") }];
    case "live":    return [{ label: "open live run ↗", primary: true, go: () => onNav?.("run") }];
    case "blocked": return [
      { label: "ask forge · why blocked?", primary: true, go: () => onAsk?.("blocking_m5") },
      { label: "see dependency chain", ghost: true, go: () => {} },
    ];
    case "queued":  return [{ label: "forge it now ↗", primary: true, go: () => onNav?.("discovery") }];
    default:        return [{ label: "view merged run ↗", primary: true, go: () => onNav?.("run") }];
  }
};

// =====================================================================
// SPEC DRAWER · minimal slide-in over the DAG
// =====================================================================
const SpecDrawer = ({ node, onClose, onOpenSpec, onNav, onAsk, onFullPage }) => {
  if (!node) return null;
  const spec = window.specForNode(node);
  const meta = STATUS_META[spec.status] || STATUS_META.queued;
  const liveRun = spec.runs.find(r => r.live);

  return (
    <div className="spec-scrim" onClick={onClose}>
      <aside className="spec-drawer" onClick={e => e.stopPropagation()}>
        <div className="spec-drawer-head">
          <div className="row">
            <span className={"pill " + meta.pill}><span className="d"></span>{meta.label}</span>
            <span className="spec-id">{spec.id}</span>
            <button className="spec-x" onClick={onClose}>esc ✕</button>
          </div>
          <h2 className="spec-title">{spec.title}</h2>
          <div className="spec-sub">
            {spec.milestone !== "—" && <><b>{spec.milestone}</b> · </>}
            {spec.persona !== "—" ? <>{spec.persona} · {spec.behavior}</> : "no persona linked"}
          </div>
        </div>

        <div className="spec-drawer-body">
          {spec.status === "blocked" && spec.blockedReason && (
            <div className="spec-blocked">
              <div className="lbl">⏳ why it's blocked</div>
              <div className="t">{spec.blockedReason}</div>
            </div>
          )}

          {liveRun && (
            <div className="spec-liverun" onClick={() => onNav?.(liveRun.route || "run")}>
              <span className="pill run"><span className="d"></span>{liveRun.id}</span>
              <span className="t">{liveRun.note}</span>
              <span className="go">↗</span>
            </div>
          )}

          <div className="spec-block">
            <div className="spec-h">acceptance · bdd</div>
            <Acceptance rows={spec.acceptance} />
          </div>

          <div className="spec-block">
            <div className="spec-h">depends on</div>
            <DepChips titles={spec.dependsOn} onOpenSpec={onOpenSpec} dir="up" />
          </div>
          <div className="spec-block">
            <div className="spec-h">blocks</div>
            <DepChips titles={spec.blocks} onOpenSpec={onOpenSpec} dir="down" />
          </div>

          <div className="spec-meta-grid">
            <div><span className="k">spend</span><b>{spec.cost}</b></div>
            <div><span className="k">cli</span><b>{spec.cli}</b></div>
            <div><span className="k">attempts</span><b>{spec.runs.length || "—"}</b></div>
          </div>
        </div>

        <div className="spec-drawer-foot">
          {specActions(spec, onNav, onAsk).map((a, i) => (
            <button key={i} className={"btn" + (a.primary ? " primary notched" : a.ghost ? " ghost" : "")} onClick={a.go}>{a.label}</button>
          ))}
          <button className="btn ghost spec-expand" onClick={() => onFullPage?.(node)}>open full page ⤢</button>
        </div>
      </aside>
    </div>
  );
};

// =====================================================================
// SPEC VIEW · full page (escalated from the drawer)
// =====================================================================
window.SpecView = ({ node, onNav, onAsk }) => {
  const spec = window.specForNode(node || { t: "supplier scorecard", s: "review" });
  const meta = STATUS_META[spec.status] || STATUS_META.queued;

  return (
    <>
      <PageHead
        eyebrow={<>▮ spec · {spec.id}</>}
        title={<>{spec.title.split(" ").slice(0, -1).join(" ")} <em>{spec.title.split(" ").slice(-1)}</em></>}
        sub={<>{spec.milestone !== "—" ? <>{spec.milestone} · </> : null}{spec.persona !== "—" ? <>{spec.persona} · {spec.behavior}</> : "no persona linked"}</>}
        actions={
          <>
            <span className={"pill " + meta.pill}><span className="d"></span>{meta.label}</span>
            <button className="btn ghost" onClick={() => onNav?.("project")}>← back to dag</button>
            {spec.status === "review" && <button className="btn primary notched" onClick={() => onNav?.("review")}>open review ↗</button>}
            {spec.status === "live" && <button className="btn primary notched" onClick={() => onNav?.("run")}>open live run ↗</button>}
            {spec.status === "queued" && <button className="btn primary notched" onClick={() => onNav?.("discovery")}>forge it now ↗</button>}
          </>
        }
      />
      <div className="page-body scrolls">
        <div className="split-row" style={{ gridTemplateColumns: "1.4fr 1fr", minHeight: 520 }}>
          {/* LEFT — the spec itself */}
          <div className="scroll-col">
            <div className="panel" style={{ padding: "14px 16px", gap: 10 }}>
              <div className="spec-h">description</div>
              <div style={{ fontFamily: "var(--font-ui)", fontSize: 13.5, color: "var(--fg-1)", lineHeight: 1.6, textWrap: "pretty" }}>{spec.desc}</div>
            </div>

            {spec.status === "blocked" && spec.blockedReason && (
              <div className="col-card fail" style={{ gap: 6 }}>
                <div className="h">⏳ blocked</div>
                <div style={{ fontFamily: "var(--font-ui)", fontSize: 13, color: "var(--fg-1)", lineHeight: 1.55 }}>{spec.blockedReason}</div>
                <button className="btn primary notched" style={{ alignSelf: "flex-start", fontSize: 11 }} onClick={() => onAsk?.("blocking_m5")}>ask forge to unblock ↗</button>
              </div>
            )}

            <div className="panel" style={{ padding: "14px 16px", gap: 10 }}>
              <div className="spec-h">acceptance · bdd behaviors</div>
              <Acceptance rows={spec.acceptance} />
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)", lineHeight: 1.5, paddingTop: 6, borderTop: "1px solid var(--line-1)" }}>
                ↑ each line is what the auditor verifies. forge derived these from the persona's behavior — edit the behavior and the spec re-plans.
              </div>
            </div>

            <div className="panel" style={{ padding: "14px 16px", gap: 12 }}>
              <div className="spec-h">dependency chain</div>
              <div className="dep-row">
                <span className="dep-label">depends on</span>
                <DepChips titles={spec.dependsOn} onOpenSpec={(n) => onNav?.("spec", n)} dir="up" />
              </div>
              <div className="dep-row">
                <span className="dep-label">this spec</span>
                <span className={"dep-chip s-" + spec.status + " self"}>{STATUS_META[spec.status].glyph} {spec.title}</span>
              </div>
              <div className="dep-row">
                <span className="dep-label">blocks</span>
                <DepChips titles={spec.blocks} onOpenSpec={(n) => onNav?.("spec", n)} dir="down" />
              </div>
            </div>
          </div>

          {/* RIGHT — run history, cost, actions */}
          <div className="scroll-col">
            <div className="panel" style={{ padding: "14px 16px", gap: 8 }}>
              <div className="spec-h">run history</div>
              {spec.runs.length === 0 ? (
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)", padding: "8px 0" }}>no runs yet · forge hasn't started this spec</div>
              ) : spec.runs.map((r, i) => (
                <div key={i} className={"run-hist" + (r.live ? " live" : "")} onClick={() => r.route && onNav?.(r.route)}>
                  <div className="top">
                    <span className="rid">{r.id}</span>
                    <span className={"oc oc-" + r.outcome}>{r.outcome.replace("_", " ")}</span>
                    <span className="when">{r.when}</span>
                  </div>
                  <div className="note">{r.note}</div>
                  <div className="cost">{r.cost}{r.route && <span className="go"> · open ↗</span>}</div>
                </div>
              ))}
            </div>

            <div className="panel" style={{ padding: "14px 16px", gap: 6 }}>
              <div className="spec-h">economics</div>
              <div className="spec-meta-grid wide">
                <div><span className="k">spend to date</span><b>{spec.cost}</b></div>
                <div><span className="k">writer cli</span><b>{spec.cli}</b></div>
                <div><span className="k">attempts</span><b>{spec.runs.length || "—"}</b></div>
                <div><span className="k">status</span><b>{meta.label}</b></div>
              </div>
            </div>

            <div className="forge-card" style={{ padding: 12, gap: 8 }}>
              <div className="head" style={{ padding: 0, border: 0, background: "transparent" }}>
                <span className="stamp">鍛</span>
                <span className="title">ask forge · <em>this spec</em></span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {["why was this scoped this way?", "what's the riskiest behavior?", "re-rank against the dag", "split this spec"].map((q, i) => (
                  <span key={i} className="chip" onClick={() => onAsk?.("generic")}><span className="pre">↑</span> {q}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

window.SpecDrawer = SpecDrawer;
