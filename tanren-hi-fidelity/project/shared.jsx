// shared.jsx — chrome and reusable primitives.

// =====================================================================
// TOP BAR
// =====================================================================
const TopBar = ({ org, project, surface, setSurface, onForge }) => (
  <header className="topbar">
    <div className="brand">
      <span className="dot"></span>
      tanren
    </div>
    <button className="org-pill" title="switch organization">
      <span className="glyph">鍛</span>
      {org}
      <span style={{ color: "var(--fg-3)", marginLeft: 2 }}>▾</span>
    </button>
    {project && (
      <>
        <span className="crumb-sep">/</span>
        <span className="proj-crumb">
          <span className="dot"></span>{project}
        </span>
      </>
    )}
    <div className="right">
      <div className="surface-toggle">
        <button
          className={surface === "ink" ? "active" : ""}
          onClick={() => setSurface("ink")}
        >ink</button>
        <button
          className={surface === "ash" ? "active" : ""}
          onClick={() => setSurface("ash")}
        >ash</button>
      </div>
      <button className="forge-key" onClick={onForge}>
        <span className="stamp">鍛</span>
        ask forge
        <span className="kbd">⌘K</span>
      </button>
      <button className="icon-btn" title="notifications">
        ✉<span className="badge">3</span>
      </button>
      <div className="avatar" title="tw@cat-cave.dev">TW</div>
    </div>
  </header>
);

// =====================================================================
// SIDE NAV
// =====================================================================
const SideNav = ({ active, onNav }) => {
  const org = [
    { id: "overview", glyph: "▤", label: "overview" },
    { id: "roadmap",  glyph: "⌥", label: "roadmap" },
    { id: "personas", glyph: "◍", label: "personas" },
    { id: "costs",    glyph: "$", label: "history & costs" },
    { id: "dora",     glyph: "↗", label: "DORA" },
  ];
  const proj = [
    { id: "project",  glyph: "◇", label: "tanren-fixture-easy", count: 2, countWarn: false },
    { id: "discovery", glyph: "+", label: "discover spec" },
    { id: "failure",   glyph: "×", label: "halted runs", count: 1, countWarn: true },
  ];
  const setup = [
    { id: "settings",      glyph: "⚙", label: "routing & limits" },
    { id: "notifications", glyph: "✉", label: "notifications" },
  ];
  const onboard = [
    { id: "onb-org",   glyph: "鍛", label: "org setup", kanji: true },
    { id: "onb-new",   glyph: "+", label: "new project" },
    { id: "onb-exist", glyph: "↗", label: "existing project" },
  ];
  const renderRow = (it) => (
    <a
      key={it.id}
      className={active === it.id || (it.id === "project" && (active === "run" || active === "review")) ? "active" : ""}
      onClick={() => !it.soon && onNav?.(it.id)}
      style={it.soon ? { opacity: 0.5, cursor: "default" } : null}
    >
      <span className={"glyph" + (it.kanji ? " kanji" : "")} style={it.kanji ? { fontFamily: "var(--font-jp)", fontSize: 13, color: "var(--ember-08)" } : null}>{it.glyph}</span>
      {it.label}
      {it.count != null && <span className={"count" + (it.countWarn ? " warn" : "")}>{it.countWarn ? "× " : "↻ "}{it.count}</span>}
      {it.soon && <span className="soon">SOON</span>}
    </a>
  );
  return (
    <nav className="sidenav">
      <div className="group-label">▮ org</div>
      {org.map(renderRow)}
      <div className="group-label" style={{ marginTop: 8 }}>▮ projects</div>
      {proj.map(renderRow)}
      <div className="group-label" style={{ marginTop: 8 }}>▮ set up</div>
      {setup.map(renderRow)}
      <div className="group-label" style={{ marginTop: 8 }}>▮ onboarding</div>
      {onboard.map(renderRow)}
    </nav>
  );
};

// =====================================================================
// KPI STRIP
// =====================================================================
const KpiStrip = ({ items }) => (
  <div className="kpi-strip">
    {items.map((s, i) => (
      <div key={i} className={"kpi" + (s.hot ? " hot" : s.ok ? " ok" : "")}>
        <div className="l">{s.l}</div>
        <div className="v">{s.v}</div>
        <div className="k">{s.k}</div>
      </div>
    ))}
  </div>
);

// =====================================================================
// FORGE PALETTE (⌘K modal)
// =====================================================================
const ForgePalette = ({ open, onClose, onAction }) => {
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef();

  React.useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setQuery(""); setActive(0);
    }
  }, [open]);

  if (!open) return null;

  const flat = FORGE_PALETTE.flatMap(g => g.items.map(it => ({ ...it, group: g.group })));
  const filtered = query
    ? flat.filter(it => it.title.toLowerCase().includes(query.toLowerCase()) || it.desc.toLowerCase().includes(query.toLowerCase()))
    : null;
  const items = filtered || flat;

  const onKey = (e) => {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(items.length - 1, a + 1)); }
    if (e.key === "ArrowUp")   { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
    if (e.key === "Enter") {
      e.preventDefault();
      const it = items[active];
      if (it?.route) { onAction?.("nav", it.route); onClose(); }
      else onClose();
    }
  };

  const groupsToShow = filtered
    ? [{ group: "results", items: filtered }]
    : FORGE_PALETTE;

  let idx = 0;

  return (
    <div className="forge-backdrop" onClick={onClose}>
      <div className="forge-modal" onClick={e => e.stopPropagation()}>
        <div className="input-row">
          <span className="stamp">鍛</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onKey}
            placeholder="ask, command, or describe…"
          />
          <span className="esc">esc</span>
        </div>
        <div className="results">
          {groupsToShow.map((g, gi) => (
            <React.Fragment key={gi}>
              <div className="group">▮ {g.group}</div>
              {g.items.map((it) => {
                const myIdx = idx++;
                const isActive = myIdx === active;
                return (
                  <div
                    key={myIdx}
                    className={"item" + (isActive ? " active" : "")}
                    onMouseEnter={() => setActive(myIdx)}
                    onClick={() => {
                      if (it.route) { onAction?.("nav", it.route); onClose(); }
                      else onClose();
                    }}
                  >
                    <div className={"glyph" + (it.kanji ? " kanji" : "")}>{it.glyph}</div>
                    <div>
                      <div className="t">{it.title}</div>
                      <div className="d">{it.desc}</div>
                    </div>
                    <div className="k">↵</div>
                  </div>
                );
              })}
            </React.Fragment>
          ))}
          {items.length === 0 && (
            <div style={{ padding: "20px 18px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>
              No matches. Press ↵ to ask forge anyway.
            </div>
          )}
        </div>
        <div className="footer">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
          <span style={{ marginLeft: "auto", color: "var(--ember-08)" }}>forge palette · ⌘K</span>
        </div>
      </div>
    </div>
  );
};

// =====================================================================
// PAGE HEAD
// =====================================================================
const PageHead = ({ eyebrow, title, sub, actions }) => (
  <div className="page-head">
    <div>
      <div className="eyebrow">{eyebrow}</div>
      <div className="page-title">{title}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
    {actions && <div className="head-actions">{actions}</div>}
  </div>
);

// =====================================================================
// FORGE TURN (chat bubble row)
// =====================================================================
const ForgeTurn = ({ children }) => (
  <div className="forge-turn">
    <div className="avatar f">鍛</div>
    <div className="bubble">{children}</div>
  </div>
);
const UserTurn = ({ children, who = "TW" }) => (
  <div className="forge-turn user">
    <div className="bubble">{children}</div>
    <div className="avatar u">{who}</div>
  </div>
);

// =====================================================================
// SUBOPTIMAL CALLOUT
// =====================================================================
const Subopt = ({ data, onAction }) => (
  <div className="subopt">
    <div className="lbl"><span className="symbol">{data.symbol}</span> {data.lbl}</div>
    <div className="t">{data.title}</div>
    <div className="body">{data.body}</div>
    <div className="actions">
      {data.actions.map((a, i) => (
        <button
          key={i}
          className={"btn" + (a.primary ? " primary notched" : "") + (a.ghost ? " ghost" : "")}
          onClick={() => onAction?.(a.label)}
        >{a.label}</button>
      ))}
    </div>
  </div>
);

// =====================================================================
// EXPORT TO WINDOW
// =====================================================================
Object.assign(window, {
  TopBar, SideNav, KpiStrip, ForgePalette, PageHead, ForgeTurn, UserTurn, Subopt,
});
