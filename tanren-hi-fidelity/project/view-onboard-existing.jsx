// view-onboard-existing.jsx — 01c · Existing Project (brownfield). 5 steps.
// This module holds the header, the shared step list, and steps E1 (link
// repo) + E2 (conversational recon). Steps E3/E4 live in
// view-onboard-existing-config.jsx and E5 + the ExistingProjectView wrapper
// live in view-onboard-existing-gov.jsx — split under the 500-line cap.

const EXIST_STEPS = [
  { label: "link repo" },
  { label: "agent reads · you confirm" },
  { label: "config injection pr" },
  { label: "spec dag + ingest" },
  { label: "governance" },
];

// ===== E1 · Link Repo =====
const ExistConnect = () => (
  <>
    <StepHeading
      eyebrow="step 1 · pick a repo the tanren github app already sees"
      title="point at"
      em="reality"
      sub="org setup already authorized the tanren github app on cat-cave. pick a repo · the read-only answerer agent starts reading immediately so step 2 is fast."
    />
    <div className="cols-2-1">
      <div className="col-card" style={{ padding: 0, overflow: "hidden", minHeight: 0 }}>
        <div className="h" style={{ padding: "12px 14px", borderBottom: "1px solid var(--line-1)" }}><span>repos · <em style={{ color: "var(--ember-08)" }}>cat-cave</em></span><span className="pill ok" style={{ marginLeft: "auto", fontSize: 9 }}><span className="d"></span>9 repos visible</span></div>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line-1)" }}>
          <div style={{ padding: "6px 10px", background: "var(--bg-sunken)", border: "1px solid var(--line-1)", fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-3)", borderRadius: 2 }}>
            <span style={{ color: "var(--ember-08)", marginRight: 6 }}>⌕</span> filter repos…
          </div>
        </div>
        <div style={{ flex: 1, overflow: "auto" }}>
          {[
            { name: "tanren", desc: "the platform itself", priv: false, linked: true, last: "3m" },
            { name: "tanren-fixture-easy", desc: "smoke fixture · 47 open issues · 200 commits", priv: false, linked: false, last: "27m", primary: true },
            { name: "cat-cave-www", desc: "marketing site", priv: false, linked: true, last: "2d" },
            { name: "tw-notes", desc: "personal notebook", priv: true, linked: false, last: "9d" },
            { name: "tanren-runner-images", desc: "runner image sources", priv: false, linked: false, last: "5d" },
            { name: "supply-chain-os", desc: "new project · greenfield · in interview", priv: true, linked: true, last: "4h" },
          ].map((r, i) => (
            <div key={i} style={{
              padding: "10px 14px",
              borderBottom: "1px solid var(--line-1)",
              background: r.primary ? "var(--accent-tint)" : "transparent",
              borderLeft: r.primary ? "2px solid var(--ember-08)" : "2px solid transparent",
              display: "grid", gridTemplateColumns: "16px 1fr auto auto", alignItems: "center", gap: 12,
            }}>
              <div style={{ width: 14, height: 14, border: "1.5px solid " + (r.primary ? "var(--ember-08)" : "var(--line-2)"), background: r.primary ? "var(--ember-08)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-mono)", fontSize: 8, color: "var(--ink-12)", fontWeight: 700, borderRadius: 2 }}>{r.primary ? "●" : ""}</div>
              <div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--fg-1)", fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
                  {r.name}
                  {r.priv && <span style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, color: "var(--fg-3)", letterSpacing: "0.16em", padding: "1px 4px", border: "1px solid var(--line-1)" }}>PRIVATE</span>}
                  {r.linked && <span className="pill ok" style={{ fontSize: 8.5 }}><span className="d"></span>already linked</span>}
                  {r.primary && <span className="pill hot" style={{ fontSize: 8.5 }}><span className="d"></span>selected</span>}
                </div>
                <div style={{ fontFamily: "var(--font-ui)", fontSize: 11, color: "var(--fg-3)", marginTop: 1 }}>{r.desc}</div>
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)" }}>{r.last}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>↗</div>
            </div>
          ))}
        </div>
        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--line-1)", background: "var(--bg-sunken)", display: "flex", alignItems: "center", fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-2)" }}>
          <span>can't see your repo? <a style={{ color: "var(--ember-08)", textDecoration: "underline", cursor: "pointer" }}>add it to the tanren github app ↗</a></span>
          <span style={{ marginLeft: "auto", color: "var(--fg-3)" }}>1 selected</span>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="col-card live" style={{ gap: 8 }}>
          <div className="h">↑ what happens when you click next</div>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6, fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-1)", lineHeight: 1.45 }}>
            {[
              "tanren spawns a read-only answerer agent in a runner",
              "it clones the repo and reads everything: code, tests, configs, docs, issues",
              "it pre-fills brief, personas, behaviors, interfaces, architecture",
              "then you chat to fill the gaps · maybe 4–5 quick questions",
            ].map((t, i) => (
              <li key={i} style={{ paddingLeft: 16, position: "relative" }}>
                <span style={{ position: "absolute", left: 0, color: "var(--ember-08)" }}>▸</span>{t}
              </li>
            ))}
          </ul>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-2)", marginTop: 4 }}>
            ↑ no writes happen until the config-injection pr in step 3
          </div>
        </div>

        <div className="col-card" style={{ gap: 8 }}>
          <div className="h"><span>what tanren <em style={{ color: "var(--ember-08)" }}>can do</em></span><span className="pill cold" style={{ marginLeft: "auto", fontSize: 9 }}><span className="d"></span>github app scope</span></div>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-1)" }}>
            <li><span style={{ color: "var(--status-ok)", marginRight: 6 }}>✓</span>clone & push from runner workspaces</li>
            <li><span style={{ color: "var(--status-ok)", marginRight: 6 }}>✓</span>open draft PRs from <code style={{ color: "var(--ember-07)" }}>tanren/spec_*</code> branches</li>
            <li><span style={{ color: "var(--status-ok)", marginRight: 6 }}>✓</span>poll ci check status</li>
            <li><span style={{ color: "var(--status-ok)", marginRight: 6 }}>✓</span>read org members for review-gate routing</li>
            <li style={{ color: "var(--fg-3)", marginTop: 6 }}><span style={{ marginRight: 6 }}>×</span>never push to main · never bypass protection · never force-push</li>
            <li style={{ color: "var(--fg-3)" }}><span style={{ marginRight: 6 }}>×</span>no access to org billing, secrets, settings</li>
          </ul>
        </div>
      </div>
    </div>
  </>
);

// ===== E2 · Conversational recon =====
const ExistRecon = () => (
  <>
    <StepHeading
      eyebrow="step 2 · the agent read everything · you fill the gaps"
      title="forge already"
      em="knows most of it"
      sub="while you walked through step 1, the read-only answerer indexed 84 files. forge confirms what it inferred; you correct or clarify what it couldn't."
      right={<span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ember-08)" }}>powered by read-only answerer · same agent kind as check/audit</span>}
    />
    <div className="cols-2-narrow">
      <ForgeChat
        title="recon"
        meta={<><span>indexed <b style={{ color: "var(--fg-1)" }}>84 files · 12.4s</b></span><span style={{ color: "var(--fg-4)", margin: "0 6px" }}>·</span><span><b style={{ color: "var(--status-ok)" }}>78%</b> read</span></>}
        placeholder='answer above · "show me /api/user/preferences" · "what files import settings.tsx?"'
        hint={<><span style={{ color: "var(--status-ok)" }}>✓ autosaved 1s ago</span><span style={{ color: "var(--fg-4)", margin: "0 8px" }}>·</span><span>read-only answerer is also available in /forge after this</span></>}
      >
        <Turn>
          I read <b style={{ color: "var(--ember-08)" }}>tanren-fixture-easy</b> end-to-end. From <code style={{ color: "var(--ember-07)", background: "var(--bg-sunken)", padding: "0 4px", border: "1px solid var(--line-1)", fontSize: 11 }}>README.md</code>, <code style={{ color: "var(--ember-07)", background: "var(--bg-sunken)", padding: "0 4px", border: "1px solid var(--line-1)", fontSize: 11 }}>package.json</code>, and the <code style={{ color: "var(--ember-07)", background: "var(--bg-sunken)", padding: "0 4px", border: "1px solid var(--line-1)", fontSize: 11 }}>src/</code> tree, I think this is a <b style={{ color: "var(--ember-08)" }}>smoke fixture</b> for the tanren agentic loop. Sound right?
        </Turn>
        <Turn who="user">
          yes · exactly that. one developer persona running the fixture, no real users
        </Turn>
        <Turn>
          Saved. <b style={{ color: "var(--ember-08)" }}>3 things I couldn't decide on my own</b>:
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              { lbl: "↑ gap 1 · design dna", q: "The repo has no clear design system. Should I default to industrial (tanren-style), or import something specific?", actions: [["use industrial", true], ["import from url"], ["ask me later", "ember"]] },
              { lbl: "↑ gap 2 · existing tests", q: "I see vitest in deps but only one test file. Is that intentional or should tanren's first specs include test coverage?", actions: [["intentional", true], ["add coverage specs", true]] },
              { lbl: "↑ gap 3 · external pushes", q: "The repo has 14 contributors who push directly to feature branches. Auto-spec their changes, or stay out of their way?", actions: [["defer to step 5", "ember"]] },
            ].map((g, i) => (
              <div key={i} className="col-card warn" style={{ padding: "10px 12px", gap: 4 }}>
                <div className="h">{g.lbl}</div>
                <div style={{ fontFamily: "var(--font-ui)", fontSize: 12.5, color: "var(--fg-1)", lineHeight: 1.45 }}>{g.q}</div>
                <InlineActions>
                  {g.actions.map(([t, k], j) => (
                    <button key={j} className={"btn" + (k === true ? "" : " ghost")} style={{ fontSize: 11, ...(k === "ember" ? { color: "var(--ember-08)" } : {}) }}>{t}</button>
                  ))}
                </InlineActions>
              </div>
            ))}
          </div>
        </Turn>
      </ForgeChat>

      <div className="scroll-col">
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.22em", textTransform: "uppercase", fontWeight: 700 }}>▮ what the agent extracted · 7 of 8 chapters</div>

        {[
          { ch: "identity", state: "done", body: <>
            <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--fg-1)", textTransform: "lowercase" }}>tanren-fixture-easy</div>
            <div style={{ fontFamily: "var(--font-ui)", fontSize: 11.5, color: "var(--fg-2)" }}>smoke fixture for the tanren agentic loop</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ember-08)", marginTop: 4 }}>↑ from README.md · package.json</div>
          </> },
          { ch: "personas · 1 captured", state: "done", body: <div style={{ background: "var(--bg-sunken)", border: "1px solid var(--line-1)", borderLeft: "2px solid var(--ember-08)", padding: "5px 8px", borderRadius: 1 }}>
            <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 11.5, color: "var(--fg-1)", textTransform: "lowercase" }}>developer · fixture operator</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ember-08)" }}>↑ inferred · no other users in code</div>
          </div> },
          { ch: "behaviors · 4 captured", state: "done", body: <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-2)", lineHeight: 1.55 }}>
            {["dev · run the e2e fixture", "dev · view current theme setting", "dev · toggle theme via api", "dev · sync theme to profile"].map((t, i) => <div key={i} style={{ color: "var(--fg-1)" }}>{t}</div>)}
            <div style={{ marginTop: 4, color: "var(--ember-08)", fontStyle: "italic", fontSize: 10 }}>↑ from settings.tsx + /api routes</div>
          </div> },
          { ch: "architecture · detected", state: "done", body: <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-2)", lineHeight: 1.6 }}>
            <div><span style={{ color: "var(--fg-3)" }}>web</span> · next.js 14 · turborepo</div>
            <div><span style={{ color: "var(--fg-3)" }}>data</span> · postgres · prisma</div>
            <div><span style={{ color: "var(--fg-3)" }}>deploy</span> · vercel · main → prod</div>
            <div><span style={{ color: "var(--fg-3)" }}>ci</span> · github actions · 3 workflows <span style={{ color: "var(--fg-4)" }}>(repo)</span></div>
            <div><span style={{ color: "var(--fg-3)" }}>delivery</span> · tanren/gate · not seeded</div>
            <div><span style={{ color: "var(--fg-3)" }}>tests</span> · vitest · 1 file (gap 2)</div>
          </div> },
          { ch: "design dna · needs your input", state: "gap", body: <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--status-warn)" }}>↑ awaiting answer · gap 1 in chat</div> },
          { ch: "risks · 3 flagged", state: "warn", body: <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-2)", lineHeight: 1.55 }}>
            <div><span style={{ color: "var(--status-warn)", marginRight: 6 }}>!</span>14 direct-push contributors</div>
            <div><span style={{ color: "var(--status-warn)", marginRight: 6 }}>!</span>no codeowners file</div>
            <div><span style={{ color: "var(--steel-08)", marginRight: 6 }}>i</span>no .tanren/ci.yml · native gate not seeded</div>
          </div> },
        ].map((c, i) => (
          <div key={i} className={"col-card" + (c.state === "gap" || c.state === "warn" ? " warn" : "")} style={{ padding: "10px 12px", gap: 6 }}>
            <div className="h">
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, marginRight: 4, color: c.state === "done" ? "var(--status-ok)" : c.state === "gap" ? "var(--status-warn)" : c.state === "warn" ? "var(--status-warn)" : "var(--fg-3)" }}>
                {c.state === "done" ? "✓" : c.state === "gap" ? "?" : c.state === "warn" ? "!" : "✎"}
              </span>
              <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 13, color: "var(--fg-1)", letterSpacing: "-0.018em", textTransform: "lowercase" }}>{c.ch}</span>
            </div>
            {c.body}
          </div>
        ))}
      </div>
    </div>
  </>
);
