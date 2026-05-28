// view-onboard-new.jsx — 01b · New Project (greenfield). 3 steps: vision, dag, arrival.

const NEW_STEPS = [
  { label: "interview" },
  { label: "spec dag" },
  { label: "sources & arrival" },
];

// ===== Step 1 · The Vision Interview =====
const NewVision = () => (
  <>
    <StepHeading
      eyebrow="step 1 · the interview · pauses & resumes forever"
      title="forge asks"
      em="you answer"
      sub="one conversation captures everything: identity, personas, behaviors, interfaces, design dna, architecture, rulesets. extract panel updates live."
    />
    <div className="cols-2-narrow">
      <ForgeChat
        title="product interview"
        meta="round 7 of ~14 · ~50% complete"
        placeholder="type your answer · or click a suggestion · or paste a doc / image"
        hint={<><span style={{ color: "var(--status-ok)" }}>✓ autosaved 4s ago</span><span style={{ color: "var(--fg-4)", margin: "0 8px" }}>·</span><span>resume from anywhere · /onboarding/new/abc</span><span style={{ marginLeft: "auto", display: "flex", gap: 14, float: "right" }}>⌥+↵ submit · ⌘+/ commands</span></>}
      >
        <Turn>
          Great. Three personas captured — <b style={{ color: "var(--ember-08)" }}>ops manager · line worker · cfo</b>.<br /><br />
          Now I want to nail the <b style={{ color: "var(--ember-08)" }}>behaviors</b> for the line worker. These will drive your spec tests later — every behavior gets a BDD scenario tanren can implement and verify against.
        </Turn>
        <Turn>
          For the line worker, what's the most common thing they'd do in a shift? Walk me through their morning.
        </Turn>
        <Turn who="user">
          they clock in with a barcode badge, walk to their station, pull the day's pick list on a handheld, scan items off the bin to a tote, confirm each scan, and push the tote to staging. takes about 40 minutes per cart.
        </Turn>
        <Turn>
          Good. I'm capturing five behaviors from that. Quick <b style={{ color: "var(--status-warn)" }}>callout</b>: "scan item to tote" — is the tote tracked as a discrete entity (own barcode) or just a logical grouping?
          <InlineActions>
            <button className="btn" style={{ fontSize: 11 }}>tote has its own barcode</button>
            <button className="btn ghost" style={{ fontSize: 11 }}>logical grouping only</button>
            <button className="btn ghost" style={{ fontSize: 11, color: "var(--ember-08)" }}>ask later</button>
          </InlineActions>
        </Turn>
      </ForgeChat>

      <div className="scroll-col">
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.22em", textTransform: "uppercase", fontWeight: 700 }}>▮ what forge captured · live</div>

        {[
          { ch: "identity", state: "done", body: <>
            <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16, letterSpacing: "-0.022em", color: "var(--fg-1)", textTransform: "lowercase" }}>supply-chain-os</div>
            <div style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-2)", lineHeight: 1.45 }}>supply chain operations for mid-market manufacturers.</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)", marginTop: 4 }}>repo · github.com/cat-cave/<b style={{ color: "var(--ember-08)" }}>supply-chain-os</b></div>
          </> },
          { ch: "personas · 3", state: "done", body: <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {[["ops manager", "desktop · orders, supplier scoring"], ["line worker", "handheld · barcode + bin moves", true], ["cfo", "desktop · monthly reports, edi"]].map(([n, d, hot], i) => (
              <div key={i} style={{ padding: "5px 8px", background: hot ? "var(--accent-tint)" : "var(--bg-sunken)", border: "1px solid " + (hot ? "var(--ember-08)" : "var(--line-1)"), borderLeft: "2px solid " + (hot ? "var(--ember-08)" : "var(--line-2)"), borderRadius: 1 }}>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 12, color: "var(--fg-1)", textTransform: "lowercase" }}>{n}{hot && <span style={{ color: "var(--ember-08)", fontStyle: "italic" }}> · in discussion</span>}</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)" }}>{d}</div>
              </div>
            ))}
          </div> },
          { ch: "behaviors · 12 captured · 5 in flight", state: "live", body: <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-2)", lineHeight: 1.55 }}>
            <div style={{ color: "var(--fg-1)" }}>ops · place a purchase order</div>
            <div style={{ color: "var(--fg-1)" }}>ops · review supplier scorecard</div>
            <div style={{ color: "var(--ember-08)" }}>line · clock in with badge <span style={{ color: "var(--fg-3)" }}>· just captured</span></div>
            <div style={{ color: "var(--ember-08)" }}>line · pull the day's pick list</div>
            <div style={{ color: "var(--ember-08)" }}>line · scan items off the bin</div>
            <div style={{ color: "var(--ember-08)" }}>line · confirm each scan</div>
            <div style={{ color: "var(--ember-08)" }}>line · push tote to staging</div>
            <div style={{ color: "var(--fg-3)" }}>… 5 more captured earlier</div>
            <div style={{ marginTop: 6, color: "var(--ember-08)", fontStyle: "italic" }}>↑ these become BDD scenarios in the dag</div>
          </div> },
          { ch: "interfaces · 2 inferred", state: "done", body: <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-1)", lineHeight: 1.65 }}>
            <div>▸ desktop dashboard · ops + cfo</div>
            <div>▸ handheld web app · line worker · offline-capable</div>
          </div> },
          { ch: "design dna · choose a starter", state: "done", body: <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
            {[["industrial", "tanren · forge"], ["bauhaus", "clean · sharp"], ["editorial", "long-form · brand"], ["custom · paste url"]].map((p, i) => (
              <div key={i} style={{ padding: "5px 8px", border: "1px solid " + (i === 0 ? "var(--ember-08)" : "var(--line-1)"), background: i === 0 ? "var(--accent-tint)" : "var(--bg-sunken)", fontFamily: "var(--font-mono)", fontSize: 10, color: i === 0 ? "var(--fg-1)" : "var(--fg-2)", borderRadius: 1 }}>
                <div style={{ fontWeight: 600 }}>{p[0]}</div>
                {p[1] && <div style={{ color: "var(--fg-3)", fontSize: 9 }}>{p[1]}</div>}
              </div>
            ))}
          </div> },
          { ch: "architecture · forge proposed", state: "draft", body: <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-2)", lineHeight: 1.7 }}>
            <div><span style={{ color: "var(--fg-3)" }}>web</span> · next.js · turborepo</div>
            <div><span style={{ color: "var(--fg-3)" }}>handheld</span> · next.js pwa · service worker</div>
            <div><span style={{ color: "var(--fg-3)" }}>data</span> · postgres · drizzle</div>
            <div><span style={{ color: "var(--fg-3)" }}>deploy</span> · fly.io · 2 regions</div>
            <div style={{ color: "var(--ember-08)", marginTop: 4 }}>↑ confirm or override when interview is done</div>
          </div> },
          { ch: "rulesets · required, locked", state: "locked", body: <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-1)", lineHeight: 1.6 }}>
            {["main protected · pr required", "linear history", "status checks required", "no force push", "mergify on"].map((r, i) => (
              <div key={i}><span style={{ color: "var(--status-ok)", marginRight: 6 }}>●</span>{r}</div>
            ))}
            <div style={{ marginTop: 4, color: "var(--fg-3)" }}>↑ tanren can't operate without these</div>
          </div> },
        ].map((c, i) => (
          <div key={i} className={"col-card" + (c.state === "live" ? " live" : "")} style={{ padding: "10px 12px", gap: 6 }}>
            <div className="h" style={{ color: c.state === "live" ? "var(--ember-08)" : c.state === "done" ? "var(--status-ok)" : c.state === "locked" ? "var(--fg-3)" : "var(--fg-3)" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, marginRight: 4 }}>
                {c.state === "live" ? "↻" : c.state === "done" ? "✓" : c.state === "locked" ? "⌬" : "✎"}
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

// ===== Step 2 · Spec DAG (forge-derived, click-to-inspect) =====
const NewDAG = () => (
  <>
    <StepHeading
      eyebrow="step 2 · spec dag · forge derives from the interview"
      title="the engine"
      em="emerges"
      sub="71 specs across 7 milestones. each tied to behaviors from step 1. click any node to inspect. ask forge to edit — manual edits would break dependency math."
      right={<span className="pill ok"><span className="d"></span>derived from interview</span>}
    />

    <div style={{ background: "var(--bg-sunken)", border: "1px solid var(--line-1)", borderRadius: 4, position: "relative", overflow: "hidden", backgroundImage: "radial-gradient(var(--line-1) 1px, transparent 1px)", backgroundSize: "22px 22px", flex: 1, minHeight: 0 }}>
      <div style={{ position: "absolute", top: 12, left: 16, right: 16, display: "flex", alignItems: "center", gap: 10, zIndex: 4 }}>
        <span className="pill hot" style={{ fontSize: 9 }}><span className="d"></span>71 nodes · 7 milestones · 12 critical-path</span>
        <span className="pill ok" style={{ fontSize: 9 }}><span className="d"></span>tied to 12 behaviors</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)" }}>est cost $58–$94 · ~6 weeks</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          <button className="seg-btn">fit</button>
          <button className="seg-btn">+</button>
          <button className="seg-btn">−</button>
          <button className="seg-btn">≡ by behavior</button>
        </div>
      </div>

      <svg viewBox="0 0 1100 580" preserveAspectRatio="xMidYMid meet" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        <defs>
          <marker id="newarr-cool" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0,0 L7,3.5 L0,7" fill="var(--line-2)" />
          </marker>
          <marker id="newarr-hot" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0,0 L7,3.5 L0,7" fill="var(--ember-08)" />
          </marker>
        </defs>

        {[
          { x: 80,  label: "M1", spec: "scaffold" },
          { x: 230, label: "M2", spec: "auth · roles" },
          { x: 380, label: "M3", spec: "ops dashboard" },
          { x: 530, label: "M4", spec: "handheld" },
          { x: 680, label: "M5", spec: "edi pipeline" },
          { x: 830, label: "M6", spec: "cfo reports" },
          { x: 970, label: "M7", spec: "perf · regions" },
        ].map((m) => (
          <g key={m.label}>
            <text x={m.x + 50} y={62} fill="var(--fg-3)" fontFamily="var(--font-mono)" fontSize="10" textAnchor="middle" letterSpacing="0.18em" fontWeight="700">{m.label}</text>
            <text x={m.x + 50} y={78} fill="var(--fg-3)" fontFamily="var(--font-mono)" fontSize="9.5" textAnchor="middle">{m.spec}</text>
          </g>
        ))}

        {[
          { x: 80, y: 110, t: "monorepo scaffold", crit: true },
          { x: 80, y: 145, t: "build · turbo", crit: true },
          { x: 80, y: 180, t: "ci · gh actions", crit: true },
          { x: 80, y: 215, t: "shared types pkg" },
          { x: 230, y: 110, t: "auth schema", crit: true },
          { x: 230, y: 145, t: "session middleware", crit: true },
          { x: 230, y: 180, t: "role rbac" },
          { x: 230, y: 215, t: "login screens" },
          { x: 230, y: 250, t: "magic link email" },
          { x: 380, y: 110, t: "orders schema", crit: true },
          { x: 380, y: 145, t: "orders ui list" },
          { x: 380, y: 180, t: "orders create form" },
          { x: 380, y: 215, t: "supplier model" },
          { x: 380, y: 250, t: "supplier scorecard" },
          { x: 530, y: 110, t: "expo scaffold" },
          { x: 530, y: 145, t: "clock-in barcode", sel: true, behv: 8 },
          { x: 530, y: 180, t: "pick list ui" },
          { x: 530, y: 215, t: "scan item to tote" },
          { x: 530, y: 250, t: "confirm scan" },
          { x: 530, y: 285, t: "push tote · staging" },
          { x: 680, y: 110, t: "workato adapter" },
          { x: 680, y: 145, t: "edi parser ts" },
          { x: 680, y: 180, t: "edi mapping ui" },
          { x: 680, y: 215, t: "edi monitoring" },
          { x: 830, y: 110, t: "cost variance" },
          { x: 830, y: 145, t: "monthly close" },
          { x: 830, y: 180, t: "exports csv" },
          { x: 970, y: 110, t: "perf budget" },
          { x: 970, y: 145, t: "multi-region" },
        ].map((n, i) => (
          <g key={i} transform={`translate(${n.x}, ${n.y})`}>
            <rect width="100" height="22" rx="2"
              fill={n.sel ? "var(--accent-tint)" : "var(--bg-canvas)"}
              stroke={n.sel ? "var(--ember-08)" : n.crit ? "var(--ember-08)" : "var(--line-2)"}
              strokeWidth={n.sel ? 2 : n.crit ? 1.5 : 1}
            />
            <text x={6} y={15} fill={n.sel ? "var(--ember-08)" : n.crit ? "var(--fg-1)" : "var(--fg-2)"} fontFamily="var(--font-mono)" fontSize="10">{n.t}</text>
            {n.behv && (
              <g transform="translate(78, 4)">
                <rect width="18" height="13" rx="1" fill="var(--ember-08)" />
                <text x={9} y={10} fill="var(--ink-12)" fontFamily="var(--font-mono)" fontSize="8.5" fontWeight="700" textAnchor="middle">b{n.behv}</text>
              </g>
            )}
          </g>
        ))}

        {[
          ["130,121", "180,121"],
          ["180,121", "230,121", true],
          ["180,191", "230,156", true],
          ["330,121", "380,121", true],
          ["480,121", "530,121"],
          ["480,261", "530,196"],
          ["630,261", "680,121"],
          ["780,121", "830,121"],
          ["930,121", "970,121"],
        ].map((e, i) => (
          <path key={i} d={`M${e[0]} L${e[1]}`} stroke={e[2] ? "var(--ember-08)" : "var(--line-2)"} strokeWidth={e[2] ? 1.5 : 1} fill="none"
                markerEnd={e[2] ? "url(#newarr-hot)" : "url(#newarr-cool)"} strokeDasharray={e[2] ? "4 3" : ""} />
        ))}
      </svg>

      {/* Click-to-inspect subpanel */}
      <div style={{ position: "absolute", left: 16, bottom: 16, width: 360, background: "var(--bg-canvas)", border: "1px solid var(--ember-08)", padding: 14, zIndex: 4, display: "flex", flexDirection: "column", gap: 8, clipPath: "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>selected · M4-S02</span>
          <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.14em", cursor: "pointer" }}>× close</span>
        </div>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 17, letterSpacing: "-0.022em", color: "var(--fg-1)", textTransform: "lowercase", lineHeight: 1 }}>
          clock-in <em style={{ fontStyle: "italic", color: "var(--ember-08)" }}>barcode</em>
        </div>
        <div style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-2)", lineHeight: 1.5 }}>
          Line worker scans their badge at the handheld home screen. App auth-checks against the org's user table, opens a shift, returns the pick list for their assigned station.
        </div>
        <div style={{ padding: "8px 10px", background: "var(--accent-tint)", border: "1px solid var(--ember-08)", borderRadius: 2 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>behavior · b8</div>
          <div style={{ fontFamily: "var(--font-ui)", fontSize: 11.5, color: "var(--fg-1)", lineHeight: 1.45 }}>
            <b>line worker</b> · clock in with badge
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-2)", marginTop: 6, lineHeight: 1.5 }}>
            <span style={{ color: "var(--ember-08)", fontWeight: 700 }}>given</span> · line worker at handheld<br />
            <span style={{ color: "var(--ember-08)", fontWeight: 700 }}>when</span> · they scan their badge<br />
            <span style={{ color: "var(--ember-08)", fontWeight: 700 }}>then</span> · pick list opens for their station
          </div>
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-2)", lineHeight: 1.6 }}>
          <div>deliverable · <b style={{ color: "var(--fg-1)" }}>POST /shift/start · barcode handler</b></div>
          <div>depends · <b style={{ color: "var(--fg-1)" }}>session middleware (M2)</b></div>
          <div>blocks · <b style={{ color: "var(--ember-08)" }}>5 downstream specs</b></div>
          <div>est · <b style={{ color: "var(--fg-1)" }}>2.3h · $0.62</b></div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="btn ghost" style={{ fontSize: 11, color: "var(--ember-08)" }}><span style={{ fontFamily: "var(--font-jp)", fontSize: 12, marginRight: 4 }}>鍛</span>ask forge to split</button>
          <button className="btn ghost" style={{ fontSize: 11, color: "var(--ember-08)" }}>ask forge to drop</button>
        </div>
      </div>

      {/* Forge prompt — the only edit path */}
      <div style={{ position: "absolute", right: 16, bottom: 16, width: 340, background: "var(--bg-canvas)", border: "1px solid oklch(68% 0.22 40 / 0.45)", padding: 12, zIndex: 4, display: "flex", flexDirection: "column", gap: 8, borderRadius: 2 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontFamily: "var(--font-jp)", fontSize: 18, color: "var(--ember-08)" }}>鍛</div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 13, color: "var(--fg-1)", textTransform: "lowercase" }}>edit the dag · <em style={{ fontStyle: "italic", color: "var(--ember-08)" }}>ask forge</em></div>
        </div>
        <div style={{ padding: "8px 10px", background: "var(--bg-sunken)", border: "1px solid var(--line-1)", fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-3)", borderRadius: 2 }}>
          <span style={{ color: "var(--ember-08)", marginRight: 8 }}>▸</span>
          "drop edi monitoring" · "add a spec for shift handoffs"…
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)", lineHeight: 1.5 }}>
          ↑ forge keeps dependencies sane, re-estimates · manual edits would break the engine
        </div>
      </div>
    </div>
  </>
);

// ===== Step 3 · Sources, Audits, Arrival =====
const NewArrival = () => (
  <>
    <StepHeading
      eyebrow="step 3 · sources, audits, arrival"
      title="open the"
      em="floodgates"
      sub="issue sources feed the dag · scheduled audits run in their own lanes · dora is reported, not targeted (until you find your steady-state)."
      right={<span className="pill ok"><span className="d"></span>arrival · ready to forge</span>}
    />
    <div className="cols-3">
      <div className="col-card" style={{ minHeight: 0, overflow: "auto" }}>
        <div className="h"><span>issue <em style={{ color: "var(--ember-08)" }}>sources</em></span></div>
        <div style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-2)", lineHeight: 1.45 }}>
          each ingested issue routes into the dag via labels + forge's classification.
        </div>
        {[
          { n: "github issues", on: true, status: "connected", glyph: "⌥", route: "label:bug→p1 · feature→backlog" },
          { n: "operator manual", on: true, status: "always-on", glyph: "✎", route: "ad-hoc · routes via interview" },
          { n: "linear", on: false, status: "not configured", glyph: "▱", route: "oauth + workspace pick → routes by labels" },
          { n: "jira", on: false, status: "not configured", glyph: "◇", route: "api token + project key → issue type routing" },
          { n: "custom webhook · post", on: false, status: "not configured", glyph: "↗", route: "any json · tanren classifies" },
        ].map((s, i) => (
          <div key={i} className={"row-card " + (s.on ? "on" : "")}>
            <span className="glyph">{s.glyph}</span>
            <div>
              <div className="name">{s.n}</div>
              <div className="desc">{s.route}</div>
            </div>
            <StatusBadge status={s.status} />
            <Toggle on={s.on} />
          </div>
        ))}
      </div>

      <div className="col-card" style={{ minHeight: 0, padding: 0, overflow: "hidden" }}>
        <div className="h" style={{ padding: "12px 16px", borderBottom: "1px solid var(--line-1)" }}><span>scheduled <em style={{ color: "var(--ember-08)" }}>audits</em> · library</span><span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ember-08)" }}>tanren provides agent · you provide when</span></div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, overflow: "auto", padding: "10px 14px" }}>
          {[
            { n: "security audit", agent: "snyk + trivy + sast", cron: "weekly · sun 02:00", on: true },
            { n: "mutation tests", agent: "stryker · pkg-aware", cron: "nightly · 03:00", on: true },
            { n: "perf benchmark", agent: "lighthouse + custom k6", cron: "monthly · 1st", on: true },
            { n: "dependency updates", agent: "renovate · auto-spec", cron: "daily · 06:00", on: true },
            { n: "type coverage", agent: "tsc · noimplicitany", cron: "weekly · fri", on: false },
            { n: "a11y · accessibility", agent: "axe + pa11y", cron: "weekly · sat", on: false },
            { n: "license audit", agent: "license-checker", cron: "monthly", on: false },
            { n: "stale specs", agent: "forge · review > 30d", cron: "weekly", on: true },
          ].map((s, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 120px auto", gap: 8, alignItems: "center", padding: "7px 10px", background: "var(--bg-sunken)", border: "1px solid var(--line-1)", borderLeft: "2px solid " + (s.on ? "var(--ember-08)" : "transparent"), borderRadius: 2 }}>
              <div>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 12.5, color: "var(--fg-1)", textTransform: "lowercase" }}>{s.n}</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)" }}>agent · {s.agent}</div>
              </div>
              <div style={{ padding: "3px 7px", border: "1px solid var(--line-1)", background: "var(--bg-canvas)", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-1)", borderRadius: 2 }}>{s.cron}</div>
              <Toggle on={s.on} />
            </div>
          ))}
          <div style={{ padding: "8px 10px", border: "1px dashed var(--line-2)", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ember-08)", display: "flex", alignItems: "center", gap: 8, cursor: "pointer", borderRadius: 2 }}>
            <span>+</span> custom audit · point at a script / docker image, set a cron, ship findings as specs
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <div className="col-card" style={{ gap: 8 }}>
          <div className="h"><span>dora · <em style={{ color: "var(--ember-08)" }}>observed</em></span><span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)" }}>reporting, not targets</span></div>
          {[
            ["lead time", "—", "no runs yet"],
            ["deploy frequency", "—", "first deploy sets baseline"],
            ["change failure rate", "—", "—"],
            ["mttr", "—", "—"],
          ].map(([k, v, h], i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr auto", padding: "5px 0", borderBottom: i < 3 ? "1px solid var(--line-1)" : "none", alignItems: "center" }}>
              <div>
                <div style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-1)" }}>{k}</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)" }}>{h}</div>
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-3)", textAlign: "right" }}>{v}</div>
            </div>
          ))}
          <div style={{ marginTop: 4, padding: "8px 10px", background: "oklch(40% 0.05 230 / 0.10)", border: "1px solid oklch(40% 0.05 230 / 0.6)", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-2)", lineHeight: 1.45, borderRadius: 2 }}>
            <span style={{ color: "var(--steel-08)", letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 700 }}>↑ steady-state first</span><br />
            tanren reports your numbers. setting targets and alerts comes after a few weeks of steady operation.
          </div>
        </div>

        <div className="arrival-card">
          <div className="kanji-bg">鍛</div>
          <div className="eyebrow">your smithy is ready</div>
          <div className="display">71 specs.<br /><em>1 ready</em>.</div>
          <div className="sub">tanren will pick <code style={{ color: "var(--ember-07)", background: "var(--bg-sunken)", padding: "0 5px", border: "1px solid var(--line-1)", fontSize: 11 }}>M1-S01 · monorepo scaffold</code> and start.</div>
          <div className="actions">
            <button className="btn primary notched">forge the first spec ↗</button>
          </div>
          <div className="footnote">↑ engine paused until you click</div>
        </div>
      </div>
    </div>
  </>
);

// ===== Wrapper =====
window.NewProjectView = ({ step, setStep, onNav }) => {
  const stepIdx = Math.max(1, Math.min(3, step || 1));
  const body =
    stepIdx === 1 ? <NewVision /> :
    stepIdx === 2 ? <NewDAG /> :
    <NewArrival />;

  const labels = ["say what we're building", "seed the spec dag", "light the fire"];
  const ems = ["", "", ""];

  const journeys = [
    { l: "say what", e: "we're building" },
    { l: "seed the", e: "spec dag" },
    { l: "light the", e: "fire" },
  ];

  return (
    <OnbShell
      track="new project · greenfield"
      journey={journeys[stepIdx - 1].l}
      journeyEm={journeys[stepIdx - 1].e}
      step={stepIdx}
      total={3}
      steps={NEW_STEPS}
      onStep={(i) => setStep(i)}
      onExit={() => onNav?.("project")}
    >
      {body}
      <OnbFoot
        left={stepIdx > 1 ? "back · " + NEW_STEPS[stepIdx - 2].label : "back · org setup"}
        onBack={() => stepIdx > 1 ? setStep(stepIdx - 1) : onNav?.("project")}
        hint={
          stepIdx === 1 ? "↑ this whole interview auto-saves · close anytime · resume from email link or dashboard card" :
          stepIdx === 2 ? "↑ behavior coverage shown by the b1–b12 tags · each spec demonstrates ≥ 1 behavior" :
          "↑ every setting here is editable from /settings · forever"
        }
        primary={stepIdx === 3 ? "forge the first spec" : "next · " + NEW_STEPS[stepIdx].label}
        secondary={stepIdx === 3 ? "just open dashboard" : (stepIdx === 1 ? "export brief · md" : "export dag · json")}
        onPrimary={stepIdx === 3 ? () => onNav?.("project") : () => setStep(stepIdx + 1)}
      />
    </OnbShell>
  );
};
