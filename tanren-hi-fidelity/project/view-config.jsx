// view-config.jsx — 10 · tanren-config · audit gate (config-as-code PR review).
// When the audit gate is ON, forge's routing/limit edits land as a PR in
// cat-cave/tanren-config and run review → CI → merge before taking effect.
// When OFF, edits land in the dashboard directly (no PR). Reachable from
// Settings ("enable audit gate" / "propose pr") and the sidebar.

const DIFF_LINE_CLASS = {
  add: "ln-add", rem: "ln-rem", comment: "ln-comment", ctx: "", key: "ln-key",
};

window.ConfigView = ({ onNav, auditGate, setAuditGate }) => {
  const C = window.CONFIG_PR;
  const [merged, setMerged] = React.useState(false);

  // ----- GATE OFF: no PR review; edits are live in the dashboard. -----
  if (!auditGate) {
    return (
      <>
        <PageHead
          eyebrow="▮ tanren-config · audit gate"
          title={<>config as <em>code</em></>}
          sub={<>routing &amp; limits currently live in the dashboard · changes apply immediately, no review</>}
          actions={<button className="btn ghost" onClick={() => onNav?.("settings")}>← routing &amp; limits</button>}
        />
        <div className="page-body scrolls">
          <div className="col-card" style={{ gap: 12, padding: "16px 18px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.22em", textTransform: "uppercase", fontWeight: 700 }}>▮ gate · off</span>
              <span style={{ fontFamily: "var(--font-ui)", fontSize: 13, color: "var(--fg-1)", lineHeight: 1.55, maxWidth: 640 }}>
                Forge edits routing and limits straight into the dashboard. Fast, but unreviewed. Turn the audit gate on to make every config change land as a reviewable PR in <code>cat-cave/tanren-config</code> — with schema validation, a diff, and a merge step.
              </span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn primary notched" onClick={() => setAuditGate?.(true)}>enable audit gate ↗</button>
              <button className="btn" onClick={() => onNav?.("settings")}>edit in dashboard instead</button>
            </div>
          </div>

          <div className="panel" style={{ padding: 0, overflow: "hidden", flexShrink: 0 }}>
            <div className="panel-head"><h3>config <em>history</em></h3><span className="meta">last changes · dashboard-applied</span></div>
            {C.history.map((h, i) => (
              <div key={i} className="config-hist-row">
                <span className="v">{h.v.replace("PR ", "")}</span>
                <span className="t">{h.t}</span>
                <span className="who">{h.who}</span>
                <span className="when">{h.when}</span>
                <span className="state merged">applied</span>
              </div>
            ))}
          </div>
        </div>
      </>
    );
  }

  // ----- GATE ON: the live config PR, ready to review + merge. -----
  return (
    <>
      <PageHead
        eyebrow={<>▮ {C.pr} · {C.repo}</>}
        title={<>review the <em>config</em> change</>}
        sub={<>{C.file} · proposed by {C.proposedBy} · branch <b>{C.branch}</b></>}
        actions={
          <>
            <button className="btn ghost" onClick={() => onNav?.("settings")}>← routing &amp; limits</button>
            <button className="btn">open on github ↗</button>
            <button className="btn" onClick={() => setAuditGate?.(false)}>disable gate</button>
          </>
        }
      />
      <div className="page-body scrolls">
        <div className="split-row" style={{ gridTemplateColumns: "1.45fr 1fr", minHeight: 480 }}>
          {/* LEFT — forge's rationale + the YAML diff */}
          <div className="scroll-col">
            <div className="forge-card" style={{ padding: 0 }}>
              <div className="head">
                <span className="stamp">鍛</span>
                <span className="title">forge · <em>proposed this</em></span>
                <span className="meta">config pr · ci {C.ci}</span>
              </div>
              <div className="body" style={{ gap: 12 }}>
                <ForgeTurn>{C.summary}</ForgeTurn>
              </div>
            </div>

            <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
              <div className="panel-head">
                <h3>{C.file} · <em>diff</em></h3>
                <span className="meta">{C.diff.filter(l => l.t === "add").length} added · {C.diff.filter(l => l.t === "rem").length} removed</span>
              </div>
              <div className="code-block" style={{ border: 0, borderRadius: 0 }}>
                {C.diff.map((l, i) => (
                  <div key={i} className={"diff-ln " + DIFF_LINE_CLASS[l.t]}>
                    <span className="gutter">{l.t === "add" ? "+" : l.t === "rem" ? "−" : " "}</span>
                    <span>{l.s || "\u00a0"}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* RIGHT — CI checks, impact, history */}
          <div className="scroll-col">
            <div className="panel" style={{ padding: "14px 16px", gap: 8 }}>
              <div className="spec-h">checks · <span style={{ color: "var(--status-ok)" }}>{C.ci}</span></div>
              {C.checks.map((c, i) => (
                <div key={i} className="config-check"><span className="g">✓</span>{c}</div>
              ))}
            </div>

            <div className="panel" style={{ padding: "14px 16px", gap: 8 }}>
              <div className="spec-h">impact</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {C.impact.map((m, i) => (
                  <div key={i} className="config-impact">
                    <span className="l">{m.l}</span>
                    <span className="v">{m.v}</span>
                    <span className="k">{m.k}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
              <div className="panel-head"><h3>config <em>history</em></h3></div>
              {C.history.map((h, i) => (
                <div key={i} className="config-hist-row">
                  <span className="v">{h.v.replace("PR ", "")}</span>
                  <span className="t">{h.t}</span>
                  <span className="who">{h.who}</span>
                  <span className="state merged">merged</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Merge gate */}
      <div className="readiness">
        <span className="pill ok"><span className="d"></span>ci green</span>
        <span className="pill ok"><span className="d"></span>schema valid</span>
        <span className={"pill " + (merged ? "ok" : "warn")}><span className="d"></span>{merged ? "merged · config live" : "awaiting your review"}</span>
        <span className="note">{merged ? "· the new routing is in effect" : "· merging applies the routing change to every new run"}</span>
        <div className="grow">
          <button className="btn danger">request changes ↗</button>
          <button className="btn primary notched" disabled={merged} onClick={() => setMerged(true)}>
            {merged ? "merged ✓" : "approve · merge config"}
          </button>
        </div>
      </div>
    </>
  );
};
