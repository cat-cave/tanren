// view-discovery.jsx — 02 · Spec Discovery from a new insight.
// Three variations via Tweaks: feature (CSV export) · bug (flaky logins) · strategic (TikTok ads).

const DISCOVERY = {
  feature: {
    eyebrow: "▮ spec discovery · from insight",
    pageTitle: <>forge <em>discovered</em> 1 spec</>,
    autosave: "✓ autosaved · 3s ago",
    actions: [
      ["save · don't add yet", "btn"],
      ["add to dag · 1 spec ↗", "btn primary notched"],
    ],
    insight: {
      source: "hubspot · acme co",
      sourceLabel: "sales call note",
      who: "dani · ae",
      when: "2h ago",
      glyph: "⌥",
      body: <>acme's ops director said their finance team won't sign off on a renewal unless they can <b>export the stats page to csv</b>. they pull these monthly for a board pack — copy-paste isn't acceptable. closing call is friday.</>,
    },
    chat: {
      title: "discovery",
      meta: "3 rounds · ~90% resolved",
      turns: [
        ["forge", <>Read the call note. <b style={{ color: "var(--ember-08)" }}>Sales Manager</b> persona was already in your dag, and your roadmap has a <b style={{ color: "var(--ember-08)" }}>"view stats page" behavior</b> on them. They don't yet have an <b style={{ color: "var(--ember-08)" }}>"export stats data"</b> behavior — that's the gap acme is asking you to fill.</>],
        ["user", "csv only · or also xlsx?"],
        ["forge", <>
          Note says csv specifically. I'd start there and let xlsx be a follow-up if other accounts ask. <b style={{ color: "var(--ember-08)" }}>1 spec</b> covers this:
          <div className="col-card live" style={{ marginTop: 10, padding: 12, gap: 4 }}>
            <div className="h">proposed spec</div>
            <div className="display-h">add csv export to the stats page</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-2)", marginTop: 4, lineHeight: 1.6 }}>
              <div>deliverable · button + <code style={{ color: "var(--ember-07)" }}>GET /api/stats/export.csv</code> + 1 bdd test</div>
              <div>demonstrates · sales manager · export stats data</div>
              <div>depends · stats page already shipped</div>
              <div>est · 2h · $0.45 · priority <b style={{ color: "var(--status-warn)" }}>tbd</b></div>
            </div>
          </div>
        </>],
        ["forge", <>
          Now <b style={{ color: "var(--ember-08)" }}>where in the dag</b>. Three options, ordered by impact on existing work:
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              { p: "slot in after current p1 work", eta: "ready ≈ 2 weeks", side: "no other timelines move", priority: "P2 · end of M3" },
              { p: "jump the p1 backlog", eta: "ready ≈ 3 days", side: "M3 supplier scorecard slips 2 days", priority: "P1 · next after P0s", rec: true },
              { p: "interrupt now", eta: "ready ≈ 4 hours", side: "pause cloudflare bug — not recommended", priority: "P0", risk: true },
            ].map((o, i) => (
              <div key={i} style={{ padding: "8px 10px", background: o.rec ? "var(--accent-tint)" : "var(--bg-sunken)", border: "1px solid " + (o.rec ? "var(--ember-08)" : o.risk ? "var(--status-fail)" : "var(--line-1)"), borderLeft: "2px solid " + (o.rec ? "var(--ember-08)" : o.risk ? "var(--status-fail)" : "var(--line-2)"), borderRadius: 2 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                  <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 13, color: "var(--fg-1)", textTransform: "lowercase" }}>{o.p}</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: o.risk ? "var(--status-fail)" : o.rec ? "var(--ember-08)" : "var(--fg-3)", fontWeight: 700 }}>{o.priority}</div>
                </div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-2)", marginTop: 2, display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ color: "var(--fg-1)" }}>{o.eta}</span>
                  <span style={{ color: o.risk ? "var(--status-warn)" : "var(--fg-3)" }}>↑ {o.side}</span>
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 8, fontSize: 12.5, color: "var(--fg-2)" }}>
            Acme's renewal is friday — the middle option lands in time without bumping P0s. <b style={{ color: "var(--ember-08)" }}>Recommended.</b> What's the call?
          </div>
          <InlineActions>
            <button className="btn primary notched" style={{ fontSize: 11 }}>jump the p1 · 3 days</button>
            <button className="btn" style={{ fontSize: 11 }}>slot after p1 · 2 weeks</button>
            <button className="btn ghost" style={{ fontSize: 11, color: "var(--status-fail)" }}>interrupt p0 · 4 hours</button>
          </InlineActions>
        </>],
      ],
      placeholder: 'refine · "also add per-quarter aggregation" · "what tests does this need?"',
      hint: "powered by read-only answerer · read 7 files · 1.8s",
    },
    deltas: [
      { title: "personas", kind: "impact", count: "1 impacted", deltas: ["sales manager · existing · gains 1 new behavior"] },
      { title: "behaviors", kind: "add", count: "1 added", deltas: ["sales manager · export stats data as csv · for monthly board pack"] },
      { title: "specs", kind: "add", count: "1 proposed", deltas: ["add csv export to stats page · P1 · 2h · $0.45"] },
    ],
    impact: { label: "P1 insertion · after current backlog", costRange: "$0.45", eta: "2h", pre: ["M3 · stats page (shipped)"], newOnes: ["csv export endpoint", "csv button + bdd test"], post: ["M4 · supplier scorecard (next)"] },
  },

  bug: {
    eyebrow: "▮ spec discovery · triage",
    pageTitle: <>forge <em>found</em> the rot</>,
    autosave: "✓ autosaved · 1s ago",
    actions: [
      ["open issue ↗", "btn"],
      ["add to dag · 3 specs · P0 ↗", "btn primary notched"],
    ],
    insight: {
      tone: "fail",
      source: "github · #142",
      sourceLabel: "trouble ticket",
      who: "auto-triaged",
      when: "flaky for 2 weeks",
      glyph: "⌬",
      body: <><b style={{ color: "var(--status-fail)" }}>"user logins are flaky"</b> · multiple users report 1–3 retries to sign in. ci shows the auth e2e test failing intermittently — currently quarantined as <code style={{ color: "var(--ember-07)", background: "var(--bg-sunken)", padding: "0 4px", border: "1px solid var(--line-1)" }}>@flaky</code>. <b>22 production retries in the last 7 days.</b></>,
    },
    chat: {
      title: "triage",
      meta: "read 14 files · 4 tests · 1 ci log",
      turns: [
        ["forge", <>Read the issue + the code. The <b style={{ color: "var(--ember-08)" }}>"user logs in"</b> behavior is in your dag — but the existing spec that built it (<code style={{ color: "var(--ember-07)", background: "var(--bg-sunken)", padding: "0 4px", border: "1px solid var(--line-1)" }}>spec_38c · session middleware</code>) has a test that's been marked <code style={{ color: "var(--status-fail)", background: "var(--bg-sunken)", padding: "0 4px", border: "1px solid var(--line-1)" }}>@flaky</code> for two weeks. That's not the bug — it's the symptom.</>],
        ["forge", <>
          I found a <b style={{ color: "var(--status-fail)" }}>race condition</b> in <code style={{ color: "var(--ember-07)", background: "var(--bg-sunken)", padding: "0 4px", border: "1px solid var(--line-1)" }}>auth/session.ts:42</code> — the session is read before it's flushed in ~3% of logins:
          <pre className="code-block" style={{ marginTop: 8, fontSize: 11 }}>{`  setSession(sess);            // <- write
  return readSession();        // <- race · ~3% read pre-flush`}</pre>
        </>],
        ["forge", <>
          Three specs would close this. None are big.
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              { p: "P0", t: "fix session race · await flush before read", e: "1h · $0.28", crit: true },
              { p: "P0", t: "harden auth e2e · remove @flaky quarantine", e: "1.5h · $0.34" },
              { p: "P1", t: "add session-read trace · catch future regressions", e: "45m · $0.18" },
            ].map((s, i) => (
              <div key={i} style={{ padding: "8px 12px", background: s.crit ? "var(--accent-tint)" : "var(--bg-sunken)", border: "1px solid " + (s.crit ? "var(--ember-08)" : "var(--line-1)"), borderRadius: 2 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: s.p === "P0" ? "var(--status-fail)" : "var(--ember-08)", letterSpacing: "0.16em", fontWeight: 700 }}>{s.p}</span>
                  <span style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 13, color: "var(--fg-1)", textTransform: "lowercase" }}>{s.t}</span>
                  <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)" }}>{s.e}</span>
                </div>
              </div>
            ))}
          </div>
          <InlineActions>
            <button className="btn primary notched" style={{ fontSize: 11 }}>all 3 · P0 ↗</button>
            <button className="btn" style={{ fontSize: 11 }}>just the fix · P0</button>
            <button className="btn ghost" style={{ fontSize: 11 }}>show me the failing test</button>
          </InlineActions>
        </>],
      ],
      placeholder: 'steer · "rollback to 9f3a2b4" · "what if I drop behavior 5?"',
      hint: <><span style={{ color: "var(--status-fail)" }}>↑ existing behavior failed</span><span style={{ margin: "0 8px" }}>·</span><span>no new behaviors · only hardening</span></>,
    },
    deltas: [
      { title: "personas", kind: "impact", count: "all authed users", deltas: ["all authed users · existing · trust restored"] },
      { title: "behaviors", kind: "mod", count: "1 hardened", deltas: ["user logs in · existing · was reliable-on-paper, now reliable-in-fact"] },
      { title: "specs", kind: "add", count: "3 proposed", deltas: ["P0 · fix session race · 1h · $0.28", "P0 · harden auth e2e · 1.5h · $0.34", "P1 · add session-read trace · 45m · $0.18"] },
    ],
    rootCause: <>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--status-fail)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>↑ root cause framing</div>
      <div style={{ fontFamily: "var(--font-ui)", fontSize: 11.5, color: "var(--fg-1)", lineHeight: 1.45, marginTop: 4 }}>
        the spec that built this behavior was accepted with a flaky test. that wasn't tanren's verdict — it was a human override. these specs are the correction.
      </div>
    </>,
    impact: { label: "P0 insertion · interrupt current work", costRange: "$0.80", eta: "3.25h", pre: ["… current backlog paused"], newOnes: ["session race fix", "auth e2e harden", "session trace"], post: ["M3 · ops dashboard continues"] },
  },

  strategic: {
    eyebrow: "▮ spec discovery · strategic addition",
    pageTitle: <>forge <em>scoped</em> 18 specs</>,
    autosave: "✓ autosaved · 5s ago",
    actions: [
      ["save · iterate offline", "btn"],
      ["add cluster · 18 specs ↗", "btn primary notched"],
    ],
    insight: {
      source: "strategy doc · qa-conference-notes.md",
      sourceLabel: "exec note",
      who: "cio",
      when: "yesterday",
      glyph: "↗",
      body: <>"future of acme SaaS is <b>becoming a tiktok-ads first-party tool</b>. every B2B marketing team uses tiktok now — we should let them launch + tune + report from inside our app. <b>this is a Q2 priority.</b>"</>,
    },
    chat: {
      title: "scoping",
      meta: "round 11 of ~14 · large addition",
      turns: [
        ["forge", <>This is a meaningful add — <b style={{ color: "var(--ember-08)" }}>2 new personas</b> and <b style={{ color: "var(--ember-08)" }}>8 new behaviors</b>. Let me name what I think we're building.</>],
        ["forge", <>
          Two new personas, both customer-side:
          <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {[
              { n: "tiktok ad manager", d: "designs campaigns · sets budgets · reads reports", behv: "5" },
              { n: "content creator", d: "uploads creatives · tags · suggests copy", behv: "3" },
            ].map((p, i) => (
              <div key={i} className="col-card live" style={{ padding: 10, gap: 4 }}>
                <div className="h">+ new persona</div>
                <div className="display-h">{p.n}</div>
                <div style={{ fontFamily: "var(--font-ui)", fontSize: 11.5, color: "var(--fg-2)" }}>{p.d}</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ember-08)" }}>{p.behv} new behaviors</div>
              </div>
            ))}
          </div>
        </>],
        ["forge", <>
          The 18 specs land in a <b style={{ color: "var(--ember-08)" }}>new milestone M9 · tiktok ads</b>, depending on your existing auth + billing modules:
          <pre className="code-block" style={{ marginTop: 8, fontSize: 10.5 }}>{`connect · oauth to tiktok ads api (3)
campaign · create / edit / pause crud (4)
creatives · upload / tag / preview (3)
reporting · pivot · csv export · pacing alerts (4)
billing · roll-up of ad spend into invoices (2)
quality · e2e tests · webhook handlers (2)`}</pre>
        </>],
        ["forge", <>
          <b style={{ color: "var(--status-warn)" }}>One open question</b> before I commit: does tiktok ads belong as part of <code style={{ color: "var(--ember-07)", background: "var(--bg-sunken)", padding: "0 4px", border: "1px solid var(--line-1)" }}>tanren-fixture-easy</code>, or as a new project? A 18-spec cluster from a single insight is a lot.
          <InlineActions>
            <button className="btn" style={{ fontSize: 11 }}>add here · keep one repo</button>
            <button className="btn primary notched" style={{ fontSize: 11 }}>fork to new project · tanren-tiktok-ads</button>
            <button className="btn ghost" style={{ fontSize: 11 }}>let me think</button>
          </InlineActions>
        </>],
      ],
      placeholder: 'refine · "split campaign crud into separate epics" · "what about agency permissions?"',
      hint: <><span style={{ color: "var(--ember-08)" }}>↑ large additions auto-suggest fork-to-new-project</span></>,
    },
    deltas: [
      { title: "personas", kind: "add", count: "2 new", deltas: ["tiktok ad manager · marketing role · campaigns + reports", "content creator · creative role · uploads + tags"] },
      { title: "behaviors", kind: "add", count: "8 new", deltas: ["ad mgr · connect tiktok · launch campaign · pause · pacing alert · pivot report", "creator · upload creative · tag + caption · preview before publish"] },
      { title: "specs", kind: "add", count: "18 in new M9 cluster", deltas: ["connect (3) · campaign crud (4) · creatives (3) · reporting (4) · billing (2) · quality (2)"] },
    ],
    scaleCheck: <>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--status-warn)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>↑ scale check</div>
      <div style={{ fontFamily: "var(--font-ui)", fontSize: 11.5, color: "var(--fg-1)", lineHeight: 1.45, marginTop: 4 }}>
        this is ~2 weeks of agent work, $24–$38 in agent cost. forge suggests forking to a sibling project so this doesn't bury your existing dag.
      </div>
    </>,
    impact: { label: "new M9 cluster · post Q2 priority", costRange: "$24–$38", eta: "~2 weeks", pre: ["M8 · cfo reports (in flight)"], newOnes: ["connect", "campaigns", "creatives", "reporting", "billing", "quality"], post: [] },
  },
};

window.DiscoveryView = ({ onNav, variant = "feature" }) => {
  const d = DISCOVERY[variant] || DISCOVERY.feature;

  return (
    <>
      <PageHead
        eyebrow={d.eyebrow}
        title={d.pageTitle}
        sub={<>{d.autosave}</>}
        actions={d.actions.map(([t, c], i) => <button key={i} className={c}>{t}</button>)}
      />
      <div className="page-body scrolls">
        <InsightBanner {...d.insight} />

        <div className="split-row" style={{ gridTemplateColumns: "1.4fr 1fr", minHeight: 540 }}>
          <ForgeChat
            title={d.chat.title}
            meta={d.chat.meta}
            placeholder={d.chat.placeholder}
            hint={d.chat.hint}
          >
            {d.chat.turns.map(([who, body], i) => (
              <Turn key={i} who={who}>{body}</Turn>
            ))}
          </ForgeChat>

          <div className="scroll-col">
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.22em", textTransform: "uppercase", fontWeight: 700 }}>▮ what's changing</div>
            {d.deltas.map((dd, i) => <DeltaCard key={i} {...dd} />)}
            {d.rootCause && (
              <div className="col-card fail" style={{ padding: 10, gap: 4 }}>
                {d.rootCause}
              </div>
            )}
            {d.scaleCheck && (
              <div className="col-card warn" style={{ padding: 10, gap: 4 }}>
                {d.scaleCheck}
              </div>
            )}
            {!d.rootCause && !d.scaleCheck && (
              <div className="col-card" style={{ padding: 10, gap: 4 }}>
                <div className="h">● unchanged</div>
                <div style={{ fontFamily: "var(--font-ui)", fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.4 }}>
                  rest of dag · roadmap · interfaces · architecture · design dna · governance posture
                </div>
              </div>
            )}
          </div>
        </div>

        <DAGImpact {...d.impact} />
      </div>
    </>
  );
};
