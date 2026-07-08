/**
 * Overview command-deck screen-scoped CSS. Owned under `components/overview`
 * (NOT shell.css); emitted as `<style data-screen="overview">`. Tokens only;
 * namespaced under `.overview-screen`.
 */

export const OVERVIEW_SCREEN_CSS = `
.overview-screen {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-family: var(--font-ui);
}
.overview-screen .split-row {
  display: grid;
  grid-template-columns: 1.55fr 1fr;
  gap: 12px;
  min-height: 0;
  align-items: stretch;
}
@media (max-width: 960px) {
  .overview-screen .split-row { grid-template-columns: 1fr; }
}
.overview-screen .panel {
  border: 1px solid var(--line-1);
  border-radius: 10px;
  background: var(--bg-surface, var(--bg-canvas));
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.overview-screen .panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line-1);
  background: var(--bg-sunken);
}
.overview-screen .panel-head h3 {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 13px;
  color: var(--fg-1);
  margin: 0;
}
.overview-screen .panel-head h3 em {
  color: var(--ember-08);
  font-style: normal;
}
.overview-screen .panel-head .meta {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--fg-3);
}
.overview-screen .panel-pad {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}
.overview-screen .side-col {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

/* Projects grid */
.overview-screen .proj-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  align-content: start;
}
@media (max-width: 720px) {
  .overview-screen .proj-grid { grid-template-columns: 1fr; }
}
.overview-screen .proj-tile {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border: 1px solid var(--line-1);
  border-radius: 8px;
  background: var(--bg-sunken);
  text-decoration: none;
  color: inherit;
  transition: border-color 0.12s ease;
}
.overview-screen .proj-tile:hover { border-color: var(--ember-08, var(--line-2)); }
.overview-screen .proj-tile .name-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.overview-screen .proj-tile .name {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 15px;
  color: var(--fg-1);
  text-transform: lowercase;
  letter-spacing: -0.02em;
}
.overview-screen .proj-tile .repo {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--fg-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.overview-screen .proj-tile .meta-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--fg-2);
  padding-top: 4px;
  border-top: 1px solid var(--line-1);
}
.overview-screen .proj-tile .meta-row b { color: var(--fg-1); font-weight: 600; }
/* Budget gated-spend card */
.overview-screen .col-card {
  border: 1px solid var(--line-1);
  border-radius: 10px;
  background: var(--bg-surface, var(--bg-canvas));
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.overview-screen .col-card .h {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 13px;
  color: var(--fg-1);
}
.overview-screen .col-card .h em {
  color: var(--ember-08);
  font-style: normal;
}
.overview-screen .col-card .h .meta {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--fg-3);
  font-weight: 400;
}
.overview-screen .budget-line {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 8px;
  align-items: baseline;
}
.overview-screen .budget-line .spent {
  font-family: var(--font-mono);
  font-size: 28px;
  font-weight: 600;
  color: var(--fg-1);
  font-variant-numeric: tabular-nums;
}
.overview-screen .budget-line .spent.empty { color: var(--fg-4); }
.overview-screen .budget-line .of {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--fg-3);
}
.overview-screen .budget-line .pct {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ember-08);
}
.overview-screen .cap-bar {
  height: 6px;
  background: var(--bg-sunken);
  border: 1px solid var(--line-1);
  border-radius: 1px;
  position: relative;
  overflow: hidden;
}
.overview-screen .cap-bar .fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--ember-08);
}
.overview-screen .budget-subs {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 6px;
}
.overview-screen .budget-subs .sub-card {
  padding: 8px;
  background: var(--bg-sunken);
  border: 1px solid var(--line-1);
  border-radius: 2px;
}
.overview-screen .budget-subs .sub-card .l {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--fg-3);
  letter-spacing: 0.16em;
  text-transform: uppercase;
}
.overview-screen .budget-subs .sub-card .v {
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 600;
  color: var(--fg-1);
  margin-top: 2px;
}
.overview-screen .budget-subs .sub-card .v.empty { color: var(--fg-4); }
.overview-screen .budget-subs .sub-card .k {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--fg-3);
}
.overview-screen .link-out {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ember-08);
  text-decoration: none;
}
.overview-screen .link-out:hover { text-decoration: underline; }
.overview-screen .pause-note {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--status-warn, oklch(70% 0.16 75));
}

/* Forge card (honest empty — no org-wide forge API yet) */
.overview-screen .forge-card {
  border: 1px solid var(--line-1);
  border-radius: 10px;
  background: var(--bg-surface, var(--bg-canvas));
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.overview-screen .forge-card .head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.overview-screen .forge-card .stamp {
  font-family: var(--font-display);
  color: var(--ember-08);
  font-size: 14px;
}
.overview-screen .forge-card .title {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 13px;
  color: var(--fg-1);
}
.overview-screen .forge-card .title em {
  color: var(--ember-08);
  font-style: normal;
}
.overview-screen .forge-card .meta {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--fg-3);
}
.overview-screen .forge-card .prompt {
  padding: 8px 10px;
  background: var(--bg-sunken);
  border: 1px solid var(--line-1);
  font-family: var(--font-ui);
  font-size: 12px;
  color: var(--fg-3);
  border-radius: 2px;
}
.overview-screen .forge-card .prompt .cue {
  color: var(--ember-08);
  margin-right: 8px;
}

/* Activity feed */
.overview-screen .activity-rows {
  display: flex;
  flex-direction: column;
  gap: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.55;
  max-height: 280px;
  overflow: auto;
}
.overview-screen .activity-row {
  display: grid;
  grid-template-columns: 36px 1.1fr 2.4fr;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--line-1);
  text-decoration: none;
  color: inherit;
}
.overview-screen .activity-row:last-child { border-bottom: none; }
.overview-screen .activity-row .ts { color: var(--fg-3); }
.overview-screen .activity-row .proj { color: var(--ember-08); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.overview-screen .activity-row .ev { color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.overview-screen .activity-row .ev.warn { color: var(--status-warn, oklch(70% 0.16 75)); }
.overview-screen .activity-row .ev.ok { color: var(--status-ok, oklch(58% 0.18 155)); }
.overview-screen .activity-row .ev.run { color: var(--ember-08); }

.overview-screen .empty {
  font-family: var(--font-ui);
  font-size: 12.5px;
  color: var(--fg-3);
  padding: 8px 0;
  line-height: 1.45;
}
.overview-screen .empty b { color: var(--fg-2); font-weight: 600; }
.overview-screen .kpi-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
}
.overview-screen .kpi {
  border: 1px solid var(--line-1);
  border-radius: 8px;
  background: var(--bg-surface, var(--bg-canvas));
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.overview-screen .kpi .k {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--fg-3);
  font-weight: 700;
}
.overview-screen .kpi .v {
  font-family: var(--font-mono);
  font-size: 20px;
  font-weight: 600;
  color: var(--fg-1);
  font-variant-numeric: tabular-nums;
}
.overview-screen .kpi .v.empty { color: var(--fg-4); }
.overview-screen .kpi.warn .v { color: var(--status-warn, oklch(70% 0.16 75)); }
.overview-screen .head-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.overview-screen .btn-ghost {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-2);
  border: 1px solid var(--line-1);
  background: transparent;
  border-radius: 6px;
  padding: 6px 10px;
  text-decoration: none;
}
.overview-screen .btn-ghost:hover { border-color: var(--ember-08, var(--line-2)); color: var(--fg-1); }
`;
