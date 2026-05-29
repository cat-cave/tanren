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
    { id: "inbox",     glyph: "▤", label: "candidate inbox", count: 11, countWarn: false },
    { id: "failure",   glyph: "×", label: "halted runs", count: 1, countWarn: true },
  ];
  const system = [
    { id: "audits",        glyph: "⟳", label: "scheduled audits" },
    { id: "settings",      glyph: "⚙", label: "routing & limits" },
    { id: "config",        glyph: "⊟", label: "tanren-config" },
    { id: "notifications", glyph: "✉", label: "notifications" },
  ];
  const renderRow = (it) => (
    <a
      key={it.id}
      className={active === it.id || (it.id === "project" && (active === "run" || active === "review" || active === "spec")) ? "active" : ""}
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
      <div className="group-label" style={{ marginTop: 8 }}>▮ system</div>
      {system.map(renderRow)}
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
// Forge · unified ⌘K palette that MORPHS into a chat thread.
//   palette mode — search / command / navigate (grouped suggestions)
//   chat mode    — a real thread: forge answers, chips to follow up, and
//                  action cards that auto-navigate mid-conversation.
// Navigation items route immediately; ask/free-text items morph to chat.
const ForgePalette = ({ open, onClose, onAction, seed, onSeedConsumed }) => {
  const [mode, setMode] = React.useState("palette");
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const [messages, setMessages] = React.useState([]);
  const inputRef = React.useRef();
  const msgsRef = React.useRef();

  React.useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 60);
      setQuery(""); setActive(0);
      if (seed && FORGE_ANSWERS[seed]) {
        const a = FORGE_ANSWERS[seed];
        setMode("chat");
        setMessages([{ who: "user", text: a.q || "tell me about this" }, { who: "forge", ...a }]);
        onSeedConsumed?.();
      } else {
        setMode("palette"); setMessages([]);
      }
    }
  }, [open]);

  React.useEffect(() => {
    if (msgsRef.current) msgsRef.current.scrollTop = msgsRef.current.scrollHeight;
  }, [messages]);

  if (!open) return null;

  const flat = FORGE_PALETTE.flatMap(g => g.items.map(it => ({ ...it, group: g.group })));
  const filtered = query
    ? flat.filter(it => it.title.toLowerCase().includes(query.toLowerCase()) || it.desc.toLowerCase().includes(query.toLowerCase()))
    : null;
  const items = filtered || flat;

  // Append a user turn + forge's answer (keyed canned answer, or generic).
  const askForge = (text, key) => {
    const answer = (key && FORGE_ANSWERS[key]) || FORGE_ANSWERS.generic;
    setMode("chat");
    setMessages(m => [...m, { who: "user", text }, { who: "forge", ...answer }]);
    setQuery("");
  };

  const exec = (it) => {
    if (it.route) { onAction?.("nav", it.route); onClose(); return; }
    if (it.ask)   { askForge(it.title, it.ask); return; }
    onClose();
  };

  const onKey = (e) => {
    if (e.key === "Escape") { onClose(); return; }
    if (mode === "chat") {
      if (e.key === "Enter" && query.trim()) { e.preventDefault(); askForge(query.trim(), "generic"); }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(items.length - 1, a + 1)); }
    if (e.key === "ArrowUp")   { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
    if (e.key === "Enter") {
      e.preventDefault();
      if (items[active]) exec(items[active]);
      else if (query.trim()) askForge(query.trim(), "generic");
    }
  };

  const groupsToShow = filtered ? [{ group: "results", items: filtered }] : FORGE_PALETTE;
  let idx = 0;

  return (
    <div className="forge-backdrop" onClick={onClose}>
      <div className={"forge-modal" + (mode === "chat" ? " chat-mode" : "")} onClick={e => e.stopPropagation()}>
        <div className="input-row">
          <span className="stamp">鍛</span>
          {mode === "chat" && (
            <button className="fc-back" onClick={() => { setMode("palette"); setMessages([]); setQuery(""); }} title="back to commands">←</button>
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onKey}
            placeholder={mode === "chat" ? "follow up · ↵ to send" : "ask, command, or describe…"}
          />
          <span className="esc">esc</span>
        </div>

        {mode === "palette" && (
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
                      onClick={() => exec(it)}
                    >
                      <div className={"glyph" + (it.kanji ? " kanji" : "")}>{it.glyph}</div>
                      <div>
                        <div className="t">{it.title}</div>
                        <div className="d">{it.desc}</div>
                      </div>
                      <div className="k">{it.ask ? "ask ↵" : "↵"}</div>
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
            {items.length === 0 && (
              <div className="forge-empty">
                No command matches “{query}”. Press ↵ to ask forge in chat.
              </div>
            )}
          </div>
        )}

        {mode === "chat" && (
          <div className="forge-chat" ref={msgsRef}>
            {messages.map((m, i) => (
              <div key={i} className={"fc-msg " + m.who}>
                <div className="who">{m.who === "user" ? "TW" : "鍛"}</div>
                <div className="fc-col">
                  <div className="fc-bubble" dangerouslySetInnerHTML={{ __html: m.text }} />
                  {m.card && (
                    <div className="fc-card" onClick={() => { onAction?.("nav", m.card.route, m.card.payload); onClose(); }}>
                      <div className="lbl">▸ {m.card.lbl}</div>
                      <div className="t">{m.card.title}</div>
                      <div className="go">↗</div>
                    </div>
                  )}
                  {m.chips && (
                    <div className="fc-chips">
                      {m.chips.map((c, j) => (
                        <span key={j} className="chip" onClick={() => askForge(c, "generic")}><span className="pre">↑</span> {c}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="footer">
          {mode === "chat" ? (
            <>
              <span>↵ send</span>
              <span>← commands</span>
              <span>esc close</span>
              <span style={{ marginLeft: "auto", color: "var(--ember-08)" }}>forge · chat</span>
            </>
          ) : (
            <>
              <span>↑↓ navigate</span>
              <span>↵ select</span>
              <span>esc close</span>
              <span style={{ marginLeft: "auto", color: "var(--ember-08)" }}>forge · ⌘K</span>
            </>
          )}
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
