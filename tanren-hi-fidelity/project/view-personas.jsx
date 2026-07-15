// view-personas.jsx — org-level personas: cross-project people-models whose
// behaviors drive specs and acceptance tests.

const ORG_PERSONAS = [
  {
    name: "developer · fixture operator",
    proj: "tanren-fixture-easy",
    desc: "runs the e2e fixture, no real users · inferred from code",
    behaviors: ["run the e2e fixture", "view current theme", "toggle theme via api", "sync theme to profile"],
    devices: ["desktop"],
    inferred: true,
  },
  {
    name: "ops manager",
    proj: "supply-chain-os",
    desc: "orders, supplier scoring, cross-warehouse view",
    behaviors: ["place a purchase order", "review supplier scorecard", "approve order over $5k"],
    devices: ["desktop"],
  },
  {
    name: "line worker",
    proj: "supply-chain-os",
    desc: "handheld · barcode + bin moves · the hot path",
    behaviors: ["clock in with badge", "pull pick list", "scan item to tote", "confirm scan", "push tote to staging"],
    devices: ["handheld"],
    hot: true,
  },
  {
    name: "cfo",
    proj: "supply-chain-os",
    desc: "monthly reports, edi reconciliation, cost variance",
    behaviors: ["review monthly close", "export to csv", "drill into variance"],
    devices: ["desktop"],
  },
  {
    name: "marketing reader",
    proj: "cat-cave-www",
    desc: "anonymous visitor · case studies + signup",
    behaviors: ["read a case study", "subscribe to updates"],
    devices: ["desktop", "mobile"],
  },
];

window.PersonasView = ({ onNav }) => {
  const [sharedPersona, setSharedPersona] = React.useState(null);
  const [behaviorsView, setBehaviorsView] = React.useState(false);
  const [forgePersona, setForgePersona] = React.useState(null);
  const [shapedPersona, setShapedPersona] = React.useState(null);
  const [forgeInstructions, setForgeInstructions] = React.useState({});
  const [expandedScenarios, setExpandedScenarios] = React.useState({});

  const instructionFor = (persona) => forgeInstructions[persona.name] ?? (persona.draft
    ? "Help define this shared persona and its first behavior."
    : `Refine ${persona.name}'s behaviors for the next spec pass.`);

  const shapePersona = (persona) => {
    const instruction = instructionFor(persona).trim();
    setShapedPersona({
      name: persona.name,
      instruction: instruction || "No additional Forge instructions provided.",
    });
  };
  const personas = sharedPersona ? [...ORG_PERSONAS, sharedPersona] : ORG_PERSONAS;

  const addSharedPersona = () => {
    setSharedPersona({
      name: "new shared persona",
      proj: "all projects",
      desc: "a shared draft ready for Forge to shape into behaviors",
      behaviors: ["describe the first cross-project behavior"],
      devices: ["desktop"],
      draft: true,
    });
    setForgePersona("new shared persona");
  };

  const toggleScenarios = (name) => {
    setExpandedScenarios((current) => ({ ...current, [name]: !current[name] }));
  };

  return (
  <>
    <PageHead
      eyebrow="▮ org · cat-cave"
      title={<>the <em>personas</em></>}
      sub={<>5 personas across 3 projects · each owns the behaviors that drive specs and acceptance tests</>}
      actions={
        <>
          <button className="btn ghost" onClick={addSharedPersona} disabled={Boolean(sharedPersona)}>+ shared persona</button>
          <button className="btn" onClick={() => setBehaviorsView((current) => !current)}>{behaviorsView ? "persona overview ↙" : "behaviors view ↗"}</button>
        </>
      }
    />
    <div className="page-body scrolls">
      <div className="col-card live" style={{ padding: "10px 14px", flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ember-08)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>▸ personas drive specs</span>
        <span style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-2)", lineHeight: 1.45 }}>
          every behavior under a persona becomes a bdd scenario tanren can implement and verify. edit a persona; the spec dag reshapes.
        </span>
      </div>

      {behaviorsView && (
        <div className="col-card live" style={{ padding: "10px 14px", flexDirection: "row", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ember-08)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>▸ behaviors view</span>
          <span style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-2)", lineHeight: 1.45 }}>each card is now organized around its executable behaviors and BDD coverage.</span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
        {personas.map((p, i) => (
          <div key={i} className={"col-card" + (p.hot ? " live" : "")} style={{ padding: 14, gap: 8 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 17, color: "var(--fg-1)", letterSpacing: "-0.025em", textTransform: "lowercase" }}>{p.name}</div>
              {p.inferred && <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--status-warn)", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700 }}>inferred</span>}
              {p.draft && <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700 }}>shared draft</span>}
              <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ember-08)", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700, cursor: "pointer" }} onClick={() => onNav?.("project")}>{p.proj} ↗</span>
            </div>
            {!behaviorsView && <div style={{ fontFamily: "var(--font-ui)", fontSize: 12.5, color: "var(--fg-2)", lineHeight: 1.45 }}>{p.desc}</div>}

            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {p.devices.map((d, j) => (
                <span key={j} style={{ padding: "2px 7px", background: "var(--bg-sunken)", border: "1px solid var(--line-1)", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-2)", borderRadius: 1, letterSpacing: "0.1em", textTransform: "uppercase" }}>{d}</span>
              ))}
            </div>

            <div style={{ paddingTop: 8, borderTop: "1px solid var(--line-1)" }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: behaviorsView ? "var(--ember-08)" : "var(--fg-3)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>{behaviorsView ? "executable behaviors" : "behaviors"} · {p.behaviors.length}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-1)", lineHeight: 1.5 }}>
                {p.behaviors.map((b, j) => (
                  <div key={j}><span style={{ color: "var(--ember-08)", marginRight: 6 }}>b{j+1}</span>{b}</div>
                ))}
              </div>
            </div>

            {forgePersona === p.name && (
              <div style={{ padding: 10, background: "var(--bg-sunken)", border: "1px solid var(--ember-08)", display: "flex", flexDirection: "column", gap: 7 }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 700 }}>▸ Forge · persona narrative</div>
                <div style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-2)", lineHeight: 1.45 }}>Forge is ready to turn this persona’s context into scoped behaviors, BDD scenarios, and acceptance criteria.</div>
                <textarea aria-label={`Forge instructions for ${p.name}`} value={instructionFor(p)} onChange={(event) => setForgeInstructions((current) => ({ ...current, [p.name]: event.target.value }))} style={{ minHeight: 52, resize: "vertical", background: "var(--bg-canvas)", border: "1px solid var(--line-2)", color: "var(--fg-1)", padding: 7, fontFamily: "var(--font-ui)", fontSize: 12 }} />
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="btn" style={{ fontSize: 10 }} onClick={() => shapePersona(p)}>shape with forge</button>
                  <button className="btn ghost" style={{ fontSize: 10 }} onClick={() => setForgePersona(null)}>close</button>
                </div>
                {shapedPersona?.name === p.name && <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--status-ok)", lineHeight: 1.45 }}>▸ Forge shaped the narrative into the next behavior and BDD pass: {shapedPersona.instruction}</div>}
              </div>
            )}

            {expandedScenarios[p.name] && (
              <div style={{ padding: 10, background: "var(--bg-sunken)", border: "1px solid var(--line-1)", display: "flex", flexDirection: "column", gap: 7 }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 700 }}>bdd scenarios · {p.behaviors.length}</div>
                {p.behaviors.map((behavior, j) => (
                  <div key={j} style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-2)", lineHeight: 1.5 }}>
                    <span style={{ color: "var(--fg-1)" }}>scenario {j + 1}:</span> given {p.name} is ready, when they {behavior}, then Tanren verifies the intended outcome.
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: "flex", gap: 6, paddingTop: 4 }}>
              <button className="btn ghost" style={{ fontSize: 11 }} onClick={() => setForgePersona((current) => current === p.name ? null : p.name)}>{forgePersona === p.name ? "close forge" : "edit · ask forge"}</button>
              <button className="btn ghost" style={{ fontSize: 11, color: "var(--ember-08)" }} onClick={() => toggleScenarios(p.name)}>{expandedScenarios[p.name] ? "hide bdd scenarios" : "view bdd scenarios"}</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  </>
  );
};
