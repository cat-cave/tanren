/**
 * DAG-primary + spec-drawer styles (P3-0013). Shipped inline (the shell only
 * links tokens.css + shell.css, both P2B-0001-owned). Everything keys off the
 * P2A-0016 design tokens — no hardcoded colours — matching the hi-fi
 * `05-dag-primary` / `gap-spec-drawer` screenshots.
 */

export const DAG_SCREEN_CSS = `
/* ---- dag-primary layout ---- */
.p2b .split-dag { display:grid; grid-template-columns:1fr 320px; gap:14px; align-items:start; }
@media (max-width:1100px){ .p2b .split-dag { grid-template-columns:1fr; } }
.p2b .dag-primary { position:relative; min-height:520px; display:flex; flex-direction:column; }
.p2b .dag-primary .grid-bg { position:absolute; inset:0; background-image:linear-gradient(var(--line-1) 1px,transparent 1px),linear-gradient(90deg,var(--line-1) 1px,transparent 1px); background-size:32px 32px; opacity:0.25; pointer-events:none; }

/* ---- needs-you strip ---- */
.p2b .needs-strip { position:relative; z-index:2; display:flex; gap:8px; align-items:stretch; padding:10px 12px; border-bottom:1px solid var(--line-1); flex-wrap:wrap; }
.p2b .needs-strip .needs-label { font-family:var(--font-mono); font-size:9px; color:var(--status-warn,oklch(70% 0.16 75)); letter-spacing:0.18em; text-transform:uppercase; font-weight:700; align-self:center; }
.p2b .needs-strip.empty .needs-quiet { font-family:var(--font-mono); font-size:10px; color:var(--fg-3); align-self:center; }
.p2b .needs-item { display:flex; gap:8px; align-items:center; padding:6px 10px; border:1px solid var(--line-2); border-radius:var(--r-1); background:var(--bg-canvas); cursor:pointer; text-align:left; }
.p2b .needs-item:hover { border-color:var(--ember-08); }
.p2b .needs-item.kind-review { border-color:var(--status-warn,oklch(70% 0.16 75)); }
.p2b .needs-item.kind-blocked { border-color:var(--status-fail,oklch(60% 0.18 25)); }
.p2b .needs-item.kind-live { border-color:var(--ember-08); }
.p2b .needs-item .badge-num { width:18px; height:18px; border-radius:var(--r-full); display:inline-flex; align-items:center; justify-content:center; font-family:var(--font-mono); font-size:10px; font-weight:700; color:var(--accent-on); background:var(--ember-08); }
.p2b .needs-item .badge-num.kind-review { background:var(--status-warn,oklch(70% 0.16 75)); }
.p2b .needs-item .badge-num.kind-blocked { background:var(--status-fail,oklch(60% 0.18 25)); }
.p2b .needs-item .needs-text { display:flex; flex-direction:column; }
.p2b .needs-item .needs-text .t { font-family:var(--font-ui); font-size:11.5px; color:var(--fg-1); }
.p2b .needs-item .needs-text .s { font-family:var(--font-mono); font-size:9px; color:var(--fg-3); }

/* ---- dag controls ---- */
.p2b .dag-primary .dag-head { position:relative; z-index:2; flex-wrap:wrap; }
.p2b .dag-controls { margin-left:auto; display:flex; gap:4px; align-items:center; }
.p2b .ctl-label { font-family:var(--font-mono); font-size:9.5px; color:var(--fg-3); margin-right:4px; }
.p2b .ctl-sep { color:var(--line-1); margin:0 4px; }
.p2b .seg-btn { font-family:var(--font-mono); font-size:10px; padding:3px 8px; border:1px solid var(--line-2); background:var(--bg-canvas); color:var(--fg-3); border-radius:var(--r-1); cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; }
.p2b .seg-btn:hover { border-color:var(--ember-08); color:var(--fg-1); }
.p2b .seg-btn.active { border-color:var(--ember-08); color:var(--ember-08); }

/* ---- dag canvas + nodes ---- */
.p2b .dag-primary .dag-canvas { position:relative; z-index:1; flex:1; min-height:360px; overflow:hidden; }
.p2b .dag-primary .dag-canvas svg { width:100%; height:100%; min-height:360px; display:block; }
.p2b .dag-node { cursor:pointer; }
.p2b .dag-node:hover rect:not(.dag-pulse) { filter:brightness(1.25); }
.p2b .dag-node:focus { outline:none; }
.p2b .dag-node:focus rect:not(.dag-pulse) { stroke:var(--ember-08); stroke-width:2; }
.p2b .dag-fresh { padding:40px 24px; text-align:center; }

/* ---- legend ---- */
.p2b .dag-legend { position:absolute; left:14px; bottom:14px; z-index:3; padding:10px 12px; background:var(--bg-surface); border:1px solid var(--line-2); border-radius:var(--r-1); display:flex; flex-direction:column; gap:5px; }
.p2b .dag-legend .legend-title { font-family:var(--font-mono); font-size:8.5px; letter-spacing:0.16em; text-transform:uppercase; color:var(--fg-3); margin-bottom:3px; }
.p2b .dag-legend .legend-row { display:flex; gap:8px; align-items:center; }
.p2b .dag-legend .swatch { width:16px; height:16px; border-radius:2px; border:1px solid; display:inline-flex; align-items:center; justify-content:center; font-family:var(--font-mono); font-size:9px; }
.p2b .dag-legend .swatch.pulse { box-shadow:0 0 0 2px color-mix(in oklab,currentColor 30%,transparent); }
.p2b .dag-legend .num-swatch { width:16px; height:16px; border-radius:var(--r-full); background:var(--ember-08); color:var(--accent-on); display:inline-flex; align-items:center; justify-content:center; font-family:var(--font-mono); font-size:9px; font-weight:700; }
.p2b .dag-legend .k { font-family:var(--font-mono); font-size:10px; color:var(--fg-2); }
.p2b .dag-legend .legend-divider { height:1px; background:var(--line-1); margin:3px 0; }
.p2b .dag-hint { position:absolute; right:14px; bottom:14px; z-index:3; font-family:var(--font-mono); font-size:9.5px; color:var(--fg-3); padding:5px 9px; background:var(--bg-surface); border:1px solid var(--line-1); border-radius:var(--r-1); }
@media (max-width:760px){ .p2b .dag-hint { display:none; } }

/* ---- right rail (collapsed forge pill) ---- */
.p2b .dag-rail { gap:12px; }
.p2b .forge-pill { display:flex; flex-direction:column; gap:6px; padding:11px 13px; border:1px solid var(--line-2); border-radius:var(--r-2); background:var(--bg-surface); text-decoration:none; cursor:pointer; }
.p2b .forge-pill:hover { border-color:var(--ember-08); }
.p2b .forge-pill .top { display:flex; align-items:center; gap:8px; }
.p2b .forge-pill .stamp { font-family:var(--font-jp); font-size:17px; color:var(--ember-08); }
.p2b .forge-pill .label { font-family:var(--font-mono); font-size:9px; color:var(--ember-08); letter-spacing:0.16em; text-transform:uppercase; font-weight:700; }
.p2b .forge-pill .need { margin-left:auto; font-family:var(--font-mono); font-size:10px; color:var(--status-warn,oklch(70% 0.16 75)); }
.p2b .forge-pill .pulse { font-family:var(--font-ui); font-size:12px; color:var(--fg-1); line-height:1.4; }
.p2b .forge-pill .foot { display:flex; justify-content:space-between; font-family:var(--font-mono); font-size:9.5px; color:var(--fg-3); }

/* ---- spec drawer (slide-in) ---- */
.p2b .spec-scrim { position:fixed; inset:0; z-index:60; background:color-mix(in oklab,var(--bg-canvas) 70%,transparent); display:flex; justify-content:flex-end; }
.p2b .spec-drawer { width:min(460px,94vw); height:100%; background:var(--bg-surface); border-left:1px solid var(--line-2); display:flex; flex-direction:column; box-shadow:-12px 0 40px color-mix(in oklab,var(--bg-canvas) 60%,transparent); animation:specSlide 0.16s ease-out; }
@keyframes specSlide { from { transform:translateX(24px); opacity:0.4; } to { transform:translateX(0); opacity:1; } }
.p2b .spec-drawer-head { padding:14px 16px; border-bottom:1px solid var(--line-1); background:var(--bg-sunken); }
.p2b .spec-drawer-head .row { display:flex; align-items:center; gap:9px; }
.p2b .spec-drawer-head .spec-id { font-family:var(--font-mono); font-size:10px; color:var(--fg-3); }
.p2b .spec-x { margin-left:auto; font-family:var(--font-mono); font-size:10px; color:var(--fg-3); background:transparent; border:1px solid var(--line-2); border-radius:var(--r-1); padding:3px 7px; cursor:pointer; }
.p2b .spec-x:hover { border-color:var(--ember-08); color:var(--fg-1); }
.p2b .spec-title { font-family:var(--font-display); font-weight:700; font-size:18px; color:var(--fg-1); margin:9px 0 0; }
.p2b .spec-drawer-body { flex:1; overflow:auto; padding:14px 16px; display:flex; flex-direction:column; gap:14px; }
.p2b .spec-block .spec-h, .p2b .spec-page .spec-h { font-family:var(--font-mono); font-size:9px; letter-spacing:0.16em; text-transform:uppercase; color:var(--fg-3); margin-bottom:7px; }
.p2b .spec-blocked { border:1px solid var(--status-fail,oklch(60% 0.18 25)); border-radius:var(--r-1); padding:11px 13px; background:oklch(60% 0.18 25 / 0.08); }
.p2b .spec-blocked .lbl { font-family:var(--font-mono); font-size:9px; letter-spacing:0.16em; text-transform:uppercase; color:var(--status-fail,oklch(60% 0.18 25)); font-weight:700; margin-bottom:5px; }
.p2b .spec-blocked .t { font-family:var(--font-ui); font-size:12.5px; color:var(--fg-1); line-height:1.5; }
.p2b .spec-liverun { display:flex; align-items:center; gap:9px; padding:9px 11px; border:1px solid var(--ember-08); border-radius:var(--r-1); background:var(--accent-tint); text-decoration:none; }
.p2b .spec-liverun .t { font-family:var(--font-mono); font-size:11px; color:var(--fg-1); }
.p2b .spec-liverun .go { margin-left:auto; color:var(--ember-08); }
.p2b .spec-bdd { display:flex; flex-direction:column; gap:5px; font-family:var(--font-mono); font-size:11.5px; color:var(--fg-1); line-height:1.5; }
.p2b .spec-bdd .kw { color:var(--ember-08); font-weight:700; }
.p2b .dep-chips { display:flex; flex-wrap:wrap; gap:6px; }
.p2b .dep-chip { font-family:var(--font-mono); font-size:10.5px; padding:4px 9px; border:1px solid var(--line-2); border-radius:var(--r-full); background:var(--bg-canvas); color:var(--fg-2); cursor:pointer; }
.p2b .dep-chip:hover { border-color:var(--ember-08); }
.p2b .dep-chip .g { color:var(--ember-08); margin-right:4px; }
.p2b .dep-chip.s-done { color:var(--status-ok,oklch(58% 0.18 155)); border-color:currentColor; }
.p2b .dep-chip.s-live { color:var(--ember-08); border-color:currentColor; }
.p2b .dep-chip.s-review { color:var(--status-warn,oklch(70% 0.16 75)); border-color:currentColor; }
.p2b .dep-chip.s-blocked { color:var(--status-fail,oklch(60% 0.18 25)); border-color:currentColor; }
.p2b .dep-chip.self { cursor:default; font-weight:700; }
.p2b .dep-none { font-family:var(--font-mono); font-size:10.5px; color:var(--fg-3); }
.p2b .spec-meta-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
.p2b .spec-meta-grid.wide { grid-template-columns:repeat(3,1fr); }
.p2b .spec-meta-grid > div { display:flex; flex-direction:column; gap:3px; padding:8px 10px; border:1px solid var(--line-1); border-radius:var(--r-1); background:var(--bg-canvas); }
.p2b .spec-meta-grid .k { font-family:var(--font-mono); font-size:8.5px; letter-spacing:0.1em; text-transform:uppercase; color:var(--fg-3); }
.p2b .spec-meta-grid b { font-family:var(--font-display); font-size:14px; color:var(--fg-1); }
.p2b .spec-drawer-foot { display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:12px 16px; border-top:1px solid var(--line-1); background:var(--bg-sunken); }
.p2b .spec-expand { margin-left:auto; }

/* ---- spec full page ---- */
.p2b .spec-page-grid { display:grid; grid-template-columns:1.4fr 1fr; gap:14px; align-items:start; }
@media (max-width:1000px){ .p2b .spec-page-grid { grid-template-columns:1fr; } }
.p2b .spec-desc { font-family:var(--font-ui); font-size:13px; color:var(--fg-1); line-height:1.6; }
.p2b .spec-dep-rows { display:flex; flex-direction:column; gap:10px; }
.p2b .dep-row { display:flex; gap:10px; align-items:flex-start; }
.p2b .dep-row .dep-label { font-family:var(--font-mono); font-size:9px; letter-spacing:0.12em; text-transform:uppercase; color:var(--fg-3); width:78px; flex-shrink:0; padding-top:5px; }
.p2b .spec-runs { display:flex; flex-direction:column; gap:6px; }
.p2b .run-hist { display:flex; flex-direction:column; gap:4px; padding:9px 11px; border:1px solid var(--line-2); border-radius:var(--r-1); background:var(--bg-canvas); text-decoration:none; }
.p2b .run-hist.live { border-color:var(--ember-08); }
.p2b .run-hist:hover { border-color:var(--ember-08); }
.p2b .run-hist .top { display:flex; gap:9px; align-items:center; }
.p2b .run-hist .rid { font-family:var(--font-mono); font-size:11px; color:var(--fg-1); }
.p2b .run-hist .oc { font-family:var(--font-mono); font-size:9px; color:var(--fg-3); }
.p2b .run-hist .cost { font-family:var(--font-mono); font-size:10px; color:var(--fg-3); }
.p2b .run-hist .go { color:var(--ember-08); }
`;

export function DagStyles() {
  return <style dangerouslySetInnerHTML={{ __html: DAG_SCREEN_CSS }} />;
}
