/**
 * Integration Control Center screen-scoped CSS. Owned by the
 * `components/integrationControl` subtree (NOT shell.css) and emitted as a
 * `<style data-screen="integration-control">` block by the body. Every color
 * is a design token — no hardcoded palette. Class names are namespaced under
 * `.integration-control-screen` so they never collide with shell chrome or
 * sibling panels.
 */

export const INTEGRATION_CONTROL_CSS = `
.integration-control-screen {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-family: var(--font-ui);
}
.integration-control-screen .panel {
  border: 1px solid var(--line-1);
  border-radius: 10px;
  background: var(--bg-surface, var(--bg-canvas));
  display: flex;
  flex-direction: column;
}
.integration-control-screen .panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 12px 18px;
  border-bottom: 1px solid var(--line-1);
}
.integration-control-screen .panel-head h2 {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
  color: var(--fg-1);
}
.integration-control-screen .panel-head .meta {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--fg-3);
  text-transform: uppercase;
  letter-spacing: 0.12em;
}
.integration-control-screen .panel-body {
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.integration-control-screen .state.unavailable {
  color: var(--color-danger, #f87171);
  border: 1px dashed var(--color-danger, #f87171);
  padding: 10px 12px;
  border-radius: 6px;
}
.integration-control-screen .state.empty {
  color: var(--fg-3);
  padding: 10px 12px;
  border: 1px dashed var(--line-1);
  border-radius: 6px;
}
.integration-control-screen .lifecycle-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}
.integration-control-screen .bucket {
  border: 1px solid var(--line-1);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.integration-control-screen .bucket-label {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--fg-3);
}
.integration-control-screen .bucket-total {
  font-size: 22px;
  font-weight: 700;
  color: var(--fg-1);
}
.integration-control-screen .bucket-detail {
  font-size: 11px;
  color: var(--fg-3);
}
.integration-control-screen .table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.integration-control-screen .table th {
  text-align: left;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--fg-3);
  padding: 6px 8px;
  border-bottom: 1px solid var(--line-1);
}
.integration-control-screen .table td {
  padding: 8px;
  border-bottom: 1px solid var(--line-1);
  vertical-align: top;
}
.integration-control-screen .table tr:last-child td {
  border-bottom: none;
}
.integration-control-screen .state-pill {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 12px;
  background: var(--bg-canvas);
  border: 1px solid var(--line-1);
  color: var(--fg-2);
}
.integration-control-screen .state-pill[data-integration-control-requirement-state="needs_attention"],
.integration-control-screen .state-pill[data-integration-control-capability-node-state="needs_attention"],
.integration-control-screen .state-pill[data-integration-control-binding-state="needs_attention"],
.integration-control-screen .state-pill[data-integration-control-binding-state="drifted"],
.integration-control-screen .state-pill[data-integration-control-delivery-run-state="needs_attention"],
.integration-control-screen .state-pill[data-integration-control-delivery-run-state="degraded"],
.integration-control-screen .state-pill[data-integration-control-delivery-stage-state="failed"] {
  color: var(--color-danger, #f87171);
  border-color: var(--color-danger, #f87171);
}
.integration-control-screen .state-pill[data-integration-control-capability-node-state="ready"],
.integration-control-screen .state-pill[data-integration-control-binding-state="ready"],
.integration-control-screen .state-pill[data-integration-control-delivery-run-state="completed"],
.integration-control-screen .state-pill[data-integration-control-delivery-stage-state="succeeded"] {
  color: var(--ember-08, #f2a65a);
  border-color: var(--ember-08, #f2a65a);
}
.integration-control-screen code.id,
.integration-control-screen code.hash {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-2);
  word-break: break-all;
}
.integration-control-screen .bindings-list,
.integration-control-screen .delivery-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.integration-control-screen .binding-card,
.integration-control-screen .delivery-card {
  border: 1px solid var(--line-1);
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.integration-control-screen .binding-card header,
.integration-control-screen .delivery-card header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.integration-control-screen .binding-id,
.integration-control-screen .delivery-id {
  display: flex;
  flex-direction: column;
}
.integration-control-screen .binding-meta,
.integration-control-screen .delivery-meta {
  font-size: 11px;
  color: var(--fg-3);
}
.integration-control-screen .binding-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 6px 12px;
}
.integration-control-screen .kv {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.integration-control-screen .kv-label {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--fg-3);
}
.integration-control-screen .kv-value {
  font-size: 12px;
  color: var(--fg-1);
}
.integration-control-screen .binding-generation {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px dashed var(--line-1);
  padding-top: 8px;
}
.integration-control-screen .env-proof {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--ember-08, #f2a65a);
  border-radius: 6px;
  background: var(--bg-canvas);
}
.integration-control-screen .env-proof .proof-label {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ember-08, #f2a65a);
  font-weight: 700;
}
.integration-control-screen .env-proof .proof-note {
  font-size: 11px;
  color: var(--fg-3);
}
.integration-control-screen .env-shape {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.integration-control-screen .proof-label {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--fg-3);
}
.integration-control-screen .env-shape ul,
.integration-control-screen .binding-refs ul,
.integration-control-screen .schema-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.integration-control-screen .env-shape li {
  font-size: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: baseline;
}
.integration-control-screen .env-shape .scopes {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--fg-3);
  margin-left: auto;
}
.integration-control-screen .stage-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-top: 1px dashed var(--line-1);
  padding-top: 8px;
}
.integration-control-screen .stage-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.integration-control-screen .stage-name {
  font-family: var(--font-mono);
  color: var(--fg-2);
  min-width: 180px;
}
.integration-control-screen .binding-refs ul {
  flex-direction: row;
  flex-wrap: wrap;
}
.integration-control-screen .binding-refs li {
  font-size: 11px;
  background: var(--bg-canvas);
  border: 1px solid var(--line-1);
  border-radius: 4px;
  padding: 2px 6px;
}
.integration-control-screen .muted {
  color: var(--fg-3);
}
.integration-control-screen .hint {
  font-size: 11px;
  color: var(--fg-3);
  margin: 0;
}
.integration-control-screen .schema-list li {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 4px 0;
  border-bottom: 1px dashed var(--line-1);
}
.integration-control-screen .schema-link {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ember-08, #f2a65a);
}
.integration-control-screen .btn {
  display: inline-block;
  border: 1px solid var(--line-1);
  background: var(--bg-canvas);
  color: var(--fg-1);
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 6px 10px;
  border-radius: 6px;
  text-decoration: none;
  letter-spacing: 0.06em;
  align-self: flex-start;
}
.integration-control-screen .btn.primary {
  border-color: var(--ember-08, #f2a65a);
  color: var(--ember-08, #f2a65a);
}
`;
