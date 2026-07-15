// view-onboard-existing-gov.jsx — 01c · step E5 (governance posture) + the
// ExistingProjectView wrapper that routes step → component. Loads LAST of the
// existing-onboard trio so every step component is in scope before the wrapper.

// ===== E5 · Governance posture =====
const ExistGov = () => {
  const [posture, setPosture] = React.useState("strict");
  const postures = [
    {
      id: "strict",
      name: "strict — you describe, we forge",
      body: "External commits block the merge until an operator explicitly decides how to proceed. Tanren tracks the change; it does not silently merge around it.",
      best: "for teams committing to the spec discipline",
      policy: [
        ["external commit on a Tanren PR", "block merge · operator action required"],
        ["human-opened PR without a spec", "hold merge · offer to create a spec"],
        ["force-push to a Tanren PR", "block merge · escalate"],
        ["direct push to main (admin bypass)", "notify operators · investigate"],
      ],
    },
    {
      id: "open",
      name: "open — humans + tanren both push",
      body: "Tanren coexists with external commits. Human changes remain normal repository work and do not block a merge; Tanren continues its own specs and audits.",
      best: "for established teams retrofitting tanren",
      policy: [
        ["external commit on a Tanren PR", "coexist · no merge block"],
        ["human-opened PR without a spec", "observe · no spec required"],
        ["force-push to a Tanren PR", "record · notify operators"],
        ["direct push to main (admin bypass)", "record · no merge block"],
      ],
    },
    {
      id: "audit_only",
      name: "audit-only — tanren just watches",
      body: "External commits become observed handoffs. Tanren surfaces patterns, regressions, and drift, but it does not merge or modify the human change.",
      best: "for a 4-week trial without code-modification risk",
      policy: [
        ["external commit on a Tanren PR", "observed handoff · Tanren does not merge"],
        ["human-opened PR without a spec", "observe only · operator promotes findings"],
        ["force-push to a Tanren PR", "record drift · notify operators"],
        ["direct push to main (admin bypass)", "observe only · no Tanren merge"],
      ],
    },
  ];
  const selected = postures.find((item) => item.id === posture);

  return (
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
        {postures.map((p) => {
          const active = p.id === posture;
          return (
          <button key={p.id} type="button" className={"col-card" + (active ? " live" : "")} onClick={() => setPosture(p.id)} aria-pressed={active} style={{ padding: "12px 14px", gap: 6, cursor: "pointer", textAlign: "left", width: "100%" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 14, height: 14, border: "1.5px solid " + (active ? "var(--ember-08)" : "var(--line-2)"), background: active ? "var(--ember-08)" : "transparent", borderRadius: 50, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {active && <div style={{ width: 5, height: 5, background: "var(--ink-12)", borderRadius: 50 }}></div>}
              </div>
              <div className="display-h" style={{ fontSize: 14 }}>{p.name}</div>
            </div>
            <div style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-2)", lineHeight: 1.45, paddingLeft: 22 }}>{p.body}</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: active ? "var(--ember-08)" : "var(--fg-3)", paddingLeft: 22 }}>↑ best for: {p.best}</div>
          </button>
          );
        })}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <div className="col-card" style={{ gap: 8 }}>
          <div className="h"><span>external-push policy</span><span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>{selected.name.split(" — ")[0]} posture</span></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {selected.policy.map(([t, a], i) => (
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
};

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
