/**
 * Integrations two-plane screen-scoped CSS. Lives in the owned
 * `components/integrations` subtree (NOT shell.css) and is emitted as a
 * `<style data-screen="integrations">` block by the body. Every color is a
 * design token — no hardcoded palette. Class names are namespaced under
 * `.integrations-screen` so they never collide with shell chrome or sibling
 * panels (merge-queue / DORA).
 */

export const INTEGRATIONS_SCREEN_CSS = `
.integrations-screen {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-family: var(--font-ui);
}
.integrations-screen .panel {
  border: 1px solid var(--line-1);
  border-radius: 10px;
  background: var(--bg-surface, var(--bg-canvas));
  display: flex;
  flex-direction: column;
}
.integrations-screen .panel-pad { padding: 14px 18px; gap: 12px; display: flex; flex-direction: column; }
.integrations-screen .mini-eyebrow {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  font-weight: 700;
  color: var(--fg-3);
}
.integrations-screen .window-tag { font-family: var(--font-mono); font-size: 10px; color: var(--fg-3); }

.integrations-screen .int-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}
.integrations-screen .int-card {
  border: 1px solid var(--line-1);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.integrations-screen .int-card.linked { border-color: var(--ember-08); }
.integrations-screen .int-card .label {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-weight: 700;
  color: var(--fg-3);
}
.integrations-screen .int-card .value {
  font-family: var(--font-mono);
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--fg-1);
}
.integrations-screen .int-card .value.empty { color: var(--fg-4); }
.integrations-screen .int-card .sub { font-family: var(--font-ui); font-size: 11px; color: var(--fg-3); line-height: 1.35; }
.integrations-screen .int-card .ref {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--fg-4);
  word-break: break-all;
}

.integrations-screen .cap-row {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--line-1);
  border-radius: 8px;
  padding: 12px 14px;
}
.integrations-screen .cap-row .glyph {
  font-family: var(--font-mono);
  font-size: 14px;
  color: var(--ember-08);
  width: 20px;
  text-align: center;
}
.integrations-screen .cap-row .meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.integrations-screen .cap-row .name {
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 600;
  color: var(--fg-1);
}
.integrations-screen .cap-row .desc {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--fg-3);
}
.integrations-screen .cap-row .state {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 700;
}
.integrations-screen .cap-row .state.ready { color: var(--ember-08); }
.integrations-screen .cap-row .state.need-link { color: var(--fg-3); }
.integrations-screen .cap-row .state.unknown { color: var(--fg-4); }

.integrations-screen .btn {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  border: 1px solid var(--line-1);
  border-radius: 6px;
  background: var(--bg-canvas);
  color: var(--fg-1);
  padding: 7px 12px;
  cursor: pointer;
}
.integrations-screen .btn:hover { border-color: var(--ember-08); color: var(--ember-08); }
.integrations-screen .btn.primary {
  background: var(--ember-08);
  border-color: var(--ember-08);
  color: var(--bg-canvas);
}
.integrations-screen .btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.integrations-screen .link-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
  align-items: end;
}
.integrations-screen .field { display: flex; flex-direction: column; gap: 4px; }
.integrations-screen .field label {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-weight: 700;
  color: var(--fg-3);
}
.integrations-screen .field input,
.integrations-screen .field select {
  font-family: var(--font-mono);
  font-size: 12px;
  border: 1px solid var(--line-1);
  border-radius: 6px;
  background: var(--bg-canvas);
  color: var(--fg-1);
  padding: 8px 10px;
}
.integrations-screen .field input:focus,
.integrations-screen .field select:focus {
  outline: none;
  border-color: var(--ember-08);
}

.integrations-screen .note {
  font-family: var(--font-ui);
  font-size: 11.5px;
  color: var(--fg-2);
  line-height: 1.45;
  padding-top: 10px;
  border-top: 1px solid var(--line-1);
}
.integrations-screen .note b { color: var(--ember-08); }
.integrations-screen .empty {
  padding: 18px 4px;
  font-family: var(--font-ui);
  font-size: 13px;
  color: var(--fg-3);
}
.integrations-screen .notice {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ember-08);
  padding: 10px 12px;
  border: 1px solid var(--line-1);
  border-radius: 8px;
  background: var(--bg-canvas);
}
.integrations-screen .notice.warn { color: var(--fg-2); }
`;
