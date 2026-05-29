/**
 * P3-0017 config-surface CSS. Lives in the owned config subtree (NOT shell.css)
 * and is emitted as a `<style data-screen="config">` block by the config body.
 * Every color is a design token (P2A-0016) — no hardcoded palette. Class names
 * are namespaced under `.config-screen` so they never collide with the chrome.
 */

export const CONFIG_SCREEN_CSS = `
.config-screen { display: flex; flex-direction: column; gap: 14px; font-family: var(--font-ui); }
.config-screen .panel {
  border: 1px solid var(--line-1);
  border-radius: 10px;
  background: var(--bg-surface, var(--bg-canvas));
  display: flex;
  flex-direction: column;
}
.config-screen .panel-head {
  display: flex; align-items: baseline; gap: 10px;
  padding: 12px 16px; border-bottom: 1px solid var(--line-1);
}
.config-screen .panel-head h3 { margin: 0; font-size: 13px; font-weight: 600; color: var(--fg-1); }
.config-screen .panel-head h3 em { color: var(--ember-08); font-style: normal; }
.config-screen .panel-head .meta {
  margin-left: auto; font-family: var(--font-mono); font-size: 10px;
  letter-spacing: 0.08em; color: var(--fg-3);
}
.config-screen .panel-pad { padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
.config-screen .split-row { display: grid; grid-template-columns: 1.45fr 1fr; gap: 14px; }
.config-screen .scroll-col { display: flex; flex-direction: column; gap: 14px; }
.config-screen .spec-h { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; color: var(--fg-2); text-transform: uppercase; }

.config-screen .gate-card { display: flex; flex-direction: column; gap: 12px; padding: 16px 18px; }
.config-screen .gate-card .gate-eyebrow {
  font-family: var(--font-mono); font-size: 9.5px; color: var(--fg-3);
  letter-spacing: 0.22em; text-transform: uppercase; font-weight: 700;
}
.config-screen .gate-card .gate-blurb { font-size: 13px; color: var(--fg-1); line-height: 1.55; max-width: 640px; }
.config-screen .gate-card code, .config-screen .diff-ln code { font-family: var(--font-mono); color: var(--ember-08); }
.config-screen .gate-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.config-screen .forge-card { border: 1px solid var(--line-1); border-radius: 10px; overflow: hidden; }
.config-screen .forge-card .head {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; border-bottom: 1px solid var(--line-1);
}
.config-screen .forge-card .head .stamp { font-family: var(--font-jp); color: var(--ember-08); font-size: 16px; }
.config-screen .forge-card .head .title { font-size: 13px; color: var(--fg-1); }
.config-screen .forge-card .head .title em { color: var(--ember-08); font-style: normal; }
.config-screen .forge-card .head .meta { margin-left: auto; font-family: var(--font-mono); font-size: 10px; color: var(--fg-3); }
.config-screen .forge-card .body { padding: 14px 16px; font-size: 13px; color: var(--fg-1); line-height: 1.55; }

.config-screen .code-block { font-family: var(--font-mono); font-size: 12px; background: var(--bg-sunken); }
.config-screen .diff-ln { display: flex; gap: 8px; padding: 1px 12px; white-space: pre; color: var(--fg-2); }
.config-screen .diff-ln .gutter { width: 12px; color: var(--fg-4); user-select: none; }
.config-screen .diff-ln.ln-add { background: color-mix(in srgb, var(--status-ok) 14%, transparent); color: var(--fg-1); }
.config-screen .diff-ln.ln-rem { background: color-mix(in srgb, var(--status-fail) 14%, transparent); color: var(--fg-2); }
.config-screen .diff-ln.ln-comment { color: var(--fg-3); }

.config-screen .config-check { display: flex; gap: 8px; align-items: center; font-size: 12.5px; color: var(--fg-1); }
.config-screen .config-check .g { color: var(--status-ok); font-weight: 700; }
.config-screen .config-impact { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: baseline; font-size: 12px; }
.config-screen .config-impact .l { color: var(--fg-2); }
.config-screen .config-impact .v { color: var(--ember-08); font-family: var(--font-mono); }
.config-screen .config-impact .k { color: var(--fg-3); font-size: 11px; }

.config-screen .config-hist-row {
  display: grid; grid-template-columns: auto 1fr auto auto; gap: 10px; align-items: baseline;
  padding: 8px 16px; border-top: 1px solid var(--line-1); font-size: 12px;
}
.config-screen .config-hist-row .v { font-family: var(--font-mono); color: var(--ember-08); }
.config-screen .config-hist-row .t { color: var(--fg-1); }
.config-screen .config-hist-row .who { color: var(--fg-3); }
.config-screen .config-hist-row .when { color: var(--fg-4); font-size: 11px; }
.config-screen .config-hist-row .state { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em; color: var(--status-ok); text-transform: uppercase; }

.config-screen .readiness {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 12px 16px; border: 1px solid var(--line-1); border-radius: 10px;
  background: var(--bg-surface, var(--bg-canvas));
}
.config-screen .pill {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  padding: 4px 8px; border-radius: 6px; border: 1px solid var(--line-2);
}
.config-screen .pill .d { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.config-screen .pill.ok { color: var(--status-ok); }
.config-screen .pill.warn { color: var(--status-warn); }
.config-screen .readiness .note { color: var(--fg-3); font-size: 12px; }
.config-screen .readiness .grow { margin-left: auto; display: flex; gap: 8px; }

.config-screen .btn {
  font-family: var(--font-ui); font-size: 12.5px; padding: 7px 12px; border-radius: 7px;
  border: 1px solid var(--line-2); background: transparent; color: var(--fg-1); cursor: pointer;
  text-decoration: none; display: inline-flex; align-items: center; gap: 6px;
}
.config-screen .btn.primary { background: var(--ember-08); border-color: var(--ember-08); color: var(--bg-inverted); }
.config-screen .btn.ghost { border-color: transparent; color: var(--fg-3); }
.config-screen .btn.danger { color: var(--status-fail); border-color: color-mix(in srgb, var(--status-fail) 50%, transparent); }
.config-screen .btn[disabled] { opacity: 0.6; cursor: default; }
`;
