// view-onboard-existing.jsx — 01c · Existing Project (brownfield). 5 steps.

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
            <div><span style={{ color: "var(--fg-3)" }}>ci</span> · github actions · 3 workflows</div>
            <div><span style={{ color: "var(--fg-3)" }}>tests</span> · vitest · 1 file (gap 2)</div>
          </div> },
          { ch: "design dna · needs your input", state: "gap", body: <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--status-warn)" }}>↑ awaiting answer · gap 1 in chat</div> },
          { ch: "risks · 3 flagged", state: "warn", body: <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-2)", lineHeight: 1.55 }}>
            <div><span style={{ color: "var(--status-warn)", marginRight: 6 }}>!</span>14 direct-push contributors</div>
            <div><span style={{ color: "var(--status-warn)", marginRight: 6 }}>!</span>no codeowners file</div>
            <div><span style={{ color: "var(--steel-08)", marginRight: 6 }}>i</span>no mergify config detected</div>
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

// ===== E3 · Config injection PR =====
const ExistConfig = () => (
  <>
    <StepHeading
      eyebrow="step 3 · config injection pr"
      title="review what"
      em="we'll add"
      sub="tanren proposes the integration files based on what the agent read. nothing lands until you merge this pr. reject any file; tanren adapts."
      right={<span className="pill ok"><span className="d"></span>one pr · then it's yours</span>}
    />
    <div className="cols-2-narrow" style={{ gridTemplateColumns: "260px 1fr" }}>
      <div className="col-card" style={{ padding: 0, overflow: "hidden", minHeight: 0 }}>
        <div className="h" style={{ padding: "10px 14px", borderBottom: "1px solid var(--line-1)" }}><span>files · <em style={{ color: "var(--ember-08)" }}>6</em></span><span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--status-ok)" }}>+218 −0</span></div>
        {[
          { f: ".tanren/PROJECT.md", add: 64, sel: true, snapshot: true },
          { f: ".github/workflows/tanren-ci.yml", add: 84 },
          { f: ".mergify.yml", add: 42 },
          { f: "CODEOWNERS", add: 14 },
          { f: ".gitignore", add: 4, note: "mod" },
          { f: "PULL_REQUEST_TEMPLATE.md", add: 36, note: "mod" },
        ].map((f, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "16px 1fr auto", gap: 8, alignItems: "center", padding: "8px 14px", background: f.sel ? "var(--accent-tint)" : "transparent", borderLeft: f.sel ? "2px solid var(--ember-08)" : "2px solid transparent", borderBottom: "1px solid var(--line-1)", cursor: "pointer" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--status-ok)", fontWeight: 700 }}>+</span>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: f.sel ? "var(--fg-1)" : "var(--fg-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {f.f}
              {f.note && <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--status-warn)", letterSpacing: "0.12em", marginLeft: 4 }}>· {f.note}</span>}
              {f.snapshot && <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.12em", marginLeft: 4 }}>· snapshot</span>}
            </div>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--status-ok)" }}>+{f.add}</span>
          </div>
        ))}
        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--line-1)", background: "var(--bg-sunken)", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)", marginTop: "auto" }}>
          pr will target <b style={{ color: "var(--fg-1)" }}>main</b><br />
          from branch <b style={{ color: "var(--ember-08)" }}>tanren/integrate</b>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <div className="col-card" style={{ padding: 0, overflow: "hidden", flex: 1, minHeight: 0 }}>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line-1)", background: "var(--bg-sunken)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-1)" }}>.tanren/PROJECT.md</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--status-ok)" }}>+64 lines</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700, padding: "2px 6px", border: "1px solid var(--ember-08)", borderRadius: 1 }}>one-time snapshot</span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button className="btn ghost" style={{ fontSize: 11, color: "var(--ember-08)" }}>ask forge to revise ↗</button>
              <button className="btn ghost" style={{ fontSize: 11, color: "var(--status-fail)" }}>× exclude this file</button>
            </span>
          </div>
          <div style={{ padding: "8px 14px", background: "oklch(68% 0.22 40 / 0.05)", borderBottom: "1px solid var(--line-1)", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-2)", lineHeight: 1.5 }}>
            <span style={{ color: "var(--ember-08)", marginRight: 6 }}>▸</span>
            generated mirror of project config at onboarding · regenerated only on opt-in via the audit gate · <b style={{ color: "var(--fg-1)" }}>don't edit by hand</b>. live config is in the orchestrator dashboard.
          </div>
          <pre className="code-block" style={{ flex: 1, margin: 0, borderTop: "none", borderLeft: "none", borderRight: "none", borderBottom: "none" }}>
{`# tanren-fixture-easy

> Generated by tanren at onboarding · 2026-05-28 14:22 UTC
> Source of truth: orchestrator dashboard · /projects/tanren-fixture-easy

## identity

- **org** · cat-cave
- **repo** · github.com/cat-cave/tanren-fixture-easy
- **purpose** · smoke fixture for the tanren agentic loop

## personas

- **developer · fixture operator** — runs the e2e fixture, no real users

## behaviors (4 captured)

- dev · run the e2e fixture
- dev · view current theme setting
- dev · toggle theme via api
- dev · sync theme to profile

## architecture

- **web** · next.js 14 · turborepo · pnpm
- **data** · postgres · prisma
- **deploy** · vercel · main → prod
- **ci** · github actions · 3 workflows

## guardrails

- never push to: main, release/*
- never force-push, never delete branches
- runner: local-docker · 4gb · tanren-runner image

## routing

- writers default to org chain · see dashboard /settings/routing
- retries: max 3 · on exceed → escalate

## merge posture

- strict — every change goes through a spec
- on external push → warn (settle in step 5)
- codeowner review required

---

edit the live config in the dashboard. this file regenerates only when the audit gate is enabled.`}
          </pre>
        </div>

        <div className="col-card live" style={{ padding: 12, flexDirection: "row", alignItems: "center", gap: 12 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>↑ before you click</span>
          <div style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-1)", lineHeight: 1.4, flex: 1 }}>
            this opens pr <b style={{ color: "var(--ember-08)" }}>#48</b> on cat-cave/tanren-fixture-easy. tanren will NOT start runs until you merge it. comment, edit, or reject like any other pr.
          </div>
          <button className="btn primary notched">open the pr ↗</button>
        </div>
      </div>
    </div>
  </>
);

// ===== E4 · Spec DAG + issue ingest =====
const ExistDag = () => (
  <>
    <StepHeading
      eyebrow="step 4 · spec dag · agent gaps + github issues"
      title="35 specs"
      em="ready to forge"
      sub="the agent's gap analysis became seed specs. your 47 open github issues became candidate specs. forge merged dupes and routed by labels."
      right={<span className="pill ok"><span className="d"></span>seeded from issues + gaps</span>}
    />
    <div style={{ background: "var(--bg-sunken)", border: "1px solid var(--line-1)", borderRadius: 4, position: "relative", overflow: "hidden", backgroundImage: "radial-gradient(var(--line-1) 1px, transparent 1px)", backgroundSize: "22px 22px", flex: 1, minHeight: 0 }}>
      <div style={{ position: "absolute", top: 12, left: 16, right: 16, display: "flex", alignItems: "center", gap: 10, zIndex: 4 }}>
        <span className="pill hot" style={{ fontSize: 9 }}><span className="d"></span>35 specs · 12 from gaps · 23 from issues</span>
        <span className="pill ok" style={{ fontSize: 9 }}><span className="d"></span>4 dupes dropped · 1 critical (#142 p0)</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)" }}>est cost $28–$52 · ~2 weeks</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          <button className="seg-btn">≡ source</button>
          <button className="seg-btn active">≡ priority</button>
          <button className="seg-btn">fit</button>
        </div>
      </div>

      <svg viewBox="0 0 1100 580" preserveAspectRatio="xMidYMid meet" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        <defs>
          <marker id="exarr-cool" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7" fill="var(--line-2)" /></marker>
          <marker id="exarr-hot" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7" fill="var(--ember-08)" /></marker>
        </defs>

        {[
          { x: 80,  label: "P0", spec: "critical · 1" },
          { x: 280, label: "P1", spec: "high · 9" },
          { x: 540, label: "P2", spec: "med · 16" },
          { x: 820, label: "P3", spec: "low · 9" },
        ].map((m) => (
          <g key={m.label}>
            <text x={m.x + 80} y={62} fill="var(--fg-3)" fontFamily="var(--font-mono)" fontSize="10" textAnchor="middle" letterSpacing="0.18em" fontWeight="700">{m.label}</text>
            <text x={m.x + 80} y={78} fill="var(--fg-3)" fontFamily="var(--font-mono)" fontSize="9.5" textAnchor="middle">{m.spec}</text>
          </g>
        ))}

        <g transform="translate(80, 110)">
          <rect width="160" height="22" rx="2" fill="var(--accent-tint)" stroke="var(--ember-08)" strokeWidth="2" />
          <text x={6} y={15} fill="var(--ember-08)" fontFamily="var(--font-mono)" fontSize="10">writer hangs on long writes</text>
          <g transform="translate(120, 4)"><rect width="36" height="13" rx="1" fill="var(--ember-08)" /><text x={18} y={10} fill="var(--ink-12)" fontFamily="var(--font-mono)" fontSize="8.5" fontWeight="700" textAnchor="middle">#142</text></g>
        </g>

        {[
          { x: 280, y: 105, t: "support claude as answerer", tag: "#138" },
          { x: 280, y: 140, t: "rate-limit handling", tag: "#131" },
          { x: 280, y: 175, t: "e2e for runner ssh", tag: "#108" },
          { x: 280, y: 210, t: "add test coverage", tag: "gap·2", agent: true },
          { x: 280, y: 245, t: "codeowners scaffold", tag: "risk", agent: true },
          { x: 280, y: 280, t: "mergify config", tag: "risk", agent: true },
          { x: 280, y: 315, t: "auditor flake on snapshot", tag: "#93" },
          { x: 280, y: 350, t: "fix workflow yaml lint", tag: "#88" },
          { x: 280, y: 385, t: "preserve auth.json across runs", tag: "#83" },
          { x: 540, y: 110, t: "cost gauge accuracy", tag: "#127" },
          { x: 540, y: 145, t: "improve doctor output", tag: "#119" },
          { x: 540, y: 180, t: "ci tier · fast lane", tag: "#117" },
          { x: 540, y: 215, t: "spec edit · forge prompt", tag: "#114" },
          { x: 540, y: 250, t: "history page filters", tag: "#109" },
          { x: 540, y: 285, t: "design dna · industrial", tag: "gap·1", agent: true },
          { x: 540, y: 320, t: "vault path tracker", tag: "#102" },
          { x: 540, y: 355, t: "ntfy retries", tag: "#99" },
          { x: 820, y: 110, t: "weekly security audit", tag: "audit", agent: true },
          { x: 820, y: 145, t: "dependency updates", tag: "audit", agent: true },
          { x: 820, y: 180, t: "mutation test setup", tag: "audit", agent: true },
          { x: 820, y: 215, t: "perf budget harness", tag: "#86" },
          { x: 820, y: 250, t: "docs · refresh README", tag: "#82" },
          { x: 820, y: 285, t: "remove dead code", tag: "audit", agent: true },
        ].map((n, i) => (
          <g key={i} transform={`translate(${n.x}, ${n.y})`}>
            <rect width="160" height="22" rx="2" fill="var(--bg-canvas)" stroke={n.agent ? "var(--steel-08)" : "var(--line-2)"} strokeWidth="1" strokeDasharray={n.agent ? "3 2" : ""} />
            <text x={6} y={15} fill={n.agent ? "var(--fg-2)" : "var(--fg-1)"} fontFamily="var(--font-mono)" fontSize="9.5">{n.t}</text>
            <g transform="translate(120, 4)"><rect width="36" height="13" rx="1" fill={n.agent ? "var(--steel-08)" : "var(--bg-sunken)"} stroke="var(--line-1)" /><text x={18} y={10} fill={n.agent ? "var(--ink-12)" : "var(--fg-2)"} fontFamily="var(--font-mono)" fontSize="8" fontWeight="700" textAnchor="middle">{n.tag}</text></g>
          </g>
        ))}

        {[["240,121", "280,121", true], ["240,121", "280,156"], ["240,121", "280,191"], ["440,156", "540,121"], ["440,261", "540,191"], ["440,296", "540,261"], ["700,261", "820,156"]].map((e, i) => (
          <path key={i} d={`M${e[0]} L${e[1]}`} stroke={e[2] ? "var(--ember-08)" : "var(--line-2)"} strokeWidth={e[2] ? 1.5 : 1} fill="none" markerEnd={e[2] ? "url(#exarr-hot)" : "url(#exarr-cool)"} strokeDasharray={e[2] ? "4 3" : ""} />
        ))}
      </svg>

      <div style={{ position: "absolute", left: 16, bottom: 16, width: 360, background: "var(--bg-canvas)", border: "1px solid var(--ember-08)", padding: 14, zIndex: 4, display: "flex", flexDirection: "column", gap: 8, clipPath: "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>selected · from #142</span>
          <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-3)", cursor: "pointer" }}>× close</span>
        </div>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 17, letterSpacing: "-0.022em", color: "var(--fg-1)", textTransform: "lowercase", lineHeight: 1 }}>
          writer hangs on <em style={{ fontStyle: "italic", color: "var(--ember-08)" }}>long writes</em>
        </div>
        <div style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-2)", lineHeight: 1.5 }}>
          ingested from github issue <b style={{ color: "var(--ember-08)" }}>#142</b>. forge classified as P0 because labels included "bug" and "blocker".
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-2)", lineHeight: 1.6 }}>
          <div>source · <b style={{ color: "var(--fg-1)" }}>github #142 · 2d ago</b></div>
          <div>blocks · <b style={{ color: "var(--ember-08)" }}>3 downstream specs</b></div>
          <div>est · <b style={{ color: "var(--fg-1)" }}>3.5h · $0.92</b></div>
        </div>
      </div>

      <div style={{ position: "absolute", right: 16, bottom: 16, padding: "10px 14px", background: "var(--bg-canvas)", border: "1px solid var(--line-1)", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-2)", lineHeight: 1.6, borderRadius: 2, maxWidth: 220 }}>
        <div style={{ color: "var(--ember-08)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700, marginBottom: 2 }}>legend</div>
        <div><svg width="14" height="6" style={{ marginRight: 4, verticalAlign: "middle" }}><rect width="14" height="6" fill="var(--bg-canvas)" stroke="var(--line-2)" /></svg>from github issue</div>
        <div><svg width="14" height="6" style={{ marginRight: 4, verticalAlign: "middle" }}><rect width="14" height="6" fill="var(--bg-canvas)" stroke="var(--steel-08)" strokeDasharray="3 2" /></svg>from agent gap / audit</div>
      </div>
    </div>
  </>
);

// ===== E5 · Governance posture =====
const ExistGov = () => (
  <>
    <StepHeading
      eyebrow="step 5 · governance posture"
      title="who gets to"
      em="commit · how"
      sub="14 contributors push to this repo today. tanren needs a stance on how it coexists. pick a posture, override anytime."
    />
    <div className="cols-2-narrow">
      <div className="scroll-col">
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.22em", textTransform: "uppercase", fontWeight: 700 }}>▮ posture · pick one</div>
        {[
          { name: "strict — you describe, we forge", on: true, body: "Every change MUST go through a spec. External pushes get warned + auto-spec'd for tracking. Tanren never reviews human PRs.", best: "for teams committing to the spec discipline" },
          { name: "open — humans + tanren both push", on: false, body: "Tanren coexists. Direct pushes are normal. Tanren tracks but doesn't grade them. Picks up issues + audits + manual operator specs.", best: "for established teams retrofitting tanren" },
          { name: "audit-only — tanren just watches", on: false, body: "Tanren reads everything, opens no PRs. Surfaces patterns, regressions, drift in a dashboard. Operator promotes findings into specs by hand.", best: "for a 4-week trial without code-modification risk" },
        ].map((p, i) => (
          <div key={i} className={"col-card" + (p.on ? " live" : "")} style={{ padding: "12px 14px", gap: 6, cursor: "pointer" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 14, height: 14, border: "1.5px solid " + (p.on ? "var(--ember-08)" : "var(--line-2)"), background: p.on ? "var(--ember-08)" : "transparent", borderRadius: 50, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {p.on && <div style={{ width: 5, height: 5, background: "var(--ink-12)", borderRadius: 50 }}></div>}
              </div>
              <div className="display-h" style={{ fontSize: 14 }}>{p.name}</div>
            </div>
            <div style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-2)", lineHeight: 1.45, paddingLeft: 22 }}>{p.body}</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: p.on ? "var(--ember-08)" : "var(--fg-3)", paddingLeft: 22 }}>↑ best for: {p.best}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <div className="col-card" style={{ gap: 8 }}>
          <div className="h"><span>external-push policy</span><span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>strict-posture defaults</span></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              ["on direct push to feature branch", "auto-spec for tracking · no block"],
              ["on push to main (admin bypass)", "fail status check · notify slack"],
              ["on force-push", "block · escalate"],
              ["on human-opened pr without spec", "comment with 'spec this?' offer"],
            ].map(([t, a], i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr auto", padding: "7px 10px", background: "var(--bg-sunken)", border: "1px solid var(--line-1)", borderLeft: "2px solid var(--ember-08)", borderRadius: 2, gap: 8 }}>
                <span style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-1)" }}>{t}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ember-08)" }}>{a}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="col-card" style={{ gap: 8 }}>
          <div className="h"><span>codeowners · <em style={{ color: "var(--ember-08)" }}>scaffolded</em></span></div>
          <pre className="code-block" style={{ fontSize: 10.5, padding: "10px 12px" }}>
{`* @cat-cave/tanren-operators
src/auth/** @cat-cave/security
.tanren/** @cat-cave/tanren-operators
.github/** @cat-cave/tanren-operators`}
          </pre>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>↑ committed in the integration pr · edit anytime</div>
        </div>

        <div className="arrival-card">
          <div className="kanji-bg">鍛</div>
          <div className="eyebrow">tanren-fixture-easy · ready</div>
          <div className="display">repo <em>integrated</em>.</div>
          <div className="sub">35 specs queued · 1 critical-path · forge will pick <code style={{ color: "var(--ember-07)", background: "var(--bg-sunken)", padding: "0 5px", border: "1px solid var(--line-1)", fontSize: 11 }}>#142 · session race</code> first.</div>
          <div className="actions">
            <button className="btn primary notched">open project ↗</button>
            <button className="btn">start with a different spec</button>
          </div>
        </div>
      </div>
    </div>
  </>
);

// ===== Wrapper =====
window.ExistingProjectView = ({ step, setStep, onNav }) => {
  const stepIdx = Math.max(1, Math.min(5, step || 1));
  const body =
    stepIdx === 1 ? <ExistConnect /> :
    stepIdx === 2 ? <ExistRecon /> :
    stepIdx === 3 ? <ExistConfig /> :
    stepIdx === 4 ? <ExistDag /> :
    <ExistGov />;

  const journeys = [
    { l: "link an", e: "existing repo" },
    { l: "confirm what the", e: "agent found" },
    { l: "merge the", e: "integration pr" },
    { l: "seed the", e: "dag from reality" },
    { l: "decide", e: "the posture" },
  ];

  return (
    <OnbShell
      track="existing project · brownfield"
      journey={journeys[stepIdx - 1].l}
      journeyEm={journeys[stepIdx - 1].e}
      step={stepIdx}
      total={5}
      steps={EXIST_STEPS}
      onStep={(i) => setStep(i)}
      onExit={() => onNav?.("project")}
    >
      {body}
      <OnbFoot
        left={stepIdx > 1 ? "back · " + EXIST_STEPS[stepIdx - 2].label : "back · org setup"}
        onBack={() => stepIdx > 1 ? setStep(stepIdx - 1) : onNav?.("project")}
        hint={
          stepIdx === 1 ? "↑ the answerer agent reads in the background · step 2 opens when it's done (~30s)" :
          stepIdx === 2 ? "↑ the read-only answerer also powers forge's code-exploration mode after onboarding" :
          stepIdx === 3 ? "↑ the integration pr is the one-time gate · all brownfield onboarding lands through it" :
          stepIdx === 4 ? "↑ each spec inherits its priority from the issue label · forge re-routes on demand" :
          "↑ posture is editable from /settings/governance · forever"
        }
        primary={stepIdx === 5 ? "open project" : "next · " + EXIST_STEPS[stepIdx].label}
        secondary={stepIdx === 5 ? "start with different spec" : "skip · iterate later"}
        onPrimary={stepIdx === 5 ? () => onNav?.("project") : () => setStep(stepIdx + 1)}
      />
    </OnbShell>
  );
};
