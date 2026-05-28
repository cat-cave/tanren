// view-onboard-org.jsx — 01a · Org Setup. 4 steps: auth, creds, notify, infra.

const ORG_STEPS = [
  { label: "link org" },
  { label: "credentials" },
  { label: "notifications" },
  { label: "infrastructure" },
];

// ===== Step 1 · Auth + Stack Health =====
const OrgAuth = () => (
  <>
    <StepHeading
      eyebrow="step 1 · link tanren to your github org"
      title="give tanren access"
      em="to the org"
      sub="you're signed in as tw@cat-cave. now we authorize the tanren github app on cat-cave — that pick decides which repos tanren can ever touch."
    />
    <div className="cols-2-1">
      <div className="col-card" style={{ gap: 14 }}>
        <div className="h"><span>authorize on <em style={{ color: "var(--ember-08)" }}>cat-cave</em></span><span className="pill ok" style={{ marginLeft: "auto" }}><span className="d"></span>one-time setup</span></div>

        <div className="insight-banner" style={{ alignItems: "center" }}>
          <div className="glyph" style={{ fontFamily: "var(--font-jp)", fontSize: 26 }}>鍛</div>
          <div className="body">
            <div className="meta"><span className="lbl">▮ authorize</span></div>
            <div className="text" style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 22, letterSpacing: "-0.03em", textTransform: "lowercase", color: "var(--fg-1)" }}>
              authorize <em style={{ fontStyle: "italic", color: "var(--ember-08)" }}>tanren</em> on cat-cave
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)", marginTop: 4, lineHeight: 1.5 }}>
              you'll be sent to github.com/apps/tanren/installations · one-time · editable later
            </div>
          </div>
          <button className="btn primary notched">open github ↗</button>
        </div>

        <div style={{ background: "var(--bg-sunken)", border: "1px solid var(--line-1)", padding: 12, borderRadius: 2 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700, marginBottom: 6 }}>what tanren will ask for</div>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 5, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-1)" }}>
            {[
              ["▸", "read · contents, metadata, issues, prs · selected repos only", "var(--ember-08)"],
              ["▸", "write · create branches, prs, comments, issues", "var(--ember-08)"],
              ["▸", "read · org members (for review-gate routing)", "var(--ember-08)"],
              ["▸", "read · ci/check status", "var(--ember-08)"],
              ["×", "never · push directly to default branches", "var(--fg-3)"],
              ["×", "never · admin · billing · secrets", "var(--fg-3)"],
            ].map(([g, t, c], i) => (
              <li key={i} style={{ color: c === "var(--fg-3)" ? "var(--fg-3)" : "var(--fg-1)" }}><span style={{ color: c, marginRight: 8, fontWeight: 700 }}>{g}</span>{t}</li>
            ))}
          </ul>
        </div>

        <div style={{ fontFamily: "var(--font-ui)", fontSize: 12.5, color: "var(--fg-2)", lineHeight: 1.5 }}>
          <b style={{ color: "var(--ember-08)" }}>↑ your github org is your tanren org.</b> once authorized, every cat-cave member can sign in. add or remove people in github — tanren reflects.
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <div className="col-card" style={{ gap: 8 }}>
          <div className="h"><span>stack <em style={{ color: "var(--ember-08)" }}>health</em></span><span className="pill ok" style={{ marginLeft: "auto" }}><span className="d"></span>8 of 8 · ok</span></div>
          <div style={{ background: "var(--bg-sunken)", border: "1px solid var(--line-1)", padding: 12, fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.65, color: "var(--fg-1)", maxHeight: 220, overflow: "auto", borderRadius: 2 }}>
            {[
              "docker · 24.0.7", "postgres · ready", "vault · unsealed", "ntfy · 0 backlog",
              "orchestrator → runner ssh", "runner image · pulled", "job queue · 0 stuck", "github reachability · 142ms",
            ].map((s, i) => (
              <div key={i}><span style={{ color: "var(--status-ok)", marginRight: 6 }}>✓</span>{s}</div>
            ))}
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>
            ↗ accessible forever at <code style={{ color: "var(--ember-07)" }}>/doctor</code> · re-runs nightly
          </div>
        </div>

        <div className="col-card live" style={{ gap: 6 }}>
          <div className="h">↑ why org-level auth</div>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 5, fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-1)", lineHeight: 1.45 }}>
            {[
              "tanren needs github to do its job anyway",
              "org membership is the truth · no parallel one",
              "github audit logs cover tanren's actions",
              "fewer creds to lose, rotate, audit",
            ].map((t, i) => (
              <li key={i} style={{ paddingLeft: 14, position: "relative" }}>
                <span style={{ position: "absolute", left: 0, color: "var(--ember-08)" }}>▸</span>{t}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  </>
);

// ===== Step 2 · Credentials =====
const OrgCreds = () => (
  <>
    <StepHeading
      eyebrow="step 2 · credentials · generic, role-blind"
      title="api keys and"
      em="bundles"
      sub="we store credentials. we don't assume what they're for. routing rules in /settings decide which key gets which job."
    />
    <div className="cols-2">
      <div className="col-card" style={{ gap: 12, minHeight: 0, overflow: "auto" }}>
        <div className="h"><span>org · <em style={{ color: "var(--ember-08)" }}>shared</em></span><span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>billed to org</span></div>

        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.22em", textTransform: "uppercase", fontWeight: 700 }}>▮ api keys · 2</div>

        {[
          { label: "anthropic-prod", url: "api.anthropic.com", schema: "anthropic · v1 messages", used: "4 runs today" },
          { label: "openai-org-fallback", url: "api.openai.com", schema: "openai · v1 responses", used: "—" },
        ].map((k, i) => (
          <div key={i} style={{ background: "var(--bg-sunken)", border: "1px solid var(--line-1)", padding: 10, borderRadius: 2, display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-1)", fontWeight: 600 }}>{k.label}</span>
              <span className="pill ok" style={{ fontSize: 8.5, marginLeft: "auto" }}><span className="d"></span>active</span>
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-2)", display: "grid", gridTemplateColumns: "70px 1fr", gap: 4 }}>
              <span style={{ color: "var(--fg-3)" }}>base url</span><span>{k.url}</span>
              <span style={{ color: "var(--fg-3)" }}>schema</span><span>{k.schema}</span>
              <span style={{ color: "var(--fg-3)" }}>used</span><span>{k.used}</span>
            </div>
          </div>
        ))}

        <div className="col-card live" style={{ gap: 8, padding: 12 }}>
          <div className="h">+ add api key</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Field label="label" placeholder='e.g. "anthropic-prod"' />
            <Field label="base url" placeholder="auto-fills with schema" />
          </div>
          <Field label="api schema" value="anthropic · v1 messages" kind="select" hint="openai · v1 chat completions · openai · v1 responses · anthropic · v1 messages · openai-compatible · custom" />
          <Field label="api key" placeholder="sk-… (encrypted to vault)" />
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button className="btn ghost" style={{ fontSize: 11 }}>quick presets · anthropic · openai · lm-studio · ollama</button>
            <button className="btn primary notched" style={{ marginLeft: "auto", fontSize: 11 }}>save key</button>
          </div>
        </div>

        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.22em", textTransform: "uppercase", fontWeight: 700, marginTop: 4 }}>▮ shared agent bundles · 0</div>
        <div style={{ background: "var(--bg-sunken)", border: "1px dashed var(--line-1)", padding: 12, fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-3)", lineHeight: 1.45, borderRadius: 2 }}>
          most bundle credentials (codex chatgpt, opencode, claude bundle) are dev-tied. add a shared one only if your team has a workspace-tier account that allows sharing.
        </div>
      </div>

      <div className="col-card" style={{ gap: 12, minHeight: 0, overflow: "auto" }}>
        <div className="h"><span>dev · <em style={{ color: "var(--ember-08)" }}>tw@cat-cave</em></span><span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>billed to you</span></div>

        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.22em", textTransform: "uppercase", fontWeight: 700 }}>▮ agent bundles · 1</div>

        <div className="col-card live" style={{ padding: 12, gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 24, height: 24, fontFamily: "var(--font-jp)", fontSize: 12, color: "var(--ember-08)", display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--ember-08)" }}>鍛</div>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--fg-1)", fontWeight: 600 }}>codex chatgpt bundle</span>
            <span className="pill ok" style={{ fontSize: 8.5, marginLeft: "auto" }}><span className="d"></span>active</span>
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-2)", display: "grid", gridTemplateColumns: "70px 1fr", gap: 4 }}>
            <span style={{ color: "var(--fg-3)" }}>path</span><span>vault://dev/tw/codex/chatgpt</span>
            <span style={{ color: "var(--fg-3)" }}>imported</span><span>auth.json · 2h ago</span>
            <span style={{ color: "var(--fg-3)" }}>refresh</span><span>on each runner launch</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn ghost" style={{ fontSize: 11, color: "var(--ember-08)" }}>re-import</button>
            <button className="btn ghost" style={{ fontSize: 11 }}>view auth.json</button>
          </div>
        </div>

        <div style={{ background: "var(--bg-sunken)", border: "1px solid var(--line-1)", padding: 12, borderRadius: 2 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ember-08)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700, marginBottom: 8 }}>+ add bundle</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {[
              ["codex", "chatgpt subscription"],
              ["opencode", "subscription"],
              ["claude bundle", "claude code login"],
              ["custom", "drop a json file"],
            ].map(([n, d], i) => (
              <div key={i} style={{ background: "var(--bg-canvas)", border: "1px solid var(--line-1)", padding: "7px 9px", cursor: "pointer", borderRadius: 2 }}>
                <div style={{ fontFamily: "var(--font-ui)", fontSize: 11.5, color: "var(--fg-1)", fontWeight: 500, textTransform: "lowercase" }}>{n}</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)" }}>{d}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.22em", textTransform: "uppercase", fontWeight: 700, marginTop: 4 }}>▮ personal api keys · 0</div>
        <div style={{ background: "var(--bg-sunken)", border: "1px dashed var(--line-1)", padding: 12, fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-3)", lineHeight: 1.45, borderRadius: 2 }}>
          add personal api keys to override org defaults on your own runs. same shape: label · base url · schema · key.
        </div>
      </div>
    </div>
  </>
);

// ===== Step 3 · Notifications =====
const OrgNotify = () => (
  <>
    <StepHeading
      eyebrow="step 3 · notifications"
      title="where should"
      em="we tell you"
      sub="multi-channel routing per event. set the org defaults; devs can layer personal overrides on top."
    />
    <div className="cols-2-narrow" style={{ gridTemplateColumns: "1fr 1.6fr" }}>
      <div className="col-card" style={{ gap: 8, minHeight: 0, overflow: "auto" }}>
        <div className="h"><span>channels</span><span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>add as many as you need</span></div>
        {[
          { n: "slack", v: "#tanren-builds · cat-cave", on: true, status: "connected", glyph: "⌥" },
          { n: "github checks + comments", v: "automatic on every run", on: true, status: "always-on", glyph: "⌬" },
          { n: "ntfy", v: "ntfy://cat-cave-alerts", on: true, status: "connected", glyph: "▮" },
          { n: "microsoft teams", v: "configure webhook", on: false, status: "not configured", glyph: "◈" },
          { n: "discord", v: "configure webhook", on: false, status: "not configured", glyph: "◉" },
          { n: "email", v: "per-user · digest available", on: false, status: "not configured", glyph: "✉" },
          { n: "sms · twilio", v: "for hard fails only", on: false, status: "auth needed", glyph: "▢" },
          { n: "pagerduty", v: "incident · onCall", on: false, status: "auth needed", glyph: "↘" },
          { n: "webhook · custom", v: "any url · json post", on: false, status: "not configured", glyph: "↗" },
        ].map((c, i) => (
          <div key={i} className={"row-card " + (c.on ? "on" : "")}>
            <span className="glyph">{c.glyph}</span>
            <div>
              <div className="name">{c.n}</div>
              <div className="desc">{c.v}</div>
            </div>
            <StatusBadge status={c.status} />
            <Toggle on={c.on} />
          </div>
        ))}
      </div>

      <div className="col-card" style={{ padding: 0, overflow: "hidden", minHeight: 0 }}>
        <div className="h" style={{ padding: "12px 16px", borderBottom: "1px solid var(--line-1)" }}><span>routing · <em style={{ color: "var(--ember-08)" }}>per event</em></span><span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ember-08)" }}>org defaults · devs layer overrides</span></div>
        <div className="matrix-head" style={{ gridTemplateColumns: "1.4fr repeat(3, 0.7fr) 0.6fr" }}>
          <span>event</span>
          <span style={{ textAlign: "center" }}>slack</span>
          <span style={{ textAlign: "center" }}>gh</span>
          <span style={{ textAlign: "center" }}>ntfy</span>
          <span style={{ textAlign: "center" }}>sev</span>
        </div>
        <div style={{ flex: 1, overflow: "auto" }}>
          {[
            { e: "run.failed · hard", s: 1, g: 1, n: 1, sev: "fail" },
            { e: "run.needs_review", s: 1, g: 1, n: 0, sev: "warn" },
            { e: "ci.failed", s: 1, g: 1, n: 0, sev: "warn" },
            { e: "auditor.verdict · pass", s: 0, g: 1, n: 0, sev: "ok" },
            { e: "writer.retried · soft", s: 0, g: 0, n: 0, sev: "info" },
            { e: "cred.expiring · ≤ 7d", s: 1, g: 0, n: 1, sev: "warn" },
            { e: "budget.warn (soft cap)", s: 1, g: 0, n: 1, sev: "warn" },
            { e: "budget.hard cap hit", s: 1, g: 1, n: 1, sev: "fail" },
            { e: "schedule.audit.found · p0", s: 1, g: 1, n: 0, sev: "warn" },
            { e: "schedule.audit.found · p1", s: 0, g: 1, n: 0, sev: "info" },
            { e: "external.push · main", s: 1, g: 1, n: 0, sev: "warn" },
          ].map((r, i) => (
            <div key={i} className="matrix-row" style={{ gridTemplateColumns: "1.4fr repeat(3, 0.7fr) 0.6fr" }}>
              <span>{r.e}</span>
              <div className={"matrix-check " + (r.s ? "on" : "")}>{r.s ? "✓" : ""}</div>
              <div className={"matrix-check " + (r.g ? "on" : "")}>{r.g ? "✓" : ""}</div>
              <div className={"matrix-check " + (r.n ? "on" : "")}>{r.n ? "✓" : ""}</div>
              <span className={"matrix-sev " + r.sev}>{r.sev}</span>
            </div>
          ))}
        </div>
        <div style={{ padding: "10px 16px", borderTop: "1px solid var(--line-1)", background: "var(--bg-sunken)", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)", display: "flex", justifyContent: "space-between" }}>
          <span>+ add custom event route</span>
          <span>auto-mute on weekends · <span style={{ color: "var(--fg-1)" }}>off</span></span>
        </div>
      </div>
    </div>
  </>
);

// ===== Step 4 · Infrastructure =====
const OrgInfra = () => (
  <>
    <StepHeading
      eyebrow="step 4 · runner infrastructure"
      title="where do the"
      em="forges burn"
      sub="every spec runs in an isolated container. local docker is the default; cloud allocators scale beyond one laptop when you need them."
    />
    <div className="cols-2-1">
      <div className="col-card" style={{ gap: 10 }}>
        <div className="h"><span>allocators</span><span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>org default · per-project overridable</span></div>

        <div className="col-card live" style={{ padding: 14, display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 14, alignItems: "center", position: "relative" }}>
          <div style={{ position: "absolute", top: -8, right: 12, background: "var(--ember-08)", color: "var(--ink-12)", padding: "2px 7px", fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>active default</div>
          <div style={{ width: 40, height: 40, background: "var(--ember-08)", color: "var(--ink-12)", fontFamily: "var(--font-mono)", fontSize: 22, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>▮</div>
          <div>
            <div className="display-h">local <em style={{ color: "var(--ember-08)" }}>docker</em></div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)", marginTop: 2, lineHeight: 1.45 }}>spawns runner containers on the docker host that runs tanren itself · zero infra cost</div>
            <div style={{ display: "flex", gap: 14, marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-2)" }}>
              <span>concurrency · <b style={{ color: "var(--fg-1)" }}>3</b></span>
              <span>memory · cpu · <b style={{ color: "var(--fg-1)" }}>4gb · 2</b></span>
              <span>image · <b style={{ color: "var(--fg-1)" }}>tanren-runner</b></span>
            </div>
          </div>
          <button className="btn ghost" style={{ color: "var(--ember-08)" }}>edit defaults</button>
        </div>

        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.22em", textTransform: "uppercase", fontWeight: 700, marginTop: 6 }}>cloud allocators · scale beyond your laptop</div>
        {[
          { n: "hetzner cloud", d: "cheapest hourly · cax21 default", status: "not configured", glyph: "⌬", price: "€0.005/h" },
          { n: "digitalocean", d: "global droplets · 2gb baseline", status: "not configured", glyph: "◐", price: "$0.012/h" },
          { n: "aws ec2", d: "spot fleet via boto · vpc + iam required", status: "not configured", glyph: "⌖", price: "$0.008/h" },
          { n: "kubernetes pool", d: "bring-your-own cluster", status: "not configured", glyph: "◇", price: "byo cost" },
        ].map((c, i) => (
          <div key={i} style={{
            background: "var(--bg-sunken)",
            border: "1px solid var(--line-1)", padding: "10px 12px",
            display: "grid", gridTemplateColumns: "auto 1fr auto auto", gap: 12, alignItems: "center", borderRadius: 2,
          }}>
            <div style={{ width: 28, height: 28, border: "1px solid var(--line-2)", color: "var(--fg-2)", fontFamily: "var(--font-mono)", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>{c.glyph}</div>
            <div>
              <div className="display-h" style={{ fontSize: 13, color: "var(--fg-1)" }}>{c.n}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>{c.d}</div>
            </div>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-2)" }}>{c.price}</span>
            <StatusBadge status={c.status} />
          </div>
        ))}

        <div style={{ background: "oklch(40% 0.05 230 / 0.10)", border: "1px solid oklch(40% 0.05 230 / 0.6)", padding: "10px 12px", fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-2)", lineHeight: 1.45, borderRadius: 2 }}>
          <b style={{ color: "var(--steel-08)", fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.18em", textTransform: "uppercase" }}>↑ infra cost is not nothing</b>{" "}— each allocator's hourly machine cost rolls into the org's monthly budget. tanren tracks it next to per-token cost.
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <div className="col-card" style={{ gap: 8 }}>
          <div className="h"><span>budgets <em style={{ color: "var(--ember-08)" }}>(reminder)</em></span><span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>edit at /settings/budgets</span></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div style={{ padding: 10, background: "var(--bg-sunken)", border: "1px solid var(--line-1)", borderRadius: 2 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.18em", textTransform: "uppercase" }}>monthly cap</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 600, color: "var(--fg-1)", marginTop: 2 }}>$200</div>
            </div>
            <div style={{ padding: 10, background: "var(--bg-sunken)", border: "1px solid var(--line-1)", borderRadius: 2 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.18em", textTransform: "uppercase" }}>infra portion</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 600, color: "var(--fg-1)", marginTop: 2 }}>$0 · local</div>
            </div>
          </div>
        </div>

        <div style={{ background: "var(--bg-sunken)", border: "1px solid var(--line-1)", borderLeft: "2px solid var(--ember-08)", padding: 14, display: "flex", flexDirection: "column", gap: 6, position: "relative", borderRadius: 2 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ember-08)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>label → allocator routing</div>
          <div style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-2)", lineHeight: 1.45 }}>
            spec labels pick the allocator at run-time. e.g.:
          </div>
          <div style={{ background: "var(--bg-canvas)", border: "1px solid var(--line-1)", padding: 10, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-1)", lineHeight: 1.7, borderRadius: 2 }}>
            <div><span style={{ color: "var(--fg-3)" }}>default</span> → local-docker</div>
            <div><span style={{ color: "var(--ember-08)" }}>label: high-mem</span> → hetzner · cax31</div>
            <div><span style={{ color: "var(--ember-08)" }}>label: gpu</span> → ec2 · g4dn.xlarge</div>
            <div><span style={{ color: "var(--ember-08)" }}>label: nightly</span> → spot fleet · cheap</div>
          </div>
        </div>

        <div className="arrival-card">
          <div className="kanji-bg">鍛</div>
          <div className="eyebrow">cat-cave · ready</div>
          <div className="display">org is forged.</div>
          <div className="actions">
            <button className="btn primary notched">connect a repo ↗</button>
            <button className="btn">start a new repo</button>
          </div>
        </div>
      </div>
    </div>
  </>
);

// ===== Wrapper =====
window.OrgSetupView = ({ step, setStep, onNav }) => {
  const stepIdx = Math.max(1, Math.min(4, step || 1));
  const body =
    stepIdx === 1 ? <OrgAuth /> :
    stepIdx === 2 ? <OrgCreds /> :
    stepIdx === 3 ? <OrgNotify /> :
    <OrgInfra />;

  const journeys = [
    { l: "link the", e: "github org" },
    { l: "store", e: "credentials" },
    { l: "set up", e: "notifications" },
    { l: "provision the", e: "capacity" },
  ];

  return (
    <OnbShell
      track="org setup"
      journey={journeys[stepIdx - 1].l}
      journeyEm={journeys[stepIdx - 1].e}
      step={stepIdx}
      total={4}
      steps={ORG_STEPS}
      onStep={(i) => setStep(i)}
      onExit={() => onNav?.("project")}
    >
      {body}
      <OnbFoot
        left={stepIdx > 1 ? "back · " + ORG_STEPS[stepIdx - 2].label : "back"}
        onBack={stepIdx > 1 ? () => setStep(stepIdx - 1) : null}
        hint={
          stepIdx === 1 ? "↑ this page is the audit root — every action tanren can take is listed above" :
          stepIdx === 2 ? "↑ no roles assigned here · /settings/routing decides which key answers each loop phase (plan/write/check/audit/demo)" :
          stepIdx === 3 ? "↑ devs can override these in /me/notifications · per channel" :
          "↑ allocators are editable from /settings/infrastructure · forever"
        }
        primary={stepIdx === 4 ? "finish · open dashboard" : "next · " + ORG_STEPS[stepIdx].label}
        secondary={stepIdx === 4 ? "finish · add first project" : "skip · use defaults"}
        onPrimary={stepIdx === 4 ? () => onNav?.("project") : () => setStep(stepIdx + 1)}
      />
    </OnbShell>
  );
};
