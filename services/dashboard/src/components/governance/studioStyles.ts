/** Screen-local styles for the Governance Studio fact and command panels. */
export const GOVERNANCE_STUDIO_CSS = String.raw`
.governance-studio { display: grid; gap: 14px; }
.governance-studio .studio-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.governance-studio .panel { border: 1px solid var(--border-1); border-radius: 8px; background: var(--bg-1); overflow: hidden; }
.governance-studio .panel-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--border-1); }
.governance-studio .panel-head h2 { margin: 0; font: 600 14px/1.3 var(--font-ui); }
.governance-studio .panel-head .meta { color: var(--fg-3); font: 11px/1.3 var(--font-mono); }
.governance-studio .panel-body { padding: 16px; }
.governance-studio .project-picker, .governance-studio .receipt-form, .governance-studio .command-form { display: flex; align-items: end; gap: 10px; flex-wrap: wrap; }
.governance-studio .field { display: grid; gap: 6px; min-width: 150px; }
.governance-studio .field.grow { flex: 1; }
.governance-studio label { color: var(--fg-2); font: 600 11px/1.2 var(--font-ui); }
.governance-studio select, .governance-studio input, .governance-studio textarea { box-sizing: border-box; width: 100%; min-height: 38px; padding: 8px 10px; color: var(--fg-1); background: var(--bg-2); border: 1px solid var(--border-2); border-radius: 5px; font: 12px/1.35 var(--font-mono); }
.governance-studio textarea { min-height: 164px; resize: vertical; }
.governance-studio .btn { min-height: 36px; padding: 8px 12px; border: 1px solid var(--border-2); border-radius: 5px; color: var(--fg-1); background: var(--bg-2); cursor: pointer; font: 600 11px/1 var(--font-ui); }
.governance-studio .btn.primary { border-color: var(--ember-07); color: var(--ember-09); }
.governance-studio .btn.danger { border-color: var(--status-danger); color: var(--status-danger); }
.governance-studio .flash, .governance-studio .state { padding: 12px 14px; border: 1px solid var(--border-2); border-radius: 6px; font: 12px/1.5 var(--font-ui); }
.governance-studio .flash.ok { border-color: var(--status-ok); color: var(--status-ok); }
.governance-studio .flash.error, .governance-studio .state.unavailable { border-color: var(--status-danger); color: var(--status-danger); }
.governance-studio .flash.unknown, .governance-studio .state.not-found { border-color: var(--ember-07); color: var(--ember-09); }
.governance-studio .binding-state { display: grid; gap: 8px; }
.governance-studio .binding-state strong { font: 600 14px/1.2 var(--font-mono); }
.governance-studio .kv { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 8px; color: var(--fg-2); font: 11px/1.45 var(--font-mono); }
.governance-studio .kv span:last-child { color: var(--fg-1); overflow-wrap: anywhere; }
.governance-studio .table { width: 100%; border-collapse: collapse; font: 11px/1.4 var(--font-mono); }
.governance-studio .table th, .governance-studio .table td { padding: 9px 7px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border-1); overflow-wrap: anywhere; }
.governance-studio .table th { color: var(--fg-3); font-weight: 600; }
.governance-studio .inline { display: inline; }
.governance-studio .muted, .governance-studio .hint { color: var(--fg-3); font: 11.5px/1.5 var(--font-ui); }
.governance-studio .receipt-json { max-height: 320px; overflow: auto; margin: 12px 0 0; padding: 12px; border-radius: 5px; color: var(--fg-1); background: var(--bg-2); font: 11px/1.45 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 840px) { .governance-studio .studio-grid { grid-template-columns: 1fr; } .governance-studio .kv { grid-template-columns: 1fr; gap: 2px; } }
`;
