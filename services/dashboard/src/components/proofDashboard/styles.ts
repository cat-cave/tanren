// rv-23 — shared CSS for the runtime-verification proof dashboard surfaces.
// Mirrors the behavior-coverage screen tokens so the proof surfaces read as one
// system. The `.proof` prefix scopes every rule to this screen family.
export const PROOF_DASHBOARD_CSS = `
.proof { display: flex; flex-direction: column; gap: 14px; font-family: var(--font-ui); }
.proof .panel { border: 1px solid var(--line-1); border-radius: 10px; background: var(--bg-surface, var(--bg-canvas)); }
.proof .panel-pad { padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; }
.proof h2 { margin: 0; font-size: 15px; color: var(--fg-1); font-weight: 600; }
.proof .eyebrow { font-family: var(--font-mono); font-size: 9px; letter-spacing: .16em; text-transform: uppercase; font-weight: 700; color: var(--fg-3); }
.proof .sub { color: var(--fg-3); font-size: 12px; line-height: 1.5; }
.proof .links { display: flex; flex-wrap: wrap; gap: 8px; }
.proof .links a { text-decoration: none; border: 1px solid var(--line-1); border-radius: 999px; padding: 4px 10px; font: 700 9px var(--font-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--fg-2); }
.proof .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.proof .stat { border: 1px solid var(--line-1); border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; }
.proof .stat b { font-family: var(--font-mono); font-size: 22px; font-weight: 600; color: var(--fg-1); }
.proof .stat span { font-family: var(--font-mono); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: var(--fg-3); }
.proof .empty { padding: 20px 4px; color: var(--fg-3); font-size: 13px; line-height: 1.5; }
.proof .alert { border: 1px solid var(--ember-08, var(--line-2)); border-radius: 8px; padding: 11px 13px; color: var(--fg-2); font-size: 12px; line-height: 1.45; }
.proof .alert b { color: var(--ember-08, var(--fg-1)); }
.proof table { width: 100%; border-collapse: collapse; font-size: 12px; }
.proof th { padding: 8px; text-align: left; border-bottom: 1px solid var(--line-1); color: var(--fg-3); font-family: var(--font-mono); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; }
.proof td { padding: 10px 8px; border-bottom: 1px solid var(--line-1); vertical-align: top; color: var(--fg-2); }
.proof tr:last-child td { border-bottom: 0; }
.proof code { font-family: var(--font-mono); font-size: 10px; color: var(--fg-2); overflow-wrap: anywhere; }
.proof a.row-link { color: var(--fg-1); text-decoration: none; border-bottom: 1px dotted var(--line-2); }
.proof .pill { display: inline-block; border-radius: 999px; padding: 2px 8px; font: 700 9px var(--font-mono); letter-spacing: .06em; text-transform: uppercase; border: 1px solid var(--line-1); color: var(--fg-2); }
.proof .pill.pass { border-color: var(--jade-08, #2f8f5b); color: var(--jade-08, #2f8f5b); }
.proof .pill.fail { border-color: var(--ember-08, #c65239); color: var(--ember-08, #c65239); }
.proof .pill.unknown { border-color: var(--line-2); color: var(--fg-3); }
.proof .pill.warn { border-color: var(--amber-08, #b8862f); color: var(--amber-08, #b8862f); }
.proof .timeline { display: flex; flex-direction: column; gap: 0; }
.proof .tl-step { display: grid; grid-template-columns: 18px 1fr; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line-1); }
.proof .tl-step:last-child { border-bottom: 0; }
.proof .tl-dot { width: 9px; height: 9px; border-radius: 999px; margin-top: 4px; background: var(--line-2); }
.proof .tl-dot.pass { background: var(--jade-08, #2f8f5b); }
.proof .tl-dot.fail { background: var(--ember-08, #c65239); }
.proof .tl-label { font-family: var(--font-mono); font-size: 11px; color: var(--fg-1); }
.proof .tl-meta { font-family: var(--font-mono); font-size: 10px; color: var(--fg-3); }
`;
