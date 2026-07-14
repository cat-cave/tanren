// app.jsx — top-level shell. Routing, surface theme, Tweaks, ⌘K Forge.

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "surface": "ink",
  "projectMode": "chat",
  "showSubopt": true,
  "discoveryVariant": "feature",
  "auditGate": true,
  "mergeIntegration": "native"
}/*EDITMODE-END*/;

// Onboarding routes are designer-convenience shells (no sidebar). In a real
// product, onboarding is a once-per-org first-run flow, not standing nav —
// so it's reachable only from the Tweaks "all flows" panel and the Overview
// "+ new project" / "+ link existing" buttons, never the product sidebar.
const ONBOARDING_ROUTES = ["onb-org", "onb-new", "onb-exist"];

const App = () => {
  const [t, setTweak] = window.useTweaks
    ? window.useTweaks(TWEAK_DEFAULTS)
    : [TWEAK_DEFAULTS, () => {}];

  const [view, setView] = React.useState("project");
  const [onbStep, setOnbStep] = React.useState(1);
  const [forgeOpen, setForgeOpen] = React.useState(false);
  const [forgeSeed, setForgeSeed] = React.useState(null);
  const [forgeSession, setForgeSession] = React.useState(0);

  // Spec surface: a node click opens the minimal drawer; "open full page"
  // escalates to the SpecView route. Both read the same node.
  const [specNode, setSpecNode] = React.useState(null);
  const [specDrawerOpen, setSpecDrawerOpen] = React.useState(false);

  React.useEffect(() => {
    document.documentElement.dataset.theme = t.surface === "ash" ? "light" : "dark";
  }, [t.surface]);

  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setForgeSeed(null);
        setForgeOpen(o => !o);
      }
      if (e.key === "Escape") {
        if (specDrawerOpen) { setSpecDrawerOpen(false); return; }
        if (forgeOpen) setForgeOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [forgeOpen, specDrawerOpen]);

  const onNav = (id, payload) => {
    if (ONBOARDING_ROUTES.includes(id)) setOnbStep(1);
    if (id === "spec") {
      const node = typeof payload === "string"
        ? { t: payload, s: (window.SPECS[payload] && window.SPECS[payload].status) || "queued" }
        : (payload || specNode);
      setSpecNode(node);
      setSpecDrawerOpen(false);
    }
    setView(id);
  };

  // Open the minimal drawer over the current view (from a DAG node click).
  const openSpec = (node) => { setSpecNode(node); setSpecDrawerOpen(true); };

  // Open Forge straight into a chat answer (from "ask forge" affordances).
  const onAsk = (key) => {
    setForgeSeed(key);
    setForgeSession(session => session + 1);
    setForgeOpen(true);
  };

  const onForgeAction = (action, route, payload) => {
    if (action === "nav") onNav(route, payload);
  };

  const isOnboarding = ONBOARDING_ROUTES.includes(view);

  const projectName = view === "project" ? null :
                      view === "run" || view === "review" || view === "spec" ? "tanren-fixture-easy" :
                      view === "discovery" ? "tanren-fixture-easy · + discover" :
                      view === "failure" ? "tanren-fixture-easy · halted run" :
                      null;

  // Onboarding flows render their own full-shell view.
  if (isOnboarding) {
    return (
      <>
        {view === "onb-org" && <window.OrgSetupView step={onbStep} setStep={setOnbStep} onNav={onNav} />}
        {view === "onb-new" && <window.NewProjectView step={onbStep} setStep={setOnbStep} onNav={onNav} />}
        {view === "onb-exist" && <window.ExistingProjectView step={onbStep} setStep={setOnbStep} onNav={onNav} />}

        <ForgePalette
          open={forgeOpen}
          onClose={() => setForgeOpen(false)}
          onAction={onForgeAction}
          seed={forgeSeed}
          onSeedConsumed={() => setForgeSeed(null)}
        />

        {renderTweaks(t, setTweak, view, setView, setOnbStep, setForgeOpen)}
      </>
    );
  }

  return (
    <div className="app">
      <TopBar
        org="cat-cave"
        project={projectName}
        surface={t.surface}
        setSurface={(v) => setTweak("surface", v)}
        onForge={() => { setForgeSeed(null); setForgeOpen(true); }}
      />
      <SideNav active={view} onNav={onNav} />
      <main className="main">
        {view === "project" && (
          <ProjectView
            onNav={onNav}
            onOpenSpec={openSpec}
            mode={t.projectMode}
            setMode={(m) => setTweak("projectMode", m)}
            showSubopt={t.showSubopt}
          />
        )}
        {view === "spec" && <window.SpecView node={specNode} onNav={onNav} onAsk={onAsk} />}
        {view === "run" && <RunView onNav={onNav} showSubopt={t.showSubopt} />}
        {view === "review" && <ReviewView onNav={onNav} showSubopt={t.showSubopt} mergeIntegration={t.mergeIntegration} />}
        {view === "discovery" && <window.DiscoveryView onNav={onNav} variant={t.discoveryVariant} />}
        {view === "failure" && <window.FailureView onNav={onNav} />}
        {view === "inbox" && <window.InboxView onNav={onNav} />}
        {view === "audits" && <window.AuditsView onNav={onNav} />}
        {view === "config" && <window.ConfigView onNav={onNav} auditGate={t.auditGate} setAuditGate={(v) => setTweak("auditGate", v)} />}
        {view === "settings" && <window.SettingsView onNav={onNav} auditGate={t.auditGate} />}
        {view === "costs" && <window.CostsView onNav={onNav} />}
        {view === "notifications" && <window.NotificationsView onNav={onNav} />}
        {view === "overview" && <window.OverviewView onNav={onNav} onAsk={onAsk} />}
        {view === "roadmap" && <window.RoadmapView onNav={onNav} />}
        {view === "personas" && <window.PersonasView onNav={onNav} />}
        {view === "dora" && <window.DoraView onNav={onNav} />}
      </main>

      {specDrawerOpen && (
        <window.SpecDrawer
          node={specNode}
          onClose={() => setSpecDrawerOpen(false)}
          onOpenSpec={(n) => setSpecNode(n)}
          onNav={(id) => { setSpecDrawerOpen(false); onNav(id); }}
          onAsk={(k) => { setSpecDrawerOpen(false); onAsk(k); }}
          onFullPage={(n) => { setSpecDrawerOpen(false); setSpecNode(n); setView("spec"); }}
        />
      )}

      <ForgePalette
        key={forgeSession}
        open={forgeOpen}
        onClose={() => setForgeOpen(false)}
        onAction={onForgeAction}
        seed={forgeSeed}
        onSeedConsumed={() => setForgeSeed(null)}
      />

      {renderTweaks(t, setTweak, view, setView, setOnbStep, setForgeOpen)}
    </div>
  );
};

const renderTweaks = (t, setTweak, view, setView, setOnbStep, setForgeOpen) => {
  if (!window.TweaksPanel) return null;
  return (
    <window.TweaksPanel title="Tweaks">
      <window.TweakSection title="surface">
        <window.TweakRadio
          label="theme"
          value={t.surface}
          options={[
            { label: "ink (dark)", value: "ink" },
            { label: "ash (light)", value: "ash" },
          ]}
          onChange={(v) => setTweak("surface", v)}
        />
      </window.TweakSection>

      <window.TweakSection title="project view">
        <window.TweakRadio
          label="forge prominence"
          value={t.projectMode}
          options={[
            { label: "chat-primary", value: "chat" },
            { label: "dag-primary", value: "dag" },
          ]}
          onChange={(v) => setTweak("projectMode", v)}
        />
      </window.TweakSection>

      <window.TweakSection title="workflow quality">
        <window.TweakToggle
          label="show suboptimal callouts"
          value={t.showSubopt}
          onChange={(v) => setTweak("showSubopt", v)}
        />
      </window.TweakSection>

      <window.TweakSection title="config · audit gate">
        <window.TweakToggle
          label="route config edits through a pr"
          value={t.auditGate}
          onChange={(v) => setTweak("auditGate", v)}
        />
      </window.TweakSection>

      {view === "review" && (
        <window.TweakSection title="review · per-repo merge integration">
          <window.TweakSelect
            label="merge integration"
            value={t.mergeIntegration}
            options={[
              { label: "native queue (default)",   value: "native" },
              { label: "direct github merge",      value: "direct" },
              { label: "external reviewer handoff", value: "external" },
              { label: "no merge integration",     value: "none" },
            ]}
            onChange={(v) => setTweak("mergeIntegration", v)}
          />
        </window.TweakSection>
      )}

      {view === "discovery" && (
        <window.TweakSection title="discovery scenario">
          <window.TweakSelect
            label="insight type"
            value={t.discoveryVariant}
            options={[
              { label: "feature · csv export (small)", value: "feature" },
              { label: "bug · flaky logins (P0 triage)", value: "bug" },
              { label: "strategic · tiktok ads (large)", value: "strategic" },
            ]}
            onChange={(v) => setTweak("discoveryVariant", v)}
          />
        </window.TweakSection>
      )}

      <window.TweakSection title="navigate · product surfaces">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {[
            ["project", "→ project · dag", null],
            ["spec", "→ spec detail", null],
            ["run", "→ run detail", null],
            ["review", "→ review handoff", null],
            ["discovery", "→ spec discovery", null],
            ["inbox", "→ candidate inbox", null],
            ["audits", "→ scheduled audits", null],
            ["config", "→ tanren-config", null],
            ["failure", "→ failure recovery", "danger"],
            ["settings", "→ routing & limits", null],
            ["costs", "→ history & costs", null],
            ["DIVIDER", "ORG SURFACES", null],
            ["overview", "→ overview", null],
            ["notifications", "→ notifications", null],
            ["roadmap", "→ roadmap", null],
            ["personas", "→ personas", null],
            ["dora", "→ DORA", null],
            ["DIVIDER", "ONBOARDING · designer-only (not in product nav)", null],
            ["onb-org", "→ org setup (4 steps)", "ember"],
            ["onb-new", "→ new project (3 steps)", "ember"],
            ["onb-exist", "→ existing project (5 steps)", "ember"],
          ].map(([id, label, kind], i) => {
            if (id === "DIVIDER") {
              return (
                <div key={i} style={{ marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700 }}>
                  {label}
                </div>
              );
            }
            return (
              <button
                key={id}
                className="btn"
                onClick={() => {
                  if (id.startsWith("onb-")) setOnbStep(1);
                  setView(id);
                }}
                style={{
                  justifyContent: "flex-start",
                  ...(kind === "danger" ? { color: "var(--status-fail)" } : {}),
                  ...(kind === "ember" ? { color: "var(--ember-08)", borderColor: "oklch(68% 0.22 40 / 0.3)" } : {}),
                }}
              >
                {label}
              </button>
            );
          })}
          <button
            className="btn"
            onClick={() => setForgeOpen(true)}
            style={{ justifyContent: "flex-start", color: "var(--ember-08)", borderColor: "var(--ember-08)", marginTop: 6 }}
          >
            <span style={{ fontFamily: "var(--font-jp)", fontSize: 13 }}>鍛</span> open forge ⌘K
          </button>
        </div>
      </window.TweakSection>
    </window.TweaksPanel>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
