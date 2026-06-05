/**
 * DORA panel screen-scoped CSS. Lives in the owned `components/dora`
 * subtree (NOT shell.css) and is emitted as a `<style data-screen="dora">`
 * block by the DORA body. Every color is a design token — no
 * hardcoded palette. Class names are namespaced under `.dora-screen` so they
 * never collide with shell chrome or the costs screen.
 */

export const DORA_SCREEN_CSS = `
.dora-screen {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-family: var(--font-ui);
}
.dora-screen .panel {
  border: 1px solid var(--line-1);
  border-radius: 10px;
  background: var(--bg-surface, var(--bg-canvas));
  display: flex;
  flex-direction: column;
}
.dora-screen .panel-pad { padding: 14px 18px; gap: 10px; display: flex; flex-direction: column; }
.dora-screen .mini-eyebrow {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  font-weight: 700;
  color: var(--fg-3);
}

/* The four-up metric grid */
.dora-screen .dora-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.dora-screen .dora-card {
  border: 1px solid var(--line-1);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.dora-screen .dora-card .label {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-weight: 700;
  color: var(--fg-3);
}
.dora-screen .dora-card .value {
  font-family: var(--font-mono);
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--fg-1);
  font-variant-numeric: tabular-nums;
}
.dora-screen .dora-card .value.empty { color: var(--fg-4); }
.dora-screen .dora-card .sub { font-family: var(--font-ui); font-size: 11px; color: var(--fg-3); line-height: 1.35; }
.dora-screen .dora-card .sample { font-family: var(--font-mono); font-size: 9.5px; color: var(--fg-4); }

/* The "reported, not targeted" footnote */
.dora-screen .note {
  font-family: var(--font-ui);
  font-size: 11.5px;
  color: var(--fg-2);
  line-height: 1.45;
  padding-top: 10px;
  border-top: 1px solid var(--line-1);
}
.dora-screen .note b { color: var(--ember-08); }
.dora-screen .window-tag { font-family: var(--font-mono); font-size: 10px; color: var(--fg-3); }
.dora-screen .empty {
  padding: 24px 18px;
  font-family: var(--font-ui);
  font-size: 13px;
  color: var(--fg-3);
}
`;
