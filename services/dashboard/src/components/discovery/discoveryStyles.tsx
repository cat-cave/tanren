/**
 * P3-0014 discovery-surface styles. Layered ON TOP of the shared `p2b` /
 * project screen scaffolding (the discovery body renders `ScreenStyles` for the
 * shared classes, then this for the discovery-only bits). Everything keys off
 * the P2A-0016 design tokens — no hardcoded colours — matching the hi-fi
 * `view-discovery` look without importing the prototype JSX/CSS.
 */

export const DISCOVERY_CSS = `
.p2b .insight-banner { display:flex; gap:12px; align-items:flex-start; border:1px solid var(--line-2); border-left:2px solid var(--ember-08); border-radius:var(--r-2); padding:13px 15px; background:var(--bg-surface); margin-bottom:14px; }
.p2b .insight-banner.fail { border-left-color:var(--status-fail,oklch(58% 0.2 25)); }
.p2b .insight-banner .glyph { font-family:var(--font-jp); font-size:22px; color:var(--ember-08); line-height:1; }
.p2b .insight-banner .meta { font-family:var(--font-mono); font-size:10px; color:var(--fg-3); display:flex; gap:8px; flex-wrap:wrap; }
.p2b .insight-banner .meta b { color:var(--fg-2); font-weight:600; }
.p2b .insight-banner .body { font-family:var(--font-ui); font-size:13px; color:var(--fg-1); line-height:1.5; margin-top:6px; }

.p2b .disc-split { display:grid; grid-template-columns:1.4fr 1fr; gap:14px; align-items:start; }
@media (max-width: 1040px) { .p2b .disc-split { grid-template-columns:1fr; } }

.p2b .col-card { border:1px solid var(--line-1); border-radius:var(--r-1); background:var(--bg-sunken); padding:12px; display:flex; flex-direction:column; gap:4px; margin-bottom:8px; }
.p2b .col-card.live { border-color:var(--ember-08); }
.p2b .col-card.fail { border-color:var(--status-fail,oklch(58% 0.2 25)); }
.p2b .col-card.warn { border-color:var(--status-warn,oklch(70% 0.16 75)); }
.p2b .col-card .h { font-family:var(--font-mono); font-size:9px; letter-spacing:0.16em; text-transform:uppercase; color:var(--ember-08); font-weight:700; }
.p2b .col-card .display-h { font-family:var(--font-display); font-weight:700; font-size:14px; color:var(--fg-1); }
.p2b .col-card .det { font-family:var(--font-mono); font-size:10.5px; color:var(--fg-2); line-height:1.6; }
.p2b .col-card .det code { color:var(--ember-07,var(--ember-08)); }

.p2b .place-opt { padding:8px 11px; border:1px solid var(--line-1); border-left:2px solid var(--line-2); border-radius:var(--r-1); background:var(--bg-sunken); cursor:pointer; display:block; width:100%; text-align:left; }
.p2b .place-opt + .place-opt { margin-top:6px; }
.p2b .place-opt.rec { background:var(--accent-tint,var(--bg-canvas)); border-color:var(--ember-08); border-left-color:var(--ember-08); }
.p2b .place-opt.risk { border-color:var(--status-fail,oklch(58% 0.2 25)); border-left-color:var(--status-fail,oklch(58% 0.2 25)); }
.p2b .place-opt.sel { box-shadow:inset 0 0 0 1px var(--ember-08); }
.p2b .place-opt .pl-top { display:flex; justify-content:space-between; align-items:baseline; gap:8px; }
.p2b .place-opt .pl-label { font-family:var(--font-display); font-weight:600; font-size:13px; color:var(--fg-1); text-transform:lowercase; }
.p2b .place-opt .pl-prio { font-family:var(--font-mono); font-size:10px; font-weight:700; color:var(--fg-3); }
.p2b .place-opt.rec .pl-prio { color:var(--ember-08); }
.p2b .place-opt.risk .pl-prio { color:var(--status-fail,oklch(58% 0.2 25)); }
.p2b .place-opt .pl-meta { font-family:var(--font-mono); font-size:10px; color:var(--fg-2); margin-top:3px; display:flex; justify-content:space-between; gap:8px; }
.p2b .place-opt .pl-meta .eta { color:var(--fg-1); }

.p2b .delta-card { border:1px solid var(--line-1); border-radius:var(--r-1); padding:10px 12px; margin-bottom:8px; background:var(--bg-surface); }
.p2b .delta-card .dc-head { display:flex; gap:8px; align-items:baseline; }
.p2b .delta-card .dc-title { font-family:var(--font-display); font-weight:700; font-size:12px; color:var(--fg-1); text-transform:lowercase; }
.p2b .delta-card .dc-count { font-family:var(--font-mono); font-size:10px; color:var(--ember-08); margin-left:auto; }
.p2b .delta-card.mod .dc-count { color:var(--status-warn,oklch(70% 0.16 75)); }
.p2b .delta-card.impact .dc-count { color:var(--fg-3); }
.p2b .delta-card ul { margin:6px 0 0; padding-left:14px; }
.p2b .delta-card li { font-family:var(--font-ui); font-size:11.5px; color:var(--fg-2); line-height:1.45; }

.p2b .disc-form textarea { width:100%; min-height:88px; font-family:var(--font-ui); font-size:13px; padding:9px 11px; border:1px solid var(--line-2); border-radius:var(--r-1); background:var(--bg-canvas); color:var(--fg-1); resize:vertical; }
.p2b .disc-form .row { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
.p2b .disc-form input[type=text] { font-family:var(--font-ui); font-size:12px; padding:7px 10px; border:1px solid var(--line-2); border-radius:var(--r-1); background:var(--bg-canvas); color:var(--fg-1); flex:1; min-width:140px; }
.p2b .variant-tabs { display:inline-flex; gap:0; border:1px solid var(--line-2); border-radius:var(--r-1); overflow:hidden; margin-bottom:12px; }
.p2b .variant-tabs a { font-family:var(--font-mono); font-size:11px; padding:6px 12px; color:var(--fg-3); text-decoration:none; background:var(--bg-surface); }
.p2b .variant-tabs a + a { border-left:1px solid var(--line-2); }
.p2b .variant-tabs a.active { color:var(--ember-08); background:var(--bg-canvas); }
.p2b .sect-label { font-family:var(--font-mono); font-size:9px; color:var(--ember-08); letter-spacing:0.22em; text-transform:uppercase; font-weight:700; margin-bottom:6px; }
`;

export function DiscoveryStyles() {
  return <style dangerouslySetInnerHTML={{ __html: DISCOVERY_CSS }} />;
}
