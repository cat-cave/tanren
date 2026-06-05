/**
 * scheduled-audits styles. Layered ON TOP of the shared `p2b` screen
 * scaffolding (the audits body renders `ScreenStyles` for the shared classes,
 * then this for the audits-only bits). Everything keys off the design
 * tokens — no hardcoded colours — matching the hi-fi `view-audits` look without
 * importing the prototype JSX/CSS.
 */

export const AUDITS_CSS = `
.p2b .why-audits { display:flex; gap:18px; align-items:center; flex-wrap:wrap; padding:14px 18px; border:1px solid var(--line-1); border-left:2px solid var(--ember-08); border-radius:var(--r-2); background:var(--bg-sunken); }
.p2b .why-audits .wtext { flex:1; min-width:260px; }
.p2b .why-audits .wlabel { font-family:var(--font-mono); font-size:9.5px; color:var(--ember-08); letter-spacing:0.22em; text-transform:uppercase; font-weight:700; margin-bottom:4px; }
.p2b .why-audits .wbody { font-family:var(--font-ui); font-size:13px; color:var(--fg-1); line-height:1.55; }
.p2b .why-audits .wbody b.bad { color:var(--status-fail,oklch(58% 0.2 25)); }

.p2b .window-fill { display:flex; gap:10px; align-items:flex-end; }
.p2b .wf-col { display:flex; flex-direction:column; align-items:center; gap:4px; }
.p2b .wf-track { width:26px; height:64px; background:var(--bg-surface); border:1px solid var(--line-1); border-radius:var(--r-1); display:flex; align-items:flex-end; overflow:hidden; }
.p2b .wf-bar { width:100%; border-radius:0 0 var(--r-1) var(--r-1); }
.p2b .wf-bar.lo { background:var(--status-fail,oklch(58% 0.2 25)); }
.p2b .wf-bar.mid { background:var(--status-warn,oklch(70% 0.16 75)); }
.p2b .wf-bar.hi { background:var(--status-ok,oklch(70% 0.15 150)); }
.p2b .wf-pct { font-family:var(--font-mono); font-size:9.5px; color:var(--fg-2); }
.p2b .wf-l { font-family:var(--font-mono); font-size:8.5px; color:var(--fg-3); letter-spacing:0.06em; text-transform:uppercase; }

.p2b .audit-jobs { display:flex; flex-direction:column; }
.p2b .audit-row { display:grid; grid-template-columns:28px 1.4fr 1fr 1.2fr 0.9fr auto; gap:12px; align-items:center; padding:12px 14px; border-bottom:1px solid var(--line-1); }
.p2b .audit-row:last-child { border-bottom:none; }
.p2b .audit-row.paused { opacity:0.55; }
.p2b .audit-row .ak { font-family:var(--font-jp); font-size:17px; color:var(--ember-08); }
.p2b .audit-row .anames .an { font-family:var(--font-display); font-weight:700; font-size:13px; color:var(--fg-1); }
.p2b .audit-row .anames .acli { font-family:var(--font-mono); font-size:10px; color:var(--fg-3); margin-top:2px; }
.p2b .audit-row .asched .t { font-family:var(--font-mono); font-size:11px; color:var(--fg-2); }
.p2b .audit-row .asched .w { font-family:var(--font-mono); font-size:9.5px; color:var(--fg-3); margin-top:2px; }
.p2b .audit-row .afind { cursor:default; }
.p2b .afind.has-finds { cursor:pointer; }
.p2b .audit-row .afind .n { font-family:var(--font-mono); font-size:11.5px; color:var(--fg-2); }
.p2b .afind.sev-warn .n { color:var(--status-warn,oklch(70% 0.16 75)); }
.p2b .afind.sev-fail .n { color:var(--status-fail,oklch(58% 0.2 25)); }
.p2b .afind.sev-ok .n { color:var(--status-ok,oklch(70% 0.15 150)); }
.p2b .audit-row .afind .note { font-family:var(--font-mono); font-size:9.5px; color:var(--fg-3); margin-top:2px; }
.p2b .audit-row .alast { font-family:var(--font-mono); font-size:10px; color:var(--fg-3); }
.p2b .audit-row .row-actions { display:flex; gap:6px; align-items:center; }

.p2b .audit-foot { padding:10px 14px; border-top:1px solid var(--line-1); background:var(--bg-sunken); font-family:var(--font-mono); font-size:10px; color:var(--fg-3); }
.p2b .audit-foot a { color:var(--ember-08); }

.p2b .audit-rec-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
@media (max-width: 880px) { .p2b .audit-rec-grid { grid-template-columns:1fr; } }
.p2b .audit-rec { border:1px solid var(--line-1); border-radius:var(--r-1); background:var(--bg-sunken); padding:11px 13px; display:flex; flex-direction:column; gap:6px; }
.p2b .audit-rec .rn { font-family:var(--font-display); font-weight:700; font-size:13px; color:var(--ember-08); }
.p2b .audit-rec .rw { font-family:var(--font-ui); font-size:12px; color:var(--fg-2); line-height:1.45; }
.p2b .audit-rec .foot { display:flex; gap:10px; align-items:center; justify-content:space-between; margin-top:2px; }
.p2b .audit-rec .win { font-family:var(--font-mono); font-size:9.5px; color:var(--fg-3); }

.p2b .audit-composer { display:grid; grid-template-columns:repeat(2, 1fr); gap:10px; }
@media (max-width: 720px) { .p2b .audit-composer { grid-template-columns:1fr; } }
.p2b .audit-composer .field { display:flex; flex-direction:column; gap:4px; }
.p2b .audit-composer .label { font-family:var(--font-mono); font-size:9px; color:var(--fg-3); letter-spacing:0.12em; text-transform:uppercase; }
.p2b .audit-composer input, .p2b .audit-composer select { font-family:var(--font-mono); font-size:12px; color:var(--fg-1); background:var(--bg-surface); border:1px solid var(--line-1); border-radius:var(--r-1); padding:7px 9px; }
.p2b .composer-actions { display:flex; gap:8px; margin-top:4px; }
`;

export function AuditsStyles() {
  return <style dangerouslySetInnerHTML={{ __html: AUDITS_CSS }} />;
}
