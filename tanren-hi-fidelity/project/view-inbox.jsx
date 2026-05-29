// view-inbox.jsx — 12 · Candidate inbox (issue ingestion · runs.trigger=webhook).
// Sources are CONFIGURABLE connectors, not hardcoded. Scheduled-audit findings
// auto-route (system, no manual triage); external issues get the full forge
// triage: dedupe → match to a spec/milestone → propose DAG placement → accept
// routes to Discovery. The intake mouth of the whole loop.

const SOURCE_GLYPH = {
  issues: "◍", errors: "×", system: "⟳", manual: "✎", add: "+",
};
const VERDICT_META = {
  "auto-routable": { cls: "auto", label: "auto-routed" },
  "needs your call": { cls: "decide", label: "needs you" },
  "dedupe → close": { cls: "dupe", label: "duplicate" },
};

// Forge's triage read-out on a candidate.
const TriageReadout = ({ t }) => (
  <div className="triage">
    <div className="trow"><span className="tk">dedupe</span><span className="tv">{t.dedupe}</span></div>
    <div className="trow"><span className="tk">match</span><span className="tv">{t.match}</span></div>
    <div className="trow"><span className="tk">placement</span><span className="tv accent">{t.placement}</span></div>
  </div>
);

window.InboxView = ({ onNav }) => {
  const [items, setItems] = React.useState(window.CANDIDATES.map(c => ({ ...c, resolved: c.auto ? "auto-routed" : null })));
  const resolve = (id, label) => setItems(xs => xs.map(x => x.id === id ? { ...x, resolved: label } : x));

  const counts = {
    auto: items.filter(i => i.auto).length,
    decide: items.filter(i => !i.auto && i.triage.verdict === "needs your call" && !i.resolved).length,
    dupe: items.filter(i => i.triage.verdict === "dedupe → close").length,
  };

  return (
    <>
      <PageHead
        eyebrow="▮ intake · candidate inbox"
        title={<>where work <em>comes from</em></>}
        sub={<>configurable issue sources · forge triages each into the dag · you decide placement</>}
        actions={
          <>
            <button className="btn ghost" onClick={() => onNav?.("discovery")}>discover manually ↗</button>
            <button className="btn primary notched">ask forge to triage all</button>
          </>
        }
      />
      <div className="page-body scrolls">
        <KpiStrip items={[
          { l: "candidates", v: String(items.length), k: "across all sources" },
          { l: "auto-routed", v: String(counts.auto), k: "scheduled findings · no triage", ok: true },
          { l: "needs you", v: String(counts.decide), k: "placement decisions", hot: true },
          { l: "duplicates", v: String(counts.dupe), k: "dedupe → close" },
          { l: "sources", v: String(window.INBOX_SOURCES.filter(s => s.on).length), k: "connected · configurable" },
        ]} />

        <div className="split-row" style={{ gridTemplateColumns: "260px 1fr", minHeight: 480 }}>
          {/* LEFT — configurable sources */}
          <div className="col-card" style={{ gap: 8, minHeight: 0, overflow: "auto" }}>
            <div className="h"><span><em style={{ color: "var(--ember-08)" }}>sources</em></span><span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>configurable</span></div>
            {window.INBOX_SOURCES.map((s, i) => (
              <div key={i} className={"source-row" + (s.kind === "add" ? " add" : "") + (s.on ? " on" : "")}>
                <span className="sg">{SOURCE_GLYPH[s.kind] || "▮"}</span>
                <div className="smid">
                  <div className="sn">{s.name}{s.auto && <span className="auto-tag">auto</span>}</div>
                  <div className="sd">{s.detail}</div>
                </div>
                {s.kind !== "add" && <div className={"toggle " + (s.on ? "on" : "off")}><div className="knob"></div></div>}
              </div>
            ))}
            <div style={{ marginTop: 6, padding: "10px 12px", background: "var(--bg-sunken)", border: "1px solid var(--line-1)", borderLeft: "2px solid var(--ember-08)", borderRadius: 2 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>no hardcoded sources</div>
              <div style={{ fontFamily: "var(--font-ui)", fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.45 }}>
                Any webhook or polled endpoint can feed candidates. System sources like scheduled audits auto-route their findings; external issues wait for your call.
              </div>
            </div>
          </div>

          {/* MAIN — candidate stream */}
          <div className="scroll-col">
            {items.map((c) => {
              const vm = VERDICT_META[c.triage.verdict] || VERDICT_META["needs your call"];
              return (
                <div key={c.id} className={"candidate v-" + vm.cls + (c.resolved ? " resolved" : "")}>
                  <div className="cand-head">
                    <span className={"cand-src sev-" + c.sev}>{SOURCE_GLYPH[c.kind] || "▮"} {c.source}</span>
                    <span className="cand-proj">{c.project}</span>
                    <span className={"cand-verdict " + vm.cls}>{c.resolved || vm.label}</span>
                    <span className="cand-age">{c.age}</span>
                  </div>
                  <div className="cand-title">{c.title}</div>
                  <div className="cand-body">{c.body}</div>

                  <TriageReadout t={c.triage} />

                  {!c.resolved ? (
                    <div className="cand-actions">
                      {c.auto ? (
                        <>
                          <span className="auto-note">↻ forge auto-routed this — no action needed</span>
                          <button className="btn ghost" onClick={() => resolve(c.id, "reverted")} style={{ fontSize: 11 }}>undo</button>
                        </>
                      ) : c.triage.verdict === "dedupe → close" ? (
                        <>
                          <button className="btn primary notched" style={{ fontSize: 11 }} onClick={() => resolve(c.id, "closed · duplicate")}>close as done</button>
                          <button className="btn ghost" style={{ fontSize: 11 }} onClick={() => resolve(c.id, "kept open")}>keep open</button>
                        </>
                      ) : (
                        <>
                          <button className="btn primary notched" style={{ fontSize: 11 }} onClick={() => onNav?.("discovery")}>accept · open in discovery ↗</button>
                          <button className="btn" style={{ fontSize: 11 }} onClick={() => resolve(c.id, "folded into live run")}>fold into live run</button>
                          <button className="btn ghost" style={{ fontSize: 11 }} onClick={() => resolve(c.id, "dismissed")}>dismiss</button>
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="cand-actions"><span className="resolved-note">✓ {c.resolved}</span><button className="btn ghost" style={{ fontSize: 11 }} onClick={() => resolve(c.id, null)}>reopen</button></div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
};
