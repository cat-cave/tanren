/**
 * screen styles. The shell only links `tokens.css` + `shell.css`
 * (both owned by, which this spec must not edit), so the project /
 * spec / settings screens ship their own CSS inline via a `<style>` tag that
 * each page body renders once near the top. Everything keys off the shared
 * design tokens — no hardcoded colors — matching the hi-fi look without
 * importing the prototype JSX/CSS.
 */

export const PROJECT_SCREEN_CSS = `
/* ---- shared page scaffolding (mirrors hi-fi PageHead / KpiStrip) ---- */
.p2b .page-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding:18px 22px 12px; flex-wrap:wrap; }
.p2b .page-head .title { font-family:var(--font-display); font-weight:700; font-size:22px; color:var(--fg-1); letter-spacing:-0.01em; }
.p2b .page-head .title em { color:var(--ember-08); font-style:normal; }
.p2b .head-actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.p2b .mode-toggle { display:inline-flex; border:1px solid var(--line-2); border-radius:var(--r-1); overflow:hidden; }
.p2b .mode-toggle .seg-btn { font-family:var(--font-mono); font-size:11px; padding:6px 10px; border:none; background:var(--bg-surface); color:var(--fg-3); cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; gap:4px; }
.p2b .mode-toggle .seg-btn + .seg-btn { border-left:1px solid var(--line-2); }
.p2b .mode-toggle .seg-btn:hover { color:var(--fg-1); }
.p2b .mode-toggle .seg-btn.active { color:var(--ember-08); background:var(--bg-canvas); }
.p2b .btn { font-family:var(--font-mono); font-size:11px; padding:6px 11px; border:1px solid var(--line-2); background:var(--bg-surface); color:var(--fg-2); border-radius:var(--r-1); cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; gap:5px; }
.p2b .btn:hover { border-color:var(--ember-08); color:var(--fg-1); }
.p2b .btn.primary { background:var(--ember-08); border-color:var(--ember-08); color:var(--accent-on); }
.p2b .btn.ghost { background:transparent; border-color:transparent; color:var(--fg-3); }
.p2b .pill { font-family:var(--font-mono); font-size:9.5px; letter-spacing:0.12em; text-transform:uppercase; font-weight:700; padding:4px 8px; border-radius:var(--r-full); display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line-2); color:var(--fg-2); }
.p2b .pill .d { width:6px; height:6px; border-radius:var(--r-full); background:currentColor; display:inline-block; }
.p2b .pill.run { color:var(--ember-08); border-color:var(--ember-08); }
.p2b .pill.warn { color:var(--status-warn,oklch(70% 0.16 75)); border-color:currentColor; }
.p2b .pill.ok { color:var(--status-ok,oklch(58% 0.18 155)); border-color:currentColor; }

.p2b .kpi-strip { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:1px; background:var(--line-1); border-top:1px solid var(--line-1); border-bottom:1px solid var(--line-1); }
.p2b .kpi { background:var(--bg-surface); padding:11px 16px; display:flex; flex-direction:column; gap:3px; }
.p2b .kpi .k { font-family:var(--font-mono); font-size:9px; letter-spacing:0.16em; text-transform:uppercase; color:var(--fg-3); }
.p2b .kpi .v { font-family:var(--font-display); font-weight:700; font-size:19px; color:var(--fg-1); }
.p2b .kpi.hot .v { color:var(--ember-08); }
.p2b .kpi.warn .v { color:var(--status-warn,oklch(70% 0.16 75)); }

.p2b .page-body { padding:18px 22px; }
.p2b .split-chat { display:grid; grid-template-columns:1.4fr 1fr; gap:14px; align-items:start; }
@media (max-width:1100px){ .p2b .split-chat { grid-template-columns:1fr; } }
.p2b .col { display:flex; flex-direction:column; gap:12px; }

/* ---- forge narration card ---- */
.p2b .forge-card { border:1px solid var(--line-2); border-radius:var(--r-2); background:var(--bg-surface); overflow:hidden; }
.p2b .forge-card > .head { display:flex; align-items:center; gap:9px; padding:11px 14px; border-bottom:1px solid var(--line-1); background:var(--bg-sunken); }
.p2b .forge-card .stamp { font-family:var(--font-jp); font-size:17px; color:var(--ember-08); }
.p2b .forge-card .head .title { font-family:var(--font-display); font-weight:700; font-size:13px; color:var(--fg-1); }
.p2b .forge-card .head .title em { color:var(--ember-08); font-style:normal; }
.p2b .forge-card .head .meta { margin-left:auto; font-family:var(--font-mono); font-size:9.5px; color:var(--fg-3); }
.p2b .forge-card > .body { padding:14px; display:flex; flex-direction:column; gap:14px; }
.p2b .forge-turn { border-left:2px solid var(--line-2); padding-left:12px; }
.p2b .turn-label { font-family:var(--font-mono); font-size:9.5px; color:var(--status-warn,oklch(70% 0.16 75)); letter-spacing:0.18em; text-transform:uppercase; font-weight:700; margin-bottom:8px; }
.p2b .state-card .label { font-family:var(--font-mono); font-size:9.5px; color:var(--fg-3); letter-spacing:0.16em; text-transform:uppercase; margin-bottom:5px; }
.p2b .state-card .text { font-family:var(--font-ui); font-size:14px; color:var(--fg-1); line-height:1.5; }
.p2b .state-card .sub-text { font-family:var(--font-mono); font-size:10.5px; color:var(--fg-3); margin-top:5px; }

.p2b .attn-row { display:grid; grid-template-columns:auto 1fr auto; gap:10px; align-items:center; padding:9px 11px; border:1px solid var(--line-2); border-radius:var(--r-1); background:var(--bg-canvas); text-decoration:none; }
.p2b .attn-row:hover { border-color:var(--ember-08); }
.p2b .attn-row.hot { border-color:var(--ember-08); }
.p2b .attn-row.warn { border-color:var(--status-warn,oklch(70% 0.16 75)); }
.p2b .attn-row .priority { font-family:var(--font-mono); font-size:8.5px; letter-spacing:0.1em; text-transform:uppercase; font-weight:700; color:var(--fg-3); padding:3px 6px; border:1px solid var(--line-2); border-radius:var(--r-full); }
.p2b .attn-row .t { font-family:var(--font-ui); font-size:13px; color:var(--fg-1); }
.p2b .attn-row .s { font-family:var(--font-mono); font-size:10px; color:var(--fg-3); margin-top:2px; }
.p2b .attn-row .arrow { color:var(--ember-08); font-size:14px; }
.p2b .empty-note { font-family:var(--font-mono); font-size:11px; color:var(--fg-3); padding:8px 0; }

.p2b .subopt { border:1px solid var(--status-warn,oklch(70% 0.16 75)); border-radius:var(--r-1); padding:11px 13px; background:var(--bg-canvas); }
.p2b .subopt .kind { font-family:var(--font-mono); font-size:8.5px; letter-spacing:0.16em; text-transform:uppercase; font-weight:700; color:var(--status-warn,oklch(70% 0.16 75)); }
.p2b .subopt .t { font-family:var(--font-display); font-weight:700; font-size:13px; color:var(--fg-1); margin:4px 0; }
.p2b .subopt .b { font-family:var(--font-ui); font-size:12px; color:var(--fg-2); line-height:1.5; }
.p2b .subopt .acts { display:flex; gap:6px; margin-top:9px; flex-wrap:wrap; }
.p2b .subopt button { font-family:var(--font-mono); font-size:10px; padding:5px 9px; border:1px solid var(--ember-08); background:transparent; color:var(--ember-08); border-radius:var(--r-1); cursor:pointer; }

.p2b .chips { display:flex; flex-wrap:wrap; gap:6px; }
.p2b .chip { font-family:var(--font-ui); font-size:11.5px; color:var(--fg-2); padding:5px 10px; border:1px solid var(--line-2); border-radius:var(--r-full); background:var(--bg-canvas); cursor:pointer; }
.p2b .chip .pre { color:var(--ember-08); margin-right:4px; }
.p2b .forge-input { display:flex; align-items:center; gap:9px; padding:10px 14px; border-top:1px solid var(--line-1); background:var(--bg-sunken); }
.p2b .forge-input input { flex:1; background:var(--bg-canvas); border:1px solid var(--line-2); border-radius:var(--r-1); padding:7px 10px; font-family:var(--font-ui); font-size:12px; color:var(--fg-2); }
.p2b .forge-input .kbd { font-family:var(--font-mono); font-size:10px; color:var(--fg-3); border:1px solid var(--line-2); border-radius:var(--r-1); padding:2px 6px; }

/* ---- dag snapshot + velocity + activity ---- */
.p2b .dag-shell { border:1px solid var(--line-2); border-radius:var(--r-2); background:var(--bg-surface); overflow:hidden; }
.p2b .dag-head { display:flex; align-items:center; gap:10px; padding:9px 12px; border-bottom:1px solid var(--line-1); background:var(--bg-sunken); }
.p2b .dag-head .note { font-family:var(--font-mono); font-size:9.5px; color:var(--fg-3); }
.p2b .dag-canvas { padding:10px; }
.p2b .dag-canvas svg { width:100%; height:auto; }
.p2b .dag-node { cursor:pointer; }
.p2b .dag-placeholder { font-family:var(--font-mono); font-size:10px; color:var(--fg-3); padding:8px 12px; border-top:1px dashed var(--line-2); }

.p2b .velocity { border:1px solid var(--line-2); border-radius:var(--r-2); background:var(--bg-surface); padding:12px 14px; }
.p2b .velocity .head { display:flex; justify-content:space-between; align-items:baseline; }
.p2b .velocity .head .l { font-family:var(--font-mono); font-size:9.5px; letter-spacing:0.16em; text-transform:uppercase; color:var(--fg-3); }
.p2b .velocity .head .s { font-family:var(--font-mono); font-size:10px; color:var(--ember-08); }
.p2b .velocity .spark { display:flex; align-items:flex-end; gap:3px; height:30px; margin:10px 0; }
.p2b .velocity .spark i { flex:1; background:var(--line-2); border-radius:1px; min-height:2px; }
.p2b .velocity .spark i.hot { background:var(--ember-08); }
.p2b .velocity .foot { display:flex; gap:8px; align-items:baseline; font-family:var(--font-mono); font-size:10px; }
.p2b .velocity .foot .k { color:var(--fg-3); }
.p2b .velocity .foot .v { color:var(--fg-1); font-weight:700; }
.p2b .velocity .foot .t { color:var(--status-ok,oklch(58% 0.18 155)); margin-left:auto; }

.p2b .activity { border:1px solid var(--line-2); border-radius:var(--r-2); background:var(--bg-surface); overflow:hidden; }
.p2b .activity .panel-head { display:flex; align-items:center; justify-content:space-between; padding:9px 13px; border-bottom:1px solid var(--line-1); background:var(--bg-sunken); }
.p2b .activity .panel-head h3 { font-family:var(--font-display); font-weight:700; font-size:12px; color:var(--fg-1); margin:0; }
.p2b .activity .panel-head h3 em { color:var(--ember-08); font-style:normal; }
.p2b .activity .body { display:flex; flex-direction:column; }
.p2b .activity .row { display:grid; grid-template-columns:auto auto 1fr; gap:9px; align-items:start; padding:8px 13px; border-bottom:1px solid var(--line-1); text-decoration:none; }
.p2b .activity .row:last-child { border-bottom:none; }
.p2b .activity .row .ts { font-family:var(--font-mono); font-size:9px; color:var(--fg-4); }
.p2b .activity .row .icn { font-size:11px; }
.p2b .activity .row .icn.ok { color:var(--status-ok,oklch(58% 0.18 155)); }
.p2b .activity .row .icn.run { color:var(--ember-08); }
.p2b .activity .row .icn.warn { color:var(--status-warn,oklch(70% 0.16 75)); }
.p2b .activity .row .ev { font-family:var(--font-ui); font-size:12px; color:var(--fg-1); }
.p2b .activity .row .det { font-family:var(--font-mono); font-size:9.5px; color:var(--fg-3); }

/* ---- panels (settings + spec form + spec list) ---- */
.p2b .panel { border:1px solid var(--line-2); border-radius:var(--r-2); background:var(--bg-surface); overflow:hidden; margin-bottom:14px; }
.p2b .panel-head { display:flex; align-items:baseline; gap:10px; padding:11px 14px; border-bottom:1px solid var(--line-1); background:var(--bg-sunken); }
.p2b .panel-head h3 { font-family:var(--font-display); font-weight:700; font-size:13px; color:var(--fg-1); margin:0; }
.p2b .panel-head h3 em { color:var(--ember-08); font-style:normal; }
.p2b .panel-head .meta { margin-left:auto; font-family:var(--font-mono); font-size:9.5px; color:var(--fg-3); }
.p2b .panel-body { padding:14px; }
.p2b .settings-grid { display:grid; grid-template-columns:1.5fr 1fr; gap:14px; align-items:start; }
@media (max-width:1100px){ .p2b .settings-grid { grid-template-columns:1fr; } }

/* ---- routing role + chain rows ---- */
.p2b .routing-role { border:1px solid var(--line-1); border-radius:var(--r-1); padding:10px 12px; margin-bottom:10px; }
.p2b .role-head { display:flex; align-items:baseline; gap:10px; margin-bottom:8px; }
.p2b .role-head .role { font-family:var(--font-display); font-weight:700; font-size:13px; color:var(--ember-08); }
.p2b .role-head .desc { font-family:var(--font-mono); font-size:9.5px; color:var(--fg-3); }
.p2b .routing-row { display:grid; grid-template-columns:auto auto 1fr auto auto auto; gap:8px; align-items:center; padding:6px 9px; border:1px solid var(--line-2); border-radius:var(--r-1); background:var(--bg-canvas); margin-bottom:4px; }
.p2b .routing-row.first { border-color:var(--ember-08); }
.p2b .routing-row.changed { border-left:3px solid var(--ember-08); }
.p2b .routing-row .rank { font-family:var(--font-mono); font-size:8.5px; letter-spacing:0.1em; text-transform:uppercase; color:var(--fg-3); }
.p2b .routing-row .cli { font-family:var(--font-mono); font-size:11px; font-weight:700; color:var(--fg-1); }
.p2b .routing-row .model { font-family:var(--font-mono); font-size:10.5px; color:var(--fg-2); }
.p2b .routing-row .auth { font-family:var(--font-mono); font-size:9.5px; color:var(--fg-3); }
.p2b .routing-row .health { font-family:var(--font-mono); font-size:8.5px; letter-spacing:0.08em; text-transform:uppercase; padding:2px 6px; border-radius:var(--r-full); border:1px solid currentColor; }
.p2b .routing-row .health.ok { color:var(--status-ok,oklch(58% 0.18 155)); }
.p2b .routing-row .health.warn, .p2b .routing-row .health.rate_limited { color:var(--status-warn,oklch(70% 0.16 75)); }
.p2b .routing-row .health.fail { color:var(--status-fail,oklch(60% 0.18 25)); }
.p2b .routing-row .acts { display:flex; gap:4px; }
.p2b .routing-row .acts button { font-family:var(--font-mono); font-size:10px; background:transparent; border:1px solid var(--line-2); color:var(--fg-3); border-radius:var(--r-0); cursor:pointer; padding:1px 5px; }
.p2b .routing-row .acts button:hover { border-color:var(--ember-08); color:var(--ember-08); }
.p2b .add-fallback { display:grid; grid-template-columns:repeat(3,1fr) auto; gap:6px; margin-top:6px; }
.p2b .add-fallback input { font-family:var(--font-mono); font-size:10.5px; padding:5px 8px; border:1px solid var(--line-2); background:var(--bg-canvas); color:var(--fg-2); border-radius:var(--r-1); }
.p2b .add-fallback button { font-family:var(--font-mono); font-size:10.5px; color:var(--ember-08); border:1px dashed var(--ember-08); background:transparent; border-radius:var(--r-1); cursor:pointer; }

.p2b .vault-card { border:1px solid var(--line-1); border-radius:var(--r-1); padding:9px 11px; margin-bottom:8px; }
.p2b .vault-card .top { display:flex; justify-content:space-between; }
.p2b .vault-card .label { font-family:var(--font-ui); font-size:12px; color:var(--fg-1); font-weight:600; }
.p2b .vault-card .state { font-family:var(--font-mono); font-size:8.5px; text-transform:uppercase; color:var(--status-ok,oklch(58% 0.18 155)); }
.p2b .vault-card .path { font-family:var(--font-mono); font-size:9.5px; color:var(--fg-3); margin-top:2px; }
.p2b .vault-card .policy { font-family:var(--font-mono); font-size:10px; color:var(--ember-08); margin-top:4px; }
.p2b .vault-card .detail { font-family:var(--font-ui); font-size:11px; color:var(--fg-3); margin-top:3px; line-height:1.4; }

.p2b .hatch-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; }
@media (max-width:900px){ .p2b .hatch-grid { grid-template-columns:repeat(2,1fr); } }
.p2b .hatch-card { border:1px solid var(--line-2); border-radius:var(--r-1); padding:10px; background:var(--bg-canvas); }
.p2b .hatch-card .l { font-family:var(--font-mono); font-size:9.5px; color:var(--fg-3); line-height:1.4; }
.p2b .hatch-card input { width:64px; font-family:var(--font-display); font-weight:700; font-size:20px; color:var(--fg-1); background:var(--bg-surface); border:1px solid var(--line-2); border-radius:var(--r-1); padding:3px 6px; margin:6px 0; }
.p2b .hatch-card .prev { font-family:var(--font-mono); font-size:9px; color:var(--fg-4); }
.p2b .hatch-card .t { font-family:var(--font-mono); font-size:9px; color:var(--ember-08); }
.p2b .hatch-card.stub { opacity:0.7; }
.p2b .hatch-card .badge { font-family:var(--font-mono); font-size:8px; text-transform:uppercase; letter-spacing:0.1em; color:var(--fg-3); border:1px solid var(--line-2); border-radius:var(--r-full); padding:1px 5px; }
.p2b .escape-note { font-family:var(--font-ui); font-size:11.5px; color:var(--fg-2); line-height:1.45; margin-bottom:10px; }
.p2b .escape-note b { color:var(--ember-08); }

.p2b .audit-caption { font-family:var(--font-mono); font-size:9.5px; color:var(--fg-3); margin-top:6px; }
.p2b .audit-caption code { color:var(--ember-07); background:var(--bg-sunken); padding:0 5px; border:1px solid var(--line-1); }

/* ---- forms (spec creation) ---- */
.p2b .form-field { margin-bottom:14px; }
.p2b .form-field label { display:block; font-family:var(--font-mono); font-size:10px; letter-spacing:0.1em; text-transform:uppercase; color:var(--fg-3); margin-bottom:5px; }
.p2b .form-field label .req { color:var(--status-warn,oklch(70% 0.16 75)); }
.p2b .form-field input[type=text], .p2b .form-field textarea, .p2b .form-field select { width:100%; font-family:var(--font-ui); font-size:13px; padding:8px 11px; border:1px solid var(--line-2); background:var(--bg-canvas); color:var(--fg-1); border-radius:var(--r-1); box-sizing:border-box; }
.p2b .form-field textarea { min-height:90px; resize:vertical; }
.p2b .form-field .hint { font-family:var(--font-mono); font-size:9.5px; color:var(--fg-4); margin-top:4px; }
.p2b .checkbox-list { display:flex; flex-direction:column; gap:6px; max-height:200px; overflow:auto; border:1px solid var(--line-1); border-radius:var(--r-1); padding:8px; }
.p2b .checkbox-list label { display:flex; gap:8px; align-items:flex-start; font-family:var(--font-ui); font-size:12px; color:var(--fg-1); text-transform:none; letter-spacing:0; margin:0; cursor:pointer; }
.p2b .ac-list { display:flex; flex-direction:column; gap:6px; }
.p2b .ac-list input { width:100%; }
.p2b .form-error { font-family:var(--font-mono); font-size:11px; color:var(--status-fail,oklch(60% 0.18 25)); padding:8px 11px; border:1px solid var(--status-fail,oklch(60% 0.18 25)); border-radius:var(--r-1); margin-bottom:12px; }
.p2b .form-ok { font-family:var(--font-mono); font-size:11px; color:var(--status-ok,oklch(58% 0.18 155)); padding:8px 11px; border:1px solid var(--status-ok,oklch(58% 0.18 155)); border-radius:var(--r-1); margin-bottom:12px; }

/* ---- spec list ---- */
.p2b .spec-row { display:grid; grid-template-columns:auto 1fr auto auto; gap:12px; align-items:center; padding:10px 13px; border:1px solid var(--line-2); border-radius:var(--r-1); background:var(--bg-canvas); margin-bottom:6px; text-decoration:none; }
.p2b .spec-row:hover { border-color:var(--ember-08); }
.p2b .spec-row .status { font-family:var(--font-mono); font-size:8.5px; letter-spacing:0.1em; text-transform:uppercase; padding:3px 7px; border:1px solid var(--line-2); border-radius:var(--r-full); color:var(--fg-3); }
.p2b .spec-row .st-open { color:var(--fg-3); }
.p2b .spec-row .st-running, .p2b .spec-row .st-in_flight { color:var(--ember-08); border-color:var(--ember-08); }
.p2b .spec-row .st-review { color:var(--status-warn,oklch(70% 0.16 75)); border-color:currentColor; }
.p2b .spec-row .st-merged, .p2b .spec-row .st-done { color:var(--status-ok,oklch(58% 0.18 155)); border-color:currentColor; }
.p2b .spec-row .st-halted { color:var(--status-fail,oklch(60% 0.18 25)); border-color:currentColor; }
.p2b .spec-row .t { font-family:var(--font-ui); font-size:13px; color:var(--fg-1); }
.p2b .spec-row .d { font-family:var(--font-mono); font-size:10px; color:var(--fg-3); }
.p2b .spec-row-wrap { display:flex; align-items:stretch; gap:6px; margin-bottom:6px; }
.p2b .spec-row-wrap .spec-row { flex:1 1 auto; margin-bottom:0; }
.p2b .run-trigger { display:flex; align-items:center; }
.p2b .run-trigger .btn { white-space:nowrap; }
.p2b .row-error { font-family:var(--font-mono); font-size:11px; color:var(--status-fail,oklch(60% 0.18 25)); padding:6px 11px; border:1px solid var(--status-fail,oklch(60% 0.18 25)); border-radius:var(--r-1); margin:0 0 8px; }
`;

/**
 * Inline `<style>` block carrying the screen CSS. Rendered once per page near
 * the top of the body. Idempotent within a page since each route renders one
 * body. (The shell owns shell.css; we cannot append there.)
 */
export function ScreenStyles() {
  return <style dangerouslySetInnerHTML={{ __html: PROJECT_SCREEN_CSS }} />;
}
