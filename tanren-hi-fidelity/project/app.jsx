// app.jsx — top-level shell. Routing, surface theme, Tweaks, ⌘K.

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "surface": "ink",
  "projectMode": "chat",
  "showSubopt": true,
  "discoveryVariant": "feature",
  "auditGate": false,
  "mergeIntegration": "mergify"
}/*EDITMODE-END*/;

// Onboarding routes are shells of their own (no sidebar). All other routes
// land in the main app shell.
const ONBOARDING_ROUTES = ["onb-org", "onb-new", "onb-exist"];

const App = () => {
  const [t, setTweak] = window.useTweaks
    ? window.useTweaks(TWEAK_DEFAULTS)
    : [TWEAK_DEFAULTS, () => {}];

  const [view, setView] = React.useState("project");
  const [onbStep, setOnbStep] = React.useState(1);
  const [forgeOpen, setForgeOpen] = React.useState(false);

  React.useEffect(() => {
    document.documentElement.dataset.theme = t.surface === "ash" ? "light" : "dark";
  }, [t.surface]);

  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setForgeOpen(o => !o);
      }
      if (e.key === "Escape" && forgeOpen) setForgeOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [forgeOpen]);

  const onNav = (id, payload) => {
    // Reset step counter whenever we enter an onboarding flow
    if (ONBOARDING_ROUTES.includes(id)) {
      setOnbStep(1);
    }
    setView(id);
  };

  const onForgeAction = (action, payload) => {
    if (action === "nav") onNav(payload);
  };

  const isOnboarding = ONBOARDING_ROUTES.includes(view);

  const projectName = view === "project" ? null :
                      view === "run" || view === "review" ? "tanren-fixture-easy" :
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
        onForge={() => setForgeOpen(true)}
      />
      <SideNav active={view} onNav={onNav} />
      <main className="main">
        {view === "project" && (
          <ProjectView
            onNav={onNav}
            mode={t.projectMode}
            setMode={(m) => setTweak("projectMode", m)}
            showSubopt={t.showSubopt}
          />
        )}
        {view === "run" && <RunView onNav={onNav} showSubopt={t.showSubopt} />}
        {view === "review" && <ReviewView onNav={onNav} showSubopt={t.showSubopt} mergeIntegration={t.mergeIntegration} />}
        {view === "discovery" && <window.DiscoveryView onNav={onNav} variant={t.discoveryVariant} />}
        {view === "failure" && <window.FailureView onNav={onNav} />}
        {view === "settings" && <window.SettingsView onNav={onNav} auditGate={t.auditGate} />}
        {view === "costs" && <window.CostsView onNav={onNav} />}
        {view === "notifications" && <window.NotificationsView onNav={onNav} />}
        {view === "overview" && <window.OverviewView onNav={onNav} />}
        {view === "roadmap" && <window.RoadmapView onNav={onNav} />}
        {view === "personas" && <window.PersonasView onNav={onNav} />}
        {view === "dora" && <window.DoraView onNav={onNav} />}
      </main>

      <ForgePalette
        open={forgeOpen}
        onClose={() => setForgeOpen(false)}
        onAction={onForgeAction}
      />

      {renderTweaks(t, setTweak, view, setView, setOnbStep, setForgeOpen)}
    </div>
  );
};

// PlaceholderView used to live here; every nav target now has a real view.

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

      {view === "review" && (
        <window.TweakSection title="review · per-repo merge integration">
          <window.TweakSelect
            label="merge integration"
            value={t.mergeIntegration}
            options={[
              { label: "mergify queue (default)",   value: "mergify" },
              { label: "direct github merge",      value: "direct" },
              { label: "external reviewer handoff", value: "external" },
              { label: "no merge integration",     value: "none" },
            ]}
            onChange={(v) => setTweak("mergeIntegration", v)}
          />
        </window.TweakSection>
      )}

      {view === "settings" && (
        <window.TweakSection title="settings · audit gate">
          <window.TweakToggle
            label="audit gate (tanren-config repo)"
            value={t.auditGate}
            onChange={(v) => setTweak("auditGate", v)}
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

      <window.TweakSection title="navigate · all flows">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {[
            ["project", "→ project view", null],
            ["run", "→ run detail", null],
            ["review", "→ review handoff", null],
            ["discovery", "→ spec discovery", null],
            ["failure", "→ failure recovery", "danger"],
            ["settings", "→ settings · routing", null],
            ["costs", "→ history & costs", null],
            ["DIVIDER", "ORG SURFACES", null],
            ["overview", "→ overview", null],
            ["notifications", "→ notifications", null],
            ["roadmap", "→ roadmap", null],
            ["personas", "→ personas", null],
            ["dora", "→ DORA", null],
            ["DIVIDER", "ONBOARDING TRACKS", null],
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
