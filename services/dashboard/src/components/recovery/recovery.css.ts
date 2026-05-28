/**
 * Halted-run failure-recovery screen styles (P2B-0008). Recreated from the
 * hi-fi `view-failure.jsx`, token-driven only — no hardcoded colors. Exported
 * as a string and inlined via a `<style>` tag in the page body so this screen
 * owns its CSS without touching the shared `shell.css` (owned by P2B-0001).
 */

export const RECOVERY_CSS = `
/* ---- halted pill ---- */
.pill {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--font-mono); font-size: 11px; font-weight: 600;
  letter-spacing: 0.04em; padding: 4px 9px; border-radius: 2px;
  border: 1px solid var(--line-1); color: var(--fg-1);
}
.pill.fail { color: var(--status-fail); border-color: var(--status-fail); }
.pill.fail .d { width: 6px; height: 6px; border-radius: 50%; background: var(--status-fail); }

/* ---- failure-context strip ---- */
.fail-context {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px;
  background: var(--line-1); border: 1px solid var(--line-1); margin-bottom: 16px;
}
.fail-context .cell {
  background: var(--bg-canvas); padding: 12px 14px;
  display: flex; flex-direction: column; gap: 5px; min-width: 0;
}
.fail-context .cell.danger { background: var(--bg-sunken); }
.fail-context .cell .l {
  font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 0.16em;
  text-transform: uppercase; font-weight: 700; color: var(--fg-3);
}
.fail-context .cell.danger .l { color: var(--status-fail); }
.fail-context .cell .v {
  font-family: var(--font-ui); font-size: 14px; color: var(--fg-1); font-weight: 500;
}
.fail-context .cell .v code { font-family: var(--font-mono); color: var(--ember-08); }
.fail-context .cell .s {
  font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-3); line-height: 1.4;
}

/* ---- split row: recovery chat (left) + cards (right) ---- */
.recovery-split {
  display: grid; grid-template-columns: 1.3fr 1fr; gap: 12px;
  align-items: start; margin-bottom: 16px;
}
@media (max-width: 980px) { .recovery-split { grid-template-columns: 1fr; } }

.recovery-chat {
  border: 1px solid var(--line-1); background: var(--bg-canvas);
  display: flex; flex-direction: column; min-height: 360px;
}
.recovery-chat .chat-head {
  padding: 10px 14px; border-bottom: 1px solid var(--line-1);
  display: flex; align-items: baseline; gap: 10px;
}
.recovery-chat .chat-head .t {
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.2em;
  text-transform: uppercase; font-weight: 700; color: var(--ember-08);
}
.recovery-chat .chat-head .m { font-family: var(--font-mono); font-size: 10px; color: var(--fg-3); }
.recovery-chat .turns { display: flex; flex-direction: column; gap: 12px; padding: 14px; }
.recovery-chat .turn {
  font-family: var(--font-ui); font-size: 13px; line-height: 1.55; color: var(--fg-2);
}
.recovery-chat .turn b { color: var(--fg-1); }
.recovery-chat .turn .fail { color: var(--status-fail); }
.recovery-chat .turn .ember { color: var(--ember-08); }
.recovery-chat .rec-inline {
  margin-top: 10px; padding: 12px; border: 1px solid var(--line-hot);
  background: var(--accent-tint); display: flex; flex-direction: column; gap: 6px;
}
.recovery-chat .rec-inline .h {
  font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 0.16em;
  text-transform: uppercase; font-weight: 700; color: var(--ember-08);
}
.recovery-chat .chat-hint {
  margin-top: auto; padding: 10px 14px; border-top: 1px solid var(--line-1);
  font-family: var(--font-mono); font-size: 11px; color: var(--fg-3);
}
.recovery-chat .chat-hint .fail { color: var(--status-fail); }

/* ---- recovery cards (right rail) ---- */
.recovery-rail { display: flex; flex-direction: column; gap: 10px; }
.recovery-rail .rail-head {
  font-family: var(--font-mono); font-size: 9px; color: var(--ember-08);
  letter-spacing: 0.22em; text-transform: uppercase; font-weight: 700;
}
.recovery-card {
  position: relative; border: 1px solid var(--line-1); background: var(--bg-canvas);
  padding: 14px; display: flex; flex-direction: column; gap: 6px;
}
.recovery-card.recommended { border-color: var(--line-hot); }
.recovery-card.last-resort { background: var(--bg-sunken); }
.recovery-card .rec-tape {
  position: absolute; top: -1px; right: -1px;
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-12);
  background: var(--ember-08); padding: 2px 8px;
}
.recovery-card .lbl {
  font-family: var(--font-ui); font-size: 14px; font-weight: 600; color: var(--fg-1);
}
.recovery-card.last-resort .lbl { color: var(--status-fail); }
.recovery-card .t {
  font-family: var(--font-mono); font-size: 10.5px; color: var(--ember-08);
  letter-spacing: 0.04em;
}
.recovery-card .det {
  font-family: var(--font-ui); font-size: 12px; color: var(--fg-3); line-height: 1.5;
}
.recovery-card .det code {
  font-family: var(--font-mono); color: var(--ember-07); background: var(--bg-sunken);
  padding: 0 4px; border: 1px solid var(--line-1); font-size: 11px;
}
.recovery-card .card-actions { display: flex; gap: 6px; align-items: center; margin-top: 4px; flex-wrap: wrap; }
.recovery-card form { display: contents; }
.recovery-card textarea {
  width: 100%; min-height: 64px; resize: vertical; margin-top: 4px;
  padding: 8px 10px; background: var(--bg-sunken); border: 1px dashed var(--line-2);
  font-family: var(--font-mono); font-size: 11px; color: var(--fg-1); border-radius: 2px;
}
.recovery-card .commit-pick {
  flex: 1; min-width: 140px; padding: 5px 9px; background: var(--bg-sunken);
  border: 1px solid var(--line-1); font-family: var(--font-mono); font-size: 11px;
  color: var(--fg-1); border-radius: 2px;
}
.recovery-card .disabled-note {
  font-family: var(--font-mono); font-size: 10px; color: var(--fg-3); font-style: italic;
}
.recovery-card .last-resort-row {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
}
.recovery-card .last-resort-note {
  font-family: var(--font-mono); font-size: 9.5px; color: var(--fg-3); line-height: 1.4;
}

.btn {
  font-family: var(--font-mono); font-size: 11px; font-weight: 600; cursor: pointer;
  padding: 6px 11px; border: 1px solid var(--line-1); background: var(--bg-canvas);
  color: var(--fg-1); border-radius: 2px;
}
.btn:hover { border-color: var(--ember-08); }
.btn.primary { background: var(--ember-08); color: var(--ink-12); border-color: var(--ember-08); }
.btn.ghost { background: transparent; border-color: transparent; color: var(--fg-2); }
.btn.danger { color: var(--status-fail); border-color: var(--status-fail); }
.btn[disabled] { opacity: 0.45; cursor: not-allowed; }

/* ---- dag impact strip (flat list in Phase 2) ---- */
.dag-impact { border: 1px solid var(--line-1); background: var(--bg-canvas); padding: 14px; }
.dag-impact .head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
.dag-impact .head .lbl {
  font-family: var(--font-mono); font-size: 9px; color: var(--ember-08);
  letter-spacing: 0.22em; text-transform: uppercase; font-weight: 700;
}
.dag-impact .head .meta { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-3); }
.dag-impact .track { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.dag-impact .node {
  font-family: var(--font-mono); font-size: 11px; padding: 5px 10px;
  border: 1px solid var(--line-1); color: var(--fg-2); border-radius: 2px;
}
.dag-impact .node.halted { border-color: var(--status-fail); color: var(--status-fail); background: var(--bg-sunken); }
.dag-impact .node.old { opacity: 0.55; }
.dag-impact .sep { color: var(--fg-3); font-family: var(--font-mono); }
.dag-impact .sep.fail { color: var(--status-fail); }

/* ---- recovery action acknowledgement ---- */
.recovery-ack { border: 1px solid var(--line-hot); background: var(--accent-tint); padding: 16px; }
.recovery-ack.fail { border-color: var(--status-fail); background: var(--bg-sunken); }
.recovery-ack .h { font-family: var(--font-ui); font-size: 15px; font-weight: 600; color: var(--fg-1); margin-bottom: 6px; }
.recovery-ack .b { font-family: var(--font-ui); font-size: 13px; color: var(--fg-2); line-height: 1.55; }
.recovery-ack a { color: var(--ember-08); }
`;
