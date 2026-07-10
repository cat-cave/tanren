// flows.jsx — shared primitives for the workflow views beyond project/run/review.
// Used by the onboarding tracks, discovery, failure, settings, costs.

// =====================================================================
// ONBOARDING SHELL — strip-down chrome (no sidenav) with journey stepper
// at the top. Tracks are linear; user clicks the step heads to jump.
// =====================================================================
const OnbShell = ({ track, journey, journeyEm, step, total, steps, onStep, onExit, children }) => (
  <div className="onb-shell">
    <div className="onb-topbar">
      <div className="brand">
        <span className="dot"></span>tanren
      </div>
      <div className="track">
        <span className="eyebrow">▮ {track}</span>
        <span className="step">step {step} of {total} · {steps[step - 1]?.label}</span>
      </div>
      <div className="right">
        <button className="btn ghost" onClick={onExit}>↩ dashboard</button>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--status-ok)" }}>✓ autosaved</span>
      </div>
    </div>

    <div className="onb-journey">
      {steps.map((s, i) => {
        const idx = i + 1;
        const state = idx < step ? "done" : idx === step ? "live" : "queued";
        return (
          <React.Fragment key={i}>
            <button
              className={"j-step " + state}
              onClick={() => onStep?.(idx)}
              title={s.label}
            >
              <span className="num">
                {state === "done" ? "✓" : idx}
              </span>
              <span className="lbl">{s.label}</span>
            </button>
            {i < steps.length - 1 && <span className={"j-arrow " + (state === "done" ? "done" : "")}>→</span>}
          </React.Fragment>
        );
      })}
    </div>

    <div className="onb-body">
      <div className="onb-head">
        <div className="eyebrow">step {step} · {track}</div>
        <div className="page-title">
          {journey} <em>{journeyEm}</em>
        </div>
      </div>
      <div className="onb-content">
        {children}
      </div>
    </div>
  </div>
);

// Step header WITHIN an OnbShell body — shows the substep eyebrow + heading
const StepHeading = ({ eyebrow, title, em, sub, right }) => (
  <div className="step-heading">
    <div>
      <div className="eyebrow" style={{ color: "var(--ember-08)" }}>{eyebrow}</div>
      <div className="title">{title} <em>{em}</em></div>
      {sub && <div className="sub">{sub}</div>}
    </div>
    {right && <div className="right">{right}</div>}
  </div>
);

// Footer bar for onboarding steps — primary action + secondary
const OnbFoot = ({ left, hint, primary, secondary, onPrimary, onSecondary, onBack }) => (
  <div className="onb-foot">
    {onBack && <button className="btn ghost" onClick={onBack}>← {left || "back"}</button>}
    {hint && <div className="hint">{hint}</div>}
    <div className="grow"></div>
    {secondary && <button className="btn" onClick={onSecondary}>{secondary}</button>}
    {primary && <button className="btn primary notched" onClick={onPrimary}>{primary}</button>}
  </div>
);

// =====================================================================
// FORGE CHAT PANEL — used in onboarding/discovery/recovery.
// Inline panel; not the ⌘K modal. Has clip-notched border, header, scroll, composer.
// =====================================================================
const ForgeChat = ({ title, meta, children, placeholder, hint }) => (
  <div className="forge-card chat-panel">
    <div className="head">
      <span className="stamp">鍛</span>
      <span className="title">forge · <em>{title}</em></span>
      {meta && <span className="meta">{meta}</span>}
    </div>
    <div className="body chat-scroll">
      {children}
    </div>
    <div className="forge-input">
      <span className="stamp">鍛</span>
      <input placeholder={placeholder || "type · or click a suggestion"} />
      <span className="kbd">⌥+↵</span>
    </div>
    {hint && <div className="chat-foot">{hint}</div>}
  </div>
);

// Speech bubble — Forge (kanji avatar) or user (initials)
const Turn = ({ who = "forge", children }) => (
  <div className={"forge-turn " + (who === "user" ? "user" : "")}>
    {who === "forge"
      ? <div className="avatar f">鍛</div>
      : <div className="avatar u">TW</div>}
    <div className="bubble">{children}</div>
  </div>
);

// Inline action chips (small buttons attached to a Forge bubble)
const InlineActions = ({ children }) => (
  <div className="inline-actions">{children}</div>
);

// =====================================================================
// PROVENANCE BANNER — "this insight came from X" header card
// =====================================================================
const InsightBanner = ({ source, sourceLabel, who, when, body, glyph = "⌥", tone = "ember" }) => (
  <div className={"insight-banner tone-" + tone}>
    <div className="glyph">{glyph}</div>
    <div className="body">
      <div className="meta">
        <span className="lbl">▮ insight · {sourceLabel}</span>
        <span className="src">{source} · {who} · {when}</span>
      </div>
      <div className="text">{body}</div>
    </div>
    <div className="open">open source ↗</div>
  </div>
);

// =====================================================================
// DELTA CARD — "what's being added / modified / impacted"
// =====================================================================
const DeltaCard = ({ title, kind, count, deltas }) => (
  <div className={"delta-card kind-" + kind}>
    <div className="head">
      <span className="lbl">{kind === "add" ? "+ added" : kind === "mod" ? "~ modified" : "· impacted"}</span>
      <span className="t">{title}</span>
      <span className="count">{count}</span>
    </div>
    <div className="rows">
      {deltas.map((d, i) => <div key={i} className="row">{d}</div>)}
    </div>
  </div>
);

// =====================================================================
// DAG IMPACT STRIP — horizontal flow showing where new specs land
// =====================================================================
const DAGImpact = ({ label, costRange, eta, pre = [], newOnes = [], post = [] }) => (
  <div className="dag-impact">
    <div className="head">
      <span className="lbl">▮ dag impact · {label}</span>
      <span className="meta">{newOnes.length} new specs · est {costRange} · eta {eta}</span>
      <a className="open">open full dag ↗</a>
    </div>
    <div className="track">
      {pre.map((n, i) => (
        <React.Fragment key={"p" + i}>
          <span className="node old">{n}</span>
          <span className="sep">→</span>
        </React.Fragment>
      ))}
      {newOnes.map((n, i) => (
        <React.Fragment key={"n" + i}>
          <span className="node new"><span className="tag">new</span>{n}</span>
          {i < newOnes.length - 1 && <span className="sep new">→</span>}
        </React.Fragment>
      ))}
      {post.length > 0 && <span className="sep">→</span>}
      {post.map((n, i) => (
        <React.Fragment key={"o" + i}>
          <span className="node old">{n}</span>
          {i < post.length - 1 && <span className="sep">→</span>}
        </React.Fragment>
      ))}
    </div>
  </div>
);

// =====================================================================
// FIELD GROUP — labeled form input (we render placeholder content)
// =====================================================================
const Field = ({ label, value, placeholder, hint, kind = "text" }) => (
  <div className="field">
    <div className="label">{label}</div>
    <div className={"input " + (value ? "filled" : "empty")}>
      {value || placeholder}
      {kind === "select" && <span className="caret">▾</span>}
    </div>
    {hint && <div className="hint">{hint}</div>}
  </div>
);

// =====================================================================
// TOGGLE PILL — used in matrices (notifications, audits, sources)
// =====================================================================
const Toggle = ({ on }) => (
  <div className={"toggle " + (on ? "on" : "off")}>
    <div className="knob"></div>
  </div>
);

// StatusBadge — connection state for integrations (available | auth needed | off).
// Every integration is *available*; this badge reflects live connection state.
const StatusBadge = ({ status }) => {
  const kind =
    status === "connected" || status === "always-on" ? "on" :
    status === "auth needed" || status === "action needed" ? "warn" :
    "off";
  return <span className={"status-badge status-" + kind}>{status}</span>;
};

// =====================================================================
// EXPORT
// =====================================================================
Object.assign(window, {
  OnbShell, StepHeading, OnbFoot,
  ForgeChat, Turn, InlineActions,
  InsightBanner, DeltaCard, DAGImpact,
  Field, Toggle, StatusBadge,
});
