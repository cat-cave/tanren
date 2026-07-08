/**
 * Budget-halt panel screen-scoped CSS. Lives in the owned `components/budget`
 * subtree (NOT shell.css) and is emitted as a `<style data-screen="budget">`
 * block by the body. Every color is a design token — no hardcoded palette.
 * Class names are namespaced under `.budget-screen`.
 */

export const BUDGET_SCREEN_CSS = `
.budget-screen {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-family: var(--font-ui);
}
.budget-screen .panel {
  border: 1px solid var(--line-1);
  border-radius: 10px;
  background: var(--bg-surface, var(--bg-canvas));
  display: flex;
  flex-direction: column;
}
.budget-screen .panel-pad { padding: 14px 18px; gap: 10px; display: flex; flex-direction: column; }
.budget-screen .mini-eyebrow {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  font-weight: 700;
  color: var(--fg-3);
}

/* Halt banner when walker is paused on budget */
.budget-screen .halt-banner {
  border: 1px solid var(--ember-08, var(--line-2));
  border-radius: 8px;
  background: color-mix(in srgb, var(--ember-08, #c45) 12%, transparent);
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.budget-screen .halt-banner .halt-title {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ember-08, var(--fg-1));
}
.budget-screen .halt-banner .halt-sub {
  font-family: var(--font-ui);
  font-size: 12px;
  color: var(--fg-2);
  line-height: 1.4;
}

/* Metric cards */
.budget-screen .budget-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}
.budget-screen .budget-card {
  border: 1px solid var(--line-1);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.budget-screen .budget-card .label {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-weight: 700;
  color: var(--fg-3);
}
.budget-screen .budget-card .value {
  font-family: var(--font-mono);
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--fg-1);
  font-variant-numeric: tabular-nums;
}
.budget-screen .budget-card .value.empty { color: var(--fg-4); }
.budget-screen .budget-card .sub { font-family: var(--font-ui); font-size: 11px; color: var(--fg-3); line-height: 1.35; }

.budget-screen .note {
  font-family: var(--font-ui);
  font-size: 11.5px;
  color: var(--fg-2);
  line-height: 1.45;
  padding-top: 10px;
  border-top: 1px solid var(--line-1);
}
.budget-screen .note b { color: var(--ember-08); }
.budget-screen .empty {
  padding: 24px 18px;
  font-family: var(--font-ui);
  font-size: 13px;
  color: var(--fg-3);
}

/* Flash after form POST */
.budget-screen .flash {
  font-family: var(--font-ui);
  font-size: 12px;
  padding: 10px 14px;
  border-radius: 8px;
  border: 1px solid var(--line-1);
}
.budget-screen .flash.ok { color: var(--fg-1); border-color: var(--ember-08, var(--line-2)); }
.budget-screen .flash.err { color: var(--fg-1); border-color: var(--line-2); }

/* Config form */
.budget-screen .budget-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.budget-screen .form-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
}
.budget-screen .field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 140px;
}
.budget-screen .field label {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-weight: 700;
  color: var(--fg-3);
}
.budget-screen .field input,
.budget-screen .field select {
  font-family: var(--font-mono);
  font-size: 13px;
  padding: 8px 10px;
  border: 1px solid var(--line-1);
  border-radius: 6px;
  background: var(--bg-canvas, transparent);
  color: var(--fg-1);
}
.budget-screen .form-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.budget-screen .btn {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid var(--line-1);
  background: var(--bg-canvas, transparent);
  color: var(--fg-1);
  cursor: pointer;
}
.budget-screen .btn.primary {
  border-color: var(--ember-08, var(--line-2));
  color: var(--ember-08, var(--fg-1));
}
.budget-screen .org-default {
  font-family: var(--font-ui);
  font-size: 12px;
  color: var(--fg-3);
  line-height: 1.4;
}
.budget-screen .org-default b { color: var(--fg-2); font-weight: 600; }
`;
