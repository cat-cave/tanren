/**
 * Run-detail + review screen styles (P2B-0004). Recreated from the hi-fi
 * (`tanren-hi-fidelity/project/view-run.jsx` / `view-review.jsx`), token-driven
 * only — no hardcoded colors. Exported as a string and inlined via a `<style>`
 * tag in the page body so this screen owns its CSS without touching the shared
 * `shell.css` (owned by P2B-0001).
 */

export const RUN_DETAIL_CSS = `
/* ---- cost bar ---- */
.cost-bar {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 1px;
  background: var(--line-1);
  border: 1px solid var(--line-1);
  margin-bottom: 12px;
}
.cost-cell {
  background: var(--bg-canvas);
  padding: 9px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.cost-cell .row1 { display: flex; align-items: center; gap: 6px; }
.cost-cell .swatch { width: 8px; height: 8px; flex-shrink: 0; }
.cost-cell .l {
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em;
  text-transform: uppercase; font-weight: 700;
}
.cost-cell .v {
  margin-left: auto; font-family: var(--font-mono); font-size: 13px;
  font-weight: 700; color: var(--fg-1);
}
.cost-cell .bar { height: 4px; background: var(--line-2); overflow: hidden; }
.cost-cell .bar i { display: block; height: 100%; }
.cost-cell .k { font-family: var(--font-mono); font-size: 10px; color: var(--fg-3); }
.cost-cell .source-rows { display: flex; flex-direction: column; gap: 3px; }
.cost-cell .source-row { display: flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-size: 10px; }
.cost-cell .source-row .sw { width: 6px; height: 6px; flex-shrink: 0; }
.cost-cell .source-row .amt { margin-left: auto; color: var(--fg-1); }
.cost-cell.meta-cell .grid {
  display: grid; grid-template-columns: auto 1fr; gap: 2px 10px;
  font-family: var(--font-mono); font-size: 11px;
}
.cost-cell.meta-cell .grid b { color: var(--fg-1); text-align: right; }

/* ---- split layout: trajectory + reasoning ---- */
.split-run, .split-review {
  display: grid;
  grid-template-columns: 340px 1fr;
  gap: 12px;
  height: calc(100vh - 280px);
  min-height: 420px;
}
.split-review { grid-template-columns: 1fr 1fr; }
.rd-panel {
  border: 1px solid var(--line-1);
  background: var(--bg-canvas);
  display: flex; flex-direction: column;
  min-height: 0; overflow: hidden;
}
.rd-panel-head {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 14px; border-bottom: 1px solid var(--line-1);
  background: var(--bg-sunken); flex-shrink: 0;
}
.rd-panel-head h3 { margin: 0; font-size: 12px; font-weight: 700; letter-spacing: -0.01em; }
.rd-panel-head .live {
  margin-left: auto; font-family: var(--font-mono); font-size: 10px;
  color: var(--ember-08); letter-spacing: 0.06em;
}
.rd-panel-body { overflow-y: auto; position: relative; flex: 1; }

/* ---- trajectory spine ---- */
.trajectory .rd-panel-body { padding: 10px 0; }
.spine {
  position: absolute; left: 24px; top: 14px; bottom: 14px; width: 2px;
}
.traj-row {
  display: flex; gap: 12px; padding: 8px 14px 8px 14px;
  cursor: pointer; position: relative; border-left: 2px solid transparent;
}
.traj-row:hover { background: var(--bg-sunken); }
.traj-row.selected { background: var(--ember-03); border-left-color: var(--ember-08); }
.traj-row.queued { opacity: 0.5; }
.traj-row .dot {
  width: 18px; height: 18px; flex-shrink: 0; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 700; z-index: 1;
  border: 2px solid var(--bg-canvas);
  background: var(--line-2); color: var(--fg-3);
}
.traj-row .dot.done { background: var(--status-ok); color: var(--ink-12, #fff); }
.traj-row .dot.live { background: var(--ember-08); color: var(--ink-12, #fff); }
.traj-row .dot.failed { background: var(--status-fail); color: var(--ink-12, #fff); }
.traj-row .ph {
  font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--fg-3); font-weight: 700;
}
.traj-row .ph.live { color: var(--ember-08); }
.traj-row .ph.failed { color: var(--status-fail); }
.traj-row .t { font-size: 12.5px; color: var(--fg-1); margin-top: 1px; }
.traj-row .io { font-family: var(--font-mono); font-size: 10px; color: var(--fg-3); margin-top: 2px; }
.rd-foot {
  padding: 8px 14px; border-top: 1px solid var(--line-1);
  background: var(--bg-sunken); font-family: var(--font-mono);
  font-size: 9.5px; color: var(--fg-3); flex-shrink: 0;
}

/* ---- reasoning pane ---- */
.reason { padding: 16px; display: flex; flex-direction: column; gap: 18px; }
.reason .moment-eyebrow {
  font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--ember-08); font-weight: 700;
}
.reason h2 { margin: 4px 0 0; font-size: 18px; font-weight: 800; letter-spacing: -0.02em; }
.reason h4 {
  margin: 0 0 6px; font-family: var(--font-mono); font-size: 10px;
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--fg-3); font-weight: 700;
}
.reason .intent, .reason .bdd { font-size: 12.5px; line-height: 1.55; color: var(--fg-2); }
.reason .bdd div { margin-bottom: 3px; }
.reason .bdd .kw { color: var(--ember-08); font-family: var(--font-mono); font-size: 11px; }
.reason .tool-row {
  display: flex; gap: 8px; align-items: flex-start;
  padding: 7px 9px; border: 1px solid var(--line-1); background: var(--bg-sunken);
}
.reason .tool-row.live { border-color: var(--ember-08); }
.reason .tool-row .g { font-family: var(--font-mono); color: var(--ember-08); }
.reason .tool-row .name { font-size: 12px; }
.reason .tool-row .name .arg { color: var(--fg-3); font-family: var(--font-mono); font-size: 11px; }
.reason .tool-row .out { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-3); margin-top: 2px; }
.reason .tool-row .state { margin-left: auto; font-family: var(--font-mono); font-size: 9.5px; color: var(--fg-3); }
.reason ul.decisions { margin: 0; padding-left: 16px; }
.reason ul.decisions li { font-size: 12.5px; line-height: 1.6; color: var(--fg-2); }
.reason ul.decisions code { font-family: var(--font-mono); font-size: 11px; background: var(--bg-sunken); padding: 0 3px; }
.ask-forge-cta {
  border: 1px dashed var(--ember-08); padding: 10px 12px; cursor: pointer;
  display: flex; flex-direction: column; gap: 2px; background: var(--ember-03);
}
.ask-forge-cta .l { font-family: var(--font-mono); font-size: 10px; color: var(--ember-08); letter-spacing: 0.06em; text-transform: uppercase; font-weight: 700; }
.ask-forge-cta .t { font-size: 12.5px; color: var(--fg-1); }

/* ---- events list ---- */
.events-list { display: flex; flex-direction: column; gap: 4px; }
.event-row {
  display: grid; grid-template-columns: 130px 1fr; gap: 10px;
  padding: 5px 8px; border-bottom: 1px solid var(--line-1);
  font-family: var(--font-mono); font-size: 11px;
}
.event-row .et { color: var(--ember-08); }
.event-row .redacted {
  color: var(--status-warn); font-style: italic;
}
.raw-toggle { font-family: var(--font-mono); font-size: 10px; }
.raw-toggle a { color: var(--ember-08); text-decoration: underline; }

/* ---- failure diagnostics ---- */
.failure-banner {
  border: 1px solid var(--status-fail); background: var(--bg-sunken);
  padding: 12px 14px; margin-bottom: 12px;
}
.failure-banner h3 { margin: 0 0 6px; font-size: 13px; color: var(--status-fail); }
.failure-banner .diag { font-family: var(--font-mono); font-size: 11px; color: var(--fg-2); line-height: 1.6; }

/* ---- pr / ci status chips ---- */
.rd-chips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.rd-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border: 1px solid var(--line-1);
  font-family: var(--font-mono); font-size: 11px; color: var(--fg-2);
}
.rd-chip .d { width: 7px; height: 7px; border-radius: 50%; background: var(--fg-3); }
.rd-chip.ok .d { background: var(--status-ok); }
.rd-chip.warn .d { background: var(--status-warn); }
.rd-chip.bad .d { background: var(--status-fail); }
.rd-chip a { color: var(--ember-08); }

/* ---- subopt callout ---- */
.subopt {
  border: 1px solid var(--status-warn); background: var(--bg-sunken);
  padding: 10px 12px; display: flex; flex-direction: column; gap: 4px;
}
.subopt .tag {
  font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--status-warn); font-weight: 700;
}
.subopt .t { font-size: 12.5px; color: var(--fg-1); }

/* ---- review handoff ---- */
.forge-card { border: 1px solid var(--line-1); background: var(--bg-canvas); display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.forge-card .head { display: flex; align-items: center; gap: 8px; padding: 9px 14px; border-bottom: 1px solid var(--line-1); background: var(--bg-sunken); flex-shrink: 0; }
.forge-card .head .stamp { font-family: var(--font-jp); color: var(--ember-08); font-size: 15px; }
.forge-card .head .title { font-size: 12px; font-weight: 700; }
.forge-card .head .meta { margin-left: auto; font-family: var(--font-mono); font-size: 10px; color: var(--fg-3); }
.forge-card .body { overflow-y: auto; flex: 1; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.forge-turn { font-size: 12.5px; line-height: 1.55; color: var(--fg-2); }
.forge-turn .accent { color: var(--ember-08); }
.behavior {
  display: grid; grid-template-columns: 18px 1fr auto auto; gap: 8px; align-items: center;
  padding: 7px 9px; border: 1px solid var(--line-1); cursor: pointer; background: var(--bg-canvas);
}
.behavior:hover { border-color: var(--ember-08); }
.behavior.done { background: var(--ember-03); }
.behavior .check { width: 16px; height: 16px; border: 1.5px solid var(--line-2); display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--status-ok); }
.behavior.done .check { border-color: var(--status-ok); }
.behavior .t { font-size: 12px; color: var(--fg-1); }
.behavior .t b { color: var(--ember-08); margin-right: 5px; font-family: var(--font-mono); font-size: 11px; }
.behavior .ci { font-family: var(--font-mono); font-size: 9.5px; color: var(--fg-3); }
.behavior .you { font-family: var(--font-mono); font-size: 9.5px; color: var(--fg-3); }
.deferral { border: 1px solid var(--line-1); padding: 9px 11px; }
.deferral .head { display: flex; align-items: center; gap: 8px; background: transparent; border: 0; padding: 0; }
.deferral .tag { font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--status-warn); font-weight: 700; }
.deferral .t { font-size: 12.5px; color: var(--fg-1); }
.deferral .resolved { margin-left: auto; font-family: var(--font-mono); font-size: 9.5px; color: var(--ember-08); text-transform: uppercase; letter-spacing: 0.1em; font-weight: 700; }
.deferral .det { font-size: 11.5px; color: var(--fg-2); margin-top: 4px; line-height: 1.5; }
.deferral .actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.chip { display: inline-flex; gap: 4px; padding: 4px 8px; border: 1px solid var(--line-1); font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-2); }
.chip .pre { color: var(--ember-08); }
.forge-input { display: flex; align-items: center; gap: 8px; padding: 9px 14px; border-top: 1px solid var(--line-1); background: var(--bg-sunken); flex-shrink: 0; }
.forge-input .stamp { font-family: var(--font-jp); color: var(--ember-08); }
.forge-input input { flex: 1; background: transparent; border: 0; color: var(--fg-1); font-size: 12.5px; outline: none; }
.forge-input .kbd { font-family: var(--font-mono); font-size: 10px; color: var(--fg-3); }

/* ---- preview pane ---- */
.preview { border: 1px solid var(--line-1); background: var(--bg-canvas); display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.preview .head { display: flex; align-items: center; gap: 10px; padding: 9px 14px; border-bottom: 1px solid var(--line-1); background: var(--bg-sunken); flex-shrink: 0; }
.preview .head .url { font-family: var(--font-mono); font-size: 10px; color: var(--fg-3); }
.preview .device-tabs { margin-left: auto; display: flex; gap: 4px; }
.preview .device-tabs button { font-family: var(--font-mono); font-size: 10px; padding: 3px 8px; border: 1px solid var(--line-1); background: transparent; color: var(--fg-3); cursor: pointer; }
.preview .device-tabs button.active { border-color: var(--ember-08); color: var(--ember-08); }
.preview .frame { flex: 1; overflow: auto; padding: 16px; display: flex; align-items: center; justify-content: center; }
.preview .placeholder-frame { border: 1px dashed var(--line-2); padding: 28px; text-align: center; transition: max-width 160ms; width: 100%; }
.preview .placeholder-frame .pl-title { font-size: 14px; font-weight: 700; color: var(--fg-1); }
.preview .placeholder-frame .pl-note { font-size: 11.5px; color: var(--fg-3); margin-top: 6px; line-height: 1.5; }
.preview .placeholder-frame a { color: var(--ember-08); text-decoration: underline; }
.preview .placeholder-frame code { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-2); background: var(--bg-sunken); padding: 0 3px; }
/* P3-0025 live preview-deploy iframe. max-width is driven by the device tabs
   (the review island sets it inline: none / 768px / 375px). Sandboxed in TSX. */
.preview .preview-iframe { width: 100%; height: 100%; min-height: 420px; border: 1px solid var(--line-2); background: white; transition: max-width 160ms; }

/* ---- readiness gate ---- */
.readiness {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 12px 14px; border: 1px solid var(--line-1); background: var(--bg-sunken);
  margin-top: 12px;
}
.readiness .pill { display: inline-flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-size: 11px; color: var(--fg-2); }
.readiness .pill .d { width: 7px; height: 7px; border-radius: 50%; background: var(--fg-3); }
.readiness .pill.ok .d { background: var(--status-ok); }
.readiness .pill.warn .d { background: var(--status-warn); }
.readiness .note { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-3); }
.readiness .grow { margin-left: auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.readiness .merge-note { font-family: var(--font-mono); font-size: 10px; color: var(--fg-3); }
.readiness .merge-note a { color: var(--ember-08); }

/* buttons reused from shell but a couple of local variants */
.btn.danger { color: var(--status-fail); }
.btn[disabled] { opacity: 0.45; cursor: not-allowed; }

/* ---- buttons + page-head pills (local; shell does not define .btn) ---- */
.rd-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.btn {
  display: inline-flex; align-items: center; gap: 5px;
  font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.02em;
  padding: 5px 11px; border: 1px solid var(--line-1); background: transparent;
  color: var(--fg-1); cursor: pointer; text-decoration: none;
}
.btn:hover:not([disabled]) { border-color: var(--ember-08); }
.btn.ghost { color: var(--fg-3); }
.btn.primary { background: var(--ember-08); color: var(--ink-12, #fff); border-color: var(--ember-08); }
.btn.notched { clip-path: polygon(0 0, calc(100% - 7px) 0, 100% 7px, 100% 100%, 0 100%); }
.pill {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--font-mono); font-size: 10.5px;
  padding: 3px 9px; border: 1px solid var(--line-1); color: var(--fg-2);
}
.pill .d { width: 6px; height: 6px; border-radius: 50%; background: var(--status-run); }
.pill.run .d { background: var(--ember-08); }
`;
