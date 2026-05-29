// view-settings.jsx — 08 · Routing, fallbacks, escape hatches.

const SETTINGS_ROLES = [
  {
    role: "plan",
    desc: "spec → ordered subtasks · runs once per loop",
    chain: [
      { cli: "codex", model: "gpt-5.5 · responses", auth: "dev · chatgpt bundle (TW)", health: "ok" },
      { cli: "claude", model: "opus-4.7", auth: "org · api key", health: "ok" },
    ],
  },
  {
    role: "write",
    desc: "writer subtasks · heaviest spend · longest fallback ok",
    chain: [
      { cli: "opencode", model: "glm-5.1", auth: "dev · zai subscription bundle (TW)", health: "ok" },
      { cli: "claude", model: "sonnet-4.6", auth: "org · api key", health: "warn", changed: true },
      { cli: "codex", model: "gpt-5.5", auth: "dev · chatgpt bundle (TW)", health: "ok" },
    ],
  },
  {
    role: "check",
    desc: "verify per-subtask · cheap model preferred",
    chain: [
      { cli: "codex", model: "gpt-5.5-low", auth: "dev · chatgpt bundle (TW)", health: "ok" },
      { cli: "claude", model: "haiku-4.5", auth: "org · api key", health: "ok" },
    ],
  },
  {
    role: "audit",
    desc: "spec-level verdict · strongest reasoning model · no dev bundles",
    chain: [
      { cli: "claude", model: "opus-4.7", auth: "org · api key", health: "ok", changed: true },
      { cli: "codex", model: "gpt-5.5", auth: "org · openai api key", health: "ok" },
    ],
  },
  {
    role: "demo",
    desc: "spec-completion narration for review · cheap, optional",
    chain: [
      { cli: "claude", model: "haiku-4.5", auth: "org · api key", health: "ok", changed: true },
    ],
  },
];

const SETTINGS_VAULT = [
  { label: "codex chatgpt bundle (TW)", path: "vault://dev/tw/codex/chatgpt", policy: "auto-refresh on use", detail: "session cookie refreshes on each runner launch · no manual rotation needed" },
  { label: "zai subscription bundle (TW)", path: "vault://dev/tw/opencode/zai", policy: "auto-refresh on subscription cycle", detail: "monthly refresh tied to your zai subscription · 17d remaining" },
  { label: "claude · org api key", path: "vault://org/claude/api-key", policy: "manual · 90d cadence", detail: "next prompted rotation in 67d · forge will draft the rotation pr" },
  { label: "openai · org api key", path: "vault://org/openai/api-key", policy: "manual · on revocation", detail: "rotate only when revoked or compromised · no scheduled cycle" },
  { label: "github app · cat-cave", path: "vault://org/github/app", policy: "auto · jwt + installation token", detail: "short-lived tokens minted per call · jwt rotates yearly" },
];

window.SettingsView = ({ onNav, auditGate }) => (
  <>
    <PageHead
      eyebrow={auditGate ? "▮ settings · tanren.config.yaml" : "▮ settings · routing & limits"}
      title={<>routing, fallbacks, <em>escape hatches</em></>}
      sub={auditGate
        ? <>cat-cave/tanren-config/main/tanren.yaml · committed via pr · forge can edit</>
        : <>org · cat-cave · routing & limits · stored in dashboard</>
      }
      actions={
        <>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--status-warn)" }}>! 3 unsaved changes</span>
          <button className="btn">view as yaml</button>
          <button className="btn ghost">discard</button>
          <button className="btn primary notched" onClick={() => auditGate && onNav?.("config")}>{auditGate ? "propose pr ↗" : "save changes"}</button>
        </>
      }
    />
    <div className="page-body scrolls">
      <div className="split-row" style={{ gridTemplateColumns: "1.5fr 1fr", minHeight: 560 }}>
        <div className="panel" style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div className="panel-head">
            <h3>routing · <em>role → fallback chain</em></h3>
            <span className="meta">(cli · model · auth) tuples · drag to reorder</span>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
            {SETTINGS_ROLES.map((r, i) => (
              <div key={i} className="routing-role">
                <div className="role-head">
                  <span className="role">▸ {r.role}</span>
                  <span className="desc">{r.desc}</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {r.chain.map((c, j) => (
                    <div key={j} className={"routing-row" + (j === 0 ? " first" : "") + (c.changed ? " changed" : "")}>
                      <span className="rank">{j === 0 ? "preferred" : "↓ " + (j + 1)}</span>
                      <span className="cli">{c.cli}</span>
                      <span>{c.model}</span>
                      <span className="auth">{c.auth}</span>
                      <span className={"health " + c.health}>{c.health === "warn" ? "rate-limited" : c.health}</span>
                      <span className="acts"><span>↕</span><span>×</span></span>
                    </div>
                  ))}
                  <button className="btn ghost" style={{ fontSize: 11, color: "var(--ember-08)", alignSelf: "flex-start" }}>+ add fallback</button>
                </div>
              </div>
            ))}
          </div>
          <div style={{ padding: "10px 14px", borderTop: "1px solid var(--line-1)", background: "var(--bg-sunken)", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-2)" }}>
            <span style={{ color: "var(--ember-08)", marginRight: 6 }}>↑</span>auth refs point at vault entries from org setup · dev creds bill the dev · org creds bill the org
          </div>
        </div>

        <div className="panel" style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div className="panel-head">
            <h3>vault · <em>per-cred policy</em></h3>
            <span className="meta">rotation is contextual · no one-size-fits-all</span>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
            {SETTINGS_VAULT.map((c, i) => (
              <div key={i} className="vault-card">
                <div className="top">
                  <span className="label">{c.label}</span>
                  <span className="state">ok</span>
                </div>
                <div className="path">{c.path}</div>
                <div className="policy">↻ {c.policy}</div>
                <div className="detail">{c.detail}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="col-card live" style={{ padding: "12px 16px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ember-08)", letterSpacing: "0.22em", textTransform: "uppercase", fontWeight: 700 }}>▮ escape hatches · not perf budgets</span>
          <span style={{ fontFamily: "var(--font-ui)", fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.45 }}>tanren's leverage is parallel dag execution. don't squeeze individual specs for speed — let them take what they take. these limits exist to stop runaway loops, nothing else.</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
          {[
            { l: "max writer iter per subtask", v: "5", t: "→ escalate to operator (halt)" },
            { l: "max planner re-runs per spec", v: "3", t: "→ revise spec (halt)" },
            { l: "max retries per task on transient fail", v: "3", t: "→ try next fallback in chain" },
            { l: "max spec-discovery rounds with forge", v: "20", t: "→ checkpoint · resume later" },
          ].map((h, i) => (
            <div key={i} className="hatch-card">
              <div className="l">{h.l}</div>
              <div className="v">{h.v}</div>
              <div className="t">{h.t}</div>
            </div>
          ))}
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)", paddingTop: 4, borderTop: "1px solid oklch(68% 0.22 40 / 0.25)" }}>
          <b style={{ color: "var(--fg-1)" }}>not configured here:</b> per-task time limits · per-spec wallclock caps · per-iteration token caps. tanren's escape hatch is the count, not the clock.
        </div>
      </div>

      <div className="forge-card" style={{ padding: "10px 14px", flexDirection: "row", alignItems: "center", gap: 12, display: "flex" }}>
        <div style={{ fontFamily: "var(--font-jp)", fontSize: 18, color: "var(--ember-08)" }}>鍛</div>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 13, color: "var(--fg-1)", textTransform: "lowercase" }}>tell forge to change config</div>
        <div style={{ flex: 1, padding: "6px 10px", background: "var(--bg-sunken)", border: "1px solid var(--line-1)", fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-3)", borderRadius: 2 }}>
          <span style={{ color: "var(--ember-08)", marginRight: 8 }}>▸</span>
          "swap audit primary to claude opus 4.7" · "add gemini-2.5-pro as a write fallback" · "raise max writer iter to 8"
        </div>
        {auditGate ? (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)" }}>
            edits land as a pr in <code style={{ color: "var(--ember-07)", background: "var(--bg-sunken)", padding: "0 5px", border: "1px solid var(--line-1)" }}>cat-cave/tanren-config</code> · <a style={{ color: "var(--ember-08)", cursor: "pointer" }} onClick={() => onNav?.("config")}>review before merge ↗</a>
          </span>
        ) : (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)" }}>
            edits land in the dashboard · no pr required · <a style={{ color: "var(--ember-08)", cursor: "pointer" }} onClick={() => onNav?.("config")}>enable audit gate ↗</a>
          </span>
        )}
      </div>
    </div>
  </>
);
