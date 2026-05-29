/**
 * P3-0022 candidate-inbox styles. Layered ON TOP of the shared `p2b` / project
 * screen scaffolding (the inbox body renders `ScreenStyles` for the shared
 * classes, then this for the inbox-only bits). Everything keys off the P2A-0016
 * design tokens — no hardcoded colours — matching the hi-fi `view-inbox` look
 * without importing the prototype JSX/CSS.
 */

export const INBOX_CSS = `
.p2b .inbox-split { display:grid; grid-template-columns:260px 1fr; gap:14px; align-items:start; }
@media (max-width: 1040px) { .p2b .inbox-split { grid-template-columns:1fr; } }

.p2b .source-list { display:flex; flex-direction:column; gap:8px; }
.p2b .source-row { display:flex; gap:10px; align-items:flex-start; padding:10px 11px; border:1px solid var(--line-1); border-radius:var(--r-1); background:var(--bg-sunken); }
.p2b .source-row.on { border-left:2px solid var(--ember-08); }
.p2b .source-row .sg { font-family:var(--font-jp); font-size:16px; color:var(--ember-08); line-height:1.2; }
.p2b .source-row .smid { flex:1; min-width:0; }
.p2b .source-row .sn { font-family:var(--font-display); font-weight:600; font-size:12.5px; color:var(--fg-1); display:flex; gap:6px; align-items:center; }
.p2b .source-row .sd { font-family:var(--font-mono); font-size:10px; color:var(--fg-3); line-height:1.5; margin-top:2px; }
.p2b .source-row .auto-tag { font-family:var(--font-mono); font-size:8px; letter-spacing:0.12em; text-transform:uppercase; color:var(--ember-08); border:1px solid var(--ember-08); border-radius:var(--r-1); padding:1px 4px; }
.p2b .source-row .toggle { font-family:var(--font-mono); font-size:9px; color:var(--fg-3); }
.p2b .source-row .toggle.on { color:var(--ember-08); }
.p2b .source-note { margin-top:6px; padding:10px 12px; background:var(--bg-sunken); border:1px solid var(--line-1); border-left:2px solid var(--ember-08); border-radius:var(--r-2); }
.p2b .source-note .nlabel { font-family:var(--font-mono); font-size:9px; color:var(--ember-08); letter-spacing:0.18em; text-transform:uppercase; font-weight:700; margin-bottom:4px; }
.p2b .source-note .nbody { font-family:var(--font-ui); font-size:11.5px; color:var(--fg-2); line-height:1.45; }

.p2b .candidate-stream { display:flex; flex-direction:column; gap:10px; }
.p2b .candidate { border:1px solid var(--line-1); border-left:2px solid var(--line-2); border-radius:var(--r-1); background:var(--bg-surface); padding:12px 14px; }
.p2b .candidate.v-auto { border-left-color:var(--ember-08); }
.p2b .candidate.v-decide { border-left-color:var(--status-warn,oklch(70% 0.16 75)); }
.p2b .candidate.v-dupe { border-left-color:var(--fg-3); }
.p2b .candidate.resolved { opacity:0.62; }
.p2b .candidate .cand-head { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; }
.p2b .candidate .cand-src { font-family:var(--font-mono); font-size:10.5px; color:var(--fg-2); }
.p2b .candidate .cand-src.sev-fail { color:var(--status-fail,oklch(58% 0.2 25)); }
.p2b .candidate .cand-src.sev-warn { color:var(--status-warn,oklch(70% 0.16 75)); }
.p2b .candidate .cand-proj { font-family:var(--font-mono); font-size:10px; color:var(--fg-3); }
.p2b .candidate .cand-verdict { margin-left:auto; font-family:var(--font-mono); font-size:9px; letter-spacing:0.12em; text-transform:uppercase; font-weight:700; }
.p2b .candidate .cand-verdict.auto { color:var(--ember-08); }
.p2b .candidate .cand-verdict.decide { color:var(--status-warn,oklch(70% 0.16 75)); }
.p2b .candidate .cand-verdict.dupe { color:var(--fg-3); }
.p2b .candidate .cand-title { font-family:var(--font-display); font-weight:700; font-size:14px; color:var(--fg-1); margin-top:6px; }
.p2b .candidate .cand-body { font-family:var(--font-ui); font-size:12.5px; color:var(--fg-2); line-height:1.5; margin-top:4px; }

.p2b .triage { margin-top:10px; border:1px solid var(--line-1); border-radius:var(--r-1); background:var(--bg-sunken); padding:8px 11px; }
.p2b .triage .trow { display:flex; gap:10px; font-family:var(--font-mono); font-size:11px; padding:2px 0; }
.p2b .triage .tk { color:var(--fg-3); min-width:72px; letter-spacing:0.08em; text-transform:uppercase; font-size:9px; padding-top:2px; }
.p2b .triage .tv { color:var(--fg-2); flex:1; }
.p2b .triage .tv.accent { color:var(--ember-08); }

.p2b .cand-actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:10px; }
.p2b .cand-actions .auto-note, .p2b .cand-actions .resolved-note { font-family:var(--font-mono); font-size:11px; color:var(--ember-08); }
`;

export function InboxStyles() {
  return <style dangerouslySetInnerHTML={{ __html: INBOX_CSS }} />;
}
