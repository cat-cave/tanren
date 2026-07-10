// view-review.jsx — 06 · Review Handoff.
// Forge-led chat review with inline behavior checklist + deferral resolutions,
// preview pane alongside, readiness gate at the bottom.

const ReviewChat = ({ behaviors, toggleBehavior, deferralStates, setDeferralState, showSubopt }) => (
  <div className="forge-card">
    <div className="head">
      <span className="stamp">鍛</span>
      <span className="title">forge · <em>review</em></span>
      <span className="meta">5 behaviors · 2 deferred · ci green</span>
    </div>
    <div className="body">
      {/* 1. Opening turn */}
      <ForgeTurn>
        Ready to review. Walk through <b className="accent">5 behaviors</b> and <b className="accent">2 items I deferred during the run</b>. Tick each as you verify. The preview is loaded on the right.
      </ForgeTurn>

      {/* 2. Behavior checklist (inline, interactive) */}
      <ForgeTurn>
        <div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ember-08)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700, marginBottom: 8 }}>
            behaviors · {behaviors.filter(b => b.done).length} of {behaviors.length} verified
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {behaviors.map((b) => (
              <div
                key={b.n}
                className={"behavior" + (b.done ? " done" : "")}
                onClick={() => toggleBehavior(b.n)}
              >
                <div className="check">{b.done ? "✓" : ""}</div>
                <div className="t"><b>b{b.n}</b>{b.t}</div>
                <span className="ci">ci {b.ci}</span>
                <span className="you">{b.done ? "you ✓" : "you ○"}</span>
              </div>
            ))}
          </div>
        </div>
      </ForgeTurn>

      {/* 3. Suboptimal: review stall */}
      {showSubopt && (
        <ForgeTurn>
          <Subopt data={REVIEW_SUBOPT} />
        </ForgeTurn>
      )}

      {/* 4. Deferral items */}
      <ForgeTurn>
        <div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--status-warn)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>
            i deferred {REVIEW_DEFERRALS.length} things during the run · decide before merge
          </div>
          <div style={{ fontFamily: "var(--font-ui)", fontSize: 12.5, color: "var(--fg-2)", lineHeight: 1.55, marginBottom: 8 }}>
            Neither blocks shipping by themselves. But you're the human eye — if they should be handled now, I'll loop back to the planner and add subtasks to this spec. Spawning a separate spec is the deferral.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {REVIEW_DEFERRALS.map((c, i) => {
              const state = deferralStates[i];
              return (
                <div key={i} className="deferral" style={state ? { opacity: 0.55 } : null}>
                  <div className="head">
                    <span className="tag">{c.tag}</span>
                    <span className="t">{c.title}</span>
                    {state && (
                      <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ember-08)", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700 }}>
                        ✓ {state}
                      </span>
                    )}
                  </div>
                  <div className="det">{c.det}</div>
                  {!state && (
                    <div className="actions">
                      {c.actions.map((a, j) => (
                        <button
                          key={j}
                          className={"btn" + (a.primary ? " primary notched" : "") + (a.ghost ? " ghost" : "")}
                          onClick={() => setDeferralState(i, a.label.split(" ·")[0])}
                        >{a.label}</button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </ForgeTurn>

      {/* 5. Forge nudge with prompts */}
      <ForgeTurn>
        <div>
          {behaviors.filter(b => !b.done).length > 0 ? (
            <>{behaviors.filter(b => !b.done).length} behavior{behaviors.filter(b => !b.done).length > 1 ? "s" : ""} left to eyeball. Want quick prompts, or have a question about the change?</>
          ) : (
            <>All behaviors verified ✓. {Object.keys(deferralStates).length === REVIEW_DEFERRALS.length ? "Deferrals settled. Ready to sign off." : "Settle the deferrals to unlock sign-off."}</>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {REVIEW_PROMPTS.map((q, i) => (
              <span key={i} className="chip"><span className="pre">↑</span> {q}</span>
            ))}
          </div>
        </div>
      </ForgeTurn>
    </div>
    <div className="forge-input">
      <span className="stamp">鍛</span>
      <input placeholder="type · or click any checkbox above" />
      <span className="kbd">↵</span>
    </div>
  </div>
);

const PreviewPane = () => {
  const [device, setDevice] = React.useState("desktop");
  return (
    <div className="preview">
      <div className="head">
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ember-08)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>preview</span>
        <div className="url">pr-142.preview.fly.dev/settings</div>
        <div className="device-tabs">
          {["desktop", "tablet", "mobile"].map(d => (
            <button key={d} className={device === d ? "active" : ""} onClick={() => setDevice(d)}>{d}</button>
          ))}
        </div>
        <button className="btn" style={{ fontSize: 11, padding: "4px 9px" }}>open ↗</button>
      </div>
      <div className="frame">
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--ink-09)", fontFamily: "system-ui, sans-serif", fontSize: 12 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: "var(--ink-12)" }}>Acme</span>
          <span style={{ color: "var(--ink-08)" }}>·</span>
          <span>Settings</span>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-08)" }}>tw@cat-cave.dev</span>
        </div>
        <div style={{ height: 1, background: "oklch(85% 0.008 220)" }}></div>
        <div style={{ fontFamily: "system-ui, sans-serif", fontWeight: 700, fontSize: 22, color: "var(--ink-12)" }}>Settings</div>
        <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 12, color: "var(--ink-08)" }}>Manage your account preferences.</div>

        <div style={{
          padding: 14, background: "white",
          border: "1px solid oklch(85% 0.008 220)", borderRadius: 4,
          position: "relative",
          maxWidth: device === "mobile" ? 320 : device === "tablet" ? 480 : "none",
        }}>
          <div style={{ fontFamily: "system-ui, sans-serif", fontWeight: 600, fontSize: 14, color: "var(--ink-12)" }}>Theme</div>
          <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 12, color: "var(--ink-08)", marginTop: 2 }}>Pick how Acme looks for you.</div>
          <div style={{
            marginTop: 10, padding: "8px 11px",
            border: "1.5px solid var(--ember-08)", borderRadius: 3,
            display: "flex", alignItems: "center", gap: 6,
            fontFamily: "system-ui, sans-serif", fontSize: 13, color: "var(--ink-12)",
            background: "oklch(98% 0.012 70)",
            boxShadow: "0 0 0 3px oklch(68% 0.22 40 / 0.12)",
          }}>
            <span style={{ fontWeight: 600 }}>Dark</span>
            <span style={{ marginLeft: "auto", color: "var(--ink-09)" }}>▾</span>
          </div>
          <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 10.5, color: "var(--status-ok)", marginTop: 8 }}>✓ Saved · synced to profile</div>
          <div style={{
            position: "absolute", top: -6, right: -6,
            background: "var(--ember-08)", color: "var(--ink-12)",
            fontFamily: "var(--font-mono)", fontSize: 8.5, fontWeight: 700, letterSpacing: "0.14em",
            padding: "2px 7px",
          }}>NEW</div>
        </div>

        <div style={{ marginTop: 6, fontFamily: "system-ui, sans-serif", fontSize: 11, color: "var(--ink-08)" }}>
          Try clicking the dropdown above. Then reload the preview to verify persistence.
        </div>

        {/* Artifacts */}
        <div style={{ marginTop: "auto", display: "flex", flexWrap: "wrap", gap: 4, paddingTop: 12 }}>
          {[
            { l: "android apk",    icon: "⬇" },
            { l: "ios testflight", icon: "↗" },
            { l: "storybook",      icon: "↗" },
            { l: "qr · scan",      icon: "▢" },
          ].map((a, i) => (
            <div key={i} style={{
              padding: "3px 8px", background: "white",
              border: "1px solid oklch(85% 0.008 220)",
              fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-12)",
              cursor: "pointer", borderRadius: 2,
            }}>
              <span style={{ color: "var(--ember-08)", marginRight: 4 }}>{a.icon}</span>{a.l}
            </div>
          ))}
        </div>
      </div>
      <div style={{
        padding: "8px 14px", borderTop: "1px solid var(--line-1)",
        background: "var(--bg-sunken)",
        fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)",
        display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
      }}>
        <span>screen too narrow?</span>
        <a style={{ color: "var(--ember-08)", textDecoration: "underline", cursor: "pointer" }}>open preview in a new tab ↗</a>
        <span style={{ marginLeft: "auto" }}>3 device sizes</span>
      </div>
    </div>
  );
};

window.ReviewView = ({ onNav, showSubopt, mergeIntegration = "native" }) => {
  const [behaviors, setBehaviors] = React.useState(REVIEW_BEHAVIORS);
  const [deferralStates, setDeferralStates] = React.useState({});

  const toggleBehavior = (n) => {
    setBehaviors(bs => bs.map(b => b.n === n ? { ...b, done: !b.done } : b));
  };
  const setDeferralState = (i, label) => {
    setDeferralStates(s => ({ ...s, [i]: label }));
  };

  const allBehaviorsDone = behaviors.every(b => b.done);
  const allDeferralsResolved = Object.keys(deferralStates).length === REVIEW_DEFERRALS.length;
  const canSignOff = allBehaviorsDone && allDeferralsResolved;
  const verifiedCount = behaviors.filter(b => b.done).length;
  const resolvedCount = Object.keys(deferralStates).length;

  return (
    <>
      <PageHead
        eyebrow={`▮ ${REVIEW.pr} · ${REVIEW.repo}`}
        title={<>review with <em>forge</em></>}
        sub={<>{REVIEW.spec} · {REVIEW.title} · forged by {REVIEW.forgedBy} · {REVIEW.cost}</>}
        actions={
          <>
            <button className="btn ghost" onClick={() => onNav?.("project")}>← back to project</button>
            <button className="btn">open pr on github ↗</button>
          </>
        }
      />
      <div className="page-body">
        <div className="split-row split-review">
          <ReviewChat
            behaviors={behaviors}
            toggleBehavior={toggleBehavior}
            deferralStates={deferralStates}
            setDeferralState={setDeferralState}
            showSubopt={showSubopt}
          />
          <PreviewPane />
        </div>
      </div>

      {/* Readiness gate */}
      <div className="readiness">
        <span className="pill ok"><span className="d"></span>ci green</span>
        <span className={"pill " + (allBehaviorsDone ? "ok" : "warn")}>
          <span className="d"></span>{verifiedCount} / {behaviors.length} you-verified
        </span>
        <span className={"pill " + (allDeferralsResolved ? "ok" : "warn")}>
          <span className="d"></span>{REVIEW_DEFERRALS.length} deferred · {resolvedCount} resolved
        </span>
        <span className="note">
          {canSignOff
            ? "· ready to sign off"
            : "· can't sign off until behaviors + deferrals are settled"}
        </span>
        <div className="grow">
          <button className="btn danger">request changes ↗</button>
          <MergeActions mode={mergeIntegration} canSignOff={canSignOff} />
        </div>
      </div>
    </>
  );
};

// Repo-level merge-integration controls the sign-off CTAs.
// Modes: native (MergeAuthority / native queue) | direct | external | none
// `request changes` lives above this and is always available.
const MergeActions = ({ mode, canSignOff }) => {
  if (mode === "none") {
    return (
      <>
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: 10,
          color: "var(--fg-3)", letterSpacing: "0.04em",
          alignSelf: "center",
        }}>
          repo has no merge integration · <a style={{ color: "var(--ember-08)", cursor: "pointer" }}>configure ↗</a>
        </span>
        <button className="btn" disabled title="configure a merge integration in repo settings">
          sign off · merge integration not configured
        </button>
      </>
    );
  }
  if (mode === "external") {
    return (
      <button className="btn primary notched" disabled={!canSignOff}>
        approve · notify reviewer
      </button>
    );
  }
  if (mode === "direct") {
    return (
      <button className="btn primary notched" disabled={!canSignOff}>
        sign off · merge now ↗
      </button>
    );
  }
  // native queue / MergeAuthority (default finished path)
  return (
    <>
      <button className="btn" disabled={!canSignOff}>sign off · enqueue native queue</button>
      <button className="btn primary notched" disabled={!canSignOff}>sign off · merge now ↗</button>
    </>
  );
};
