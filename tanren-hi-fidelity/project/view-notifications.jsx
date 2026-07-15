// view-notifications.jsx — org-level notifications surface: per-user channel
// prefs + delivery history, layered on top of cat-cave's org defaults.

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
