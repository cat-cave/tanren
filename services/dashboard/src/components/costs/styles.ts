/**
 * P2B-0005 screen-scoped CSS. Lives in the owned costs subtree (NOT shell.css)
 * and is emitted as a `<style data-screen="costs">` block by the costs/history
 * bodies. Every color is a design token (P2A-0016) — no hardcoded palette.
 * Class names are namespaced under `.costs-screen` / `.history-screen` so they
 * never collide with shell chrome classes.
 */

export const COSTS_SCREEN_CSS = `
.costs-screen, .history-screen {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-family: var(--font-ui);
}
.costs-screen .panel, .history-screen .panel {
  border: 1px solid var(--line-1);
  border-radius: 10px;
  background: var(--bg-surface, var(--bg-canvas));
  display: flex;
  flex-direction: column;
}
.costs-screen .panel-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line-1);
}
.costs-screen .panel-head h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--fg-1);
}
.costs-screen .panel-head h3 em { color: var(--ember-08); font-style: normal; }
.costs-screen .panel-head .meta {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--fg-3);
}

/* Date-range filter pills + actions */
.costs-screen .filters, .history-screen .filters {
  display: flex;
  align-items: center;
  gap: 8px;
}
.costs-screen .pill, .history-screen .pill {
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--line-1);
  color: var(--fg-3);
  text-decoration: none;
}
.costs-screen .pill.hot, .history-screen .pill.hot {
  color: var(--accent-on);
  background: var(--ember-08);
  border-color: var(--ember-08);
}
.costs-screen .btn, .history-screen .btn {
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid var(--line-2);
  background: transparent;
  color: var(--fg-2);
  text-decoration: none;
  cursor: pointer;
}

/* Total spend header */
.costs-screen .total-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 14px 18px 0;
}
.costs-screen .total-figs { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
.costs-screen .total-eyebrow {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--ember-08);
  letter-spacing: 0.22em;
  text-transform: uppercase;
  font-weight: 700;
}
.costs-screen .total-amount {
  font-family: var(--font-mono);
  font-size: 32px;
  color: var(--fg-1);
  font-weight: 600;
  letter-spacing: -0.025em;
  font-variant-numeric: tabular-nums;
}
.costs-screen .total-note { font-family: var(--font-mono); font-size: 11px; color: var(--status-ok); }
.costs-screen .total-scope { font-family: var(--font-mono); font-size: 10px; color: var(--fg-3); }

/* Stacked source bar */
.costs-screen .cost-stacked {
  display: flex;
  height: 22px;
  border-radius: 6px;
  overflow: hidden;
  margin: 8px 18px 0;
  background: var(--line-1);
}
.costs-screen .cost-stacked > span {
  display: block;
  min-width: 2px;
}
.costs-screen .cost-stacked .seg-label {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--ink-12);
  font-weight: 700;
  padding: 0 6px;
  line-height: 22px;
}

/* Source cards */
.costs-screen .source-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
  padding: 12px 18px 16px;
}
.costs-screen .source-card {
  border: 1px solid var(--line-1);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.costs-screen .source-card .top { display: flex; align-items: center; gap: 6px; }
.costs-screen .source-card .swatch { width: 8px; height: 8px; border-radius: 2px; }
.costs-screen .source-card .l { font-family: var(--font-mono); font-size: 10px; font-weight: 700; letter-spacing: 0.04em; }
.costs-screen .source-card .v { font-family: var(--font-mono); font-size: 18px; color: var(--fg-1); font-weight: 600; }
.costs-screen .source-card .k { font-family: var(--font-ui); font-size: 11px; color: var(--fg-3); line-height: 1.35; }
.costs-screen .source-card .basis { font-family: var(--font-mono); font-size: 9.5px; color: var(--fg-4); }

/* Two-column split */
.costs-screen .split-row {
  display: grid;
  grid-template-columns: 1.3fr 1fr;
  gap: 14px;
  align-items: start;
}
@media (max-width: 920px) {
  .costs-screen .split-row { grid-template-columns: 1fr; }
}
.costs-screen .scroll-col { display: flex; flex-direction: column; gap: 14px; }

/* Provider breakdown table */
.costs-screen .cost-table-head, .costs-screen .cost-table-row {
  display: grid;
  grid-template-columns: 1fr 56px 72px 96px 64px;
  gap: 8px;
  align-items: center;
  padding: 8px 16px;
}
.costs-screen .cost-table-head {
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--fg-3);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  border-bottom: 1px solid var(--line-1);
}
.costs-screen .cost-table-row { border-bottom: 1px solid var(--line-1); font-size: 12px; }
.costs-screen .cost-table-row:last-child { border-bottom: none; }
.costs-screen .cost-table-row .label { display: flex; align-items: center; gap: 8px; min-width: 0; }
.costs-screen .cost-table-row .label .triple { color: var(--fg-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.costs-screen .cost-table-row .label .basis-tag {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--fg-3);
}
.costs-screen .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.costs-screen .num { font-family: var(--font-mono); text-align: right; color: var(--fg-2); font-variant-numeric: tabular-nums; }
.costs-screen .num.hi { color: var(--fg-1); }
.costs-screen .num.unpriced { color: var(--fg-4); }

/* Burn sparkline */
.costs-screen .spark { display: flex; align-items: flex-end; gap: 2px; height: 44px; }
.costs-screen .spark > span { flex: 1; border-radius: 1px 1px 0 0; min-height: 2px; background: var(--cost-token); display: block; }
.costs-screen .kv {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-1);
}
.costs-screen .kv .k { color: var(--fg-3); }
.costs-screen .panel-pad { padding: 12px 16px; gap: 8px; display: flex; flex-direction: column; }
.costs-screen .mini-eyebrow {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  font-weight: 700;
  color: var(--fg-3);
}
.costs-screen .mini-eyebrow.ok { color: var(--status-ok); }
.costs-screen .hairline-top { padding-top: 8px; border-top: 1px solid var(--line-1); }
.costs-screen .note { font-family: var(--font-ui); font-size: 11px; color: var(--fg-2); line-height: 1.4; }
.costs-screen .empty {
  padding: 24px 18px;
  font-family: var(--font-ui);
  font-size: 13px;
  color: var(--fg-3);
}

/* History list */
.history-screen .run-table-head, .history-screen .run-row {
  display: grid;
  grid-template-columns: 1.4fr 110px 90px 96px 110px 90px;
  gap: 10px;
  align-items: center;
  padding: 10px 16px;
}
.history-screen .run-table-head {
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--fg-3);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  border-bottom: 1px solid var(--line-1);
}
.history-screen .run-row { border-bottom: 1px solid var(--line-1); font-size: 12px; text-decoration: none; color: inherit; }
.history-screen .run-row:last-child { border-bottom: none; }
.history-screen .run-row:hover { background: var(--line-1); }
.history-screen .run-row .spec { color: var(--fg-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.history-screen .run-row .sub { font-family: var(--font-mono); font-size: 9.5px; color: var(--fg-3); }
.history-screen .badge {
  font-family: var(--font-mono);
  font-size: 9.5px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--line-2);
  color: var(--fg-2);
  display: inline-block;
}
.history-screen .badge.review { color: var(--ember-08); border-color: var(--ember-08); }
.history-screen .badge.halted { color: var(--status-fail); border-color: var(--status-fail); }
.history-screen .badge.ok { color: var(--status-ok); border-color: var(--status-ok); }
.history-screen .num { font-family: var(--font-mono); text-align: right; font-variant-numeric: tabular-nums; color: var(--fg-2); }
.history-screen .empty { padding: 24px 18px; font-family: var(--font-ui); font-size: 13px; color: var(--fg-3); }
`;
