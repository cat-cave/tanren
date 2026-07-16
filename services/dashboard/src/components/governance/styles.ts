/** Screen-local CSS for the audit-posture safety settings surface. */
export const GOVERNANCE_SCREEN_CSS = String.raw`
.governance-screen { display: grid; gap: 14px; }
.governance-screen .panel {
  border: 1px solid var(--border-1);
  background: var(--bg-1);
  border-radius: 8px;
  overflow: hidden;
}
.governance-screen .panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-1);
}
.governance-screen .panel-head h2 { margin: 0; font: 600 14px/1.3 var(--font-ui); }
.governance-screen .panel-head .meta { color: var(--fg-3); font: 11px/1.3 var(--font-mono); }
.governance-screen .panel-body { padding: 16px; }
.governance-screen .project-picker {
  display: flex;
  align-items: end;
  gap: 10px;
  flex-wrap: wrap;
}
.governance-screen .field { display: grid; gap: 6px; min-width: 180px; }
.governance-screen .field.grow { flex: 1; }
.governance-screen label { color: var(--fg-2); font: 600 11px/1.2 var(--font-ui); }
.governance-screen select {
  width: 100%;
  min-height: 38px;
  padding: 8px 10px;
  color: var(--fg-1);
  background: var(--bg-2);
  border: 1px solid var(--border-2);
  border-radius: 5px;
  font: 12px/1.2 var(--font-mono);
}
.governance-screen .btn {
  min-height: 38px;
  padding: 8px 13px;
  border: 1px solid var(--border-2);
  border-radius: 5px;
  color: var(--fg-1);
  background: var(--bg-2);
  cursor: pointer;
  font: 600 11px/1 var(--font-ui);
}
.governance-screen .btn.primary { border-color: var(--ember-07); color: var(--ember-09); }
.governance-screen .flash {
  padding: 11px 13px;
  border: 1px solid var(--border-2);
  border-radius: 6px;
  font: 12px/1.45 var(--font-ui);
}
.governance-screen .flash.ok { border-color: var(--status-ok); color: var(--status-ok); }
.governance-screen .flash.err { border-color: var(--status-danger); color: var(--status-danger); }
.governance-screen .posture-current {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}
.governance-screen .current-card {
  display: grid;
  gap: 5px;
  padding: 12px;
  border: 1px solid var(--border-1);
  border-radius: 6px;
  background: var(--bg-2);
}
.governance-screen .current-card .key { color: var(--fg-3); font: 10px/1.2 var(--font-mono); }
.governance-screen .current-card .value { color: var(--fg-1); font: 600 14px/1.2 var(--font-mono); }
.governance-screen .posture-form { display: grid; gap: 14px; }
.governance-screen .form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.governance-screen .check-row {
  display: flex;
  align-items: start;
  gap: 9px;
  padding: 12px;
  border: 1px solid var(--border-1);
  border-radius: 6px;
}
.governance-screen .check-row input { margin-top: 2px; }
.governance-screen .check-row .copy { display: grid; gap: 4px; }
.governance-screen .check-row .detail,
.governance-screen .note,
.governance-screen .empty { color: var(--fg-3); font: 11.5px/1.5 var(--font-ui); }
.governance-screen .actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.governance-screen .context-line { color: var(--fg-3); font: 11px/1.5 var(--font-mono); }
@media (max-width: 760px) {
  .governance-screen .posture-current,
  .governance-screen .form-grid { grid-template-columns: 1fr; }
}
`;
