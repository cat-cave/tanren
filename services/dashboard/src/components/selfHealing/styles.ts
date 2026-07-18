/**
 * Self-Healing screen-scoped CSS. Lives in the owned `components/selfHealing`
 * subtree (NOT shell.css) and is emitted as a `<style data-screen="self-healing">`
 * block by the bodies. Every color is a design token — no hardcoded palette.
 * Class names are namespaced under `.self-healing` so they never collide with the
 * shell chrome or other screens.
 */

export const SELF_HEALING_SCREEN_CSS = `
.self-healing {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-family: var(--font-ui);
}
.self-healing .panel {
  border: 1px solid var(--line-1);
  border-radius: 10px;
  background: var(--bg-surface, var(--bg-canvas));
  display: flex;
  flex-direction: column;
}
.self-healing .panel-pad { padding: 14px 18px; gap: 12px; display: flex; flex-direction: column; }
.self-healing .mini-eyebrow {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  font-weight: 700;
  color: var(--fg-3);
}
.self-healing .empty { color: var(--fg-3); font-size: 13px; line-height: 1.5; }

/* Funnel bars */
.self-healing .funnel { display: flex; flex-direction: column; gap: 6px; }
.self-healing .funnel-row {
  display: grid;
  grid-template-columns: 140px 1fr 48px;
  align-items: center;
  gap: 10px;
}
.self-healing .funnel-row .stage {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-2);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.self-healing .funnel-row .track {
  position: relative;
  height: 14px;
  border-radius: 7px;
  background: var(--line-1);
  overflow: hidden;
}
.self-healing .funnel-row .fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 7px;
  background: var(--accent-1, var(--fg-2));
}
.self-healing .funnel-row .count {
  font-family: var(--font-mono);
  font-size: 12px;
  text-align: right;
  color: var(--fg-1);
}
.self-healing .funnel-row.drop .stage { color: var(--danger, #d33); }

/* Loop table */
.self-healing table.loops { width: 100%; border-collapse: collapse; font-size: 12px; }
.self-healing table.loops th {
  text-align: left;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--fg-3);
  padding: 4px 8px;
  border-bottom: 1px solid var(--line-1);
}
.self-healing table.loops td { padding: 6px 8px; border-bottom: 1px solid var(--line-1); }
.self-healing table.loops a { color: var(--fg-1); text-decoration: none; }
.self-healing table.loops a:hover { text-decoration: underline; }

/* The six independent truth badges */
.self-healing .badges { display: flex; flex-wrap: wrap; gap: 8px; }
.self-healing .badge {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
  min-width: 92px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--line-1);
  background: var(--bg-canvas);
}
.self-healing .badge .b-label {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--fg-3);
}
.self-healing .badge .b-value { font-family: var(--font-mono); font-size: 12px; font-weight: 700; }
.self-healing .badge[data-tone="pass"] { border-color: var(--success, #2a7); }
.self-healing .badge[data-tone="pass"] .b-value { color: var(--success, #2a7); }
.self-healing .badge[data-tone="fail"] { border-color: var(--danger, #d33); }
.self-healing .badge[data-tone="fail"] .b-value { color: var(--danger, #d33); }
.self-healing .badge[data-tone="warn"] .b-value { color: var(--warning, #c80); }
.self-healing .badge[data-tone="absent"] .b-value { color: var(--fg-3); }

/* Causal chain */
.self-healing .chain { display: flex; flex-direction: column; gap: 8px; }
.self-healing .chain-node {
  border: 1px solid var(--line-1);
  border-radius: 8px;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.self-healing .chain-node .cn-kind {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--fg-3);
}
.self-healing .chain-node .cn-body { font-size: 12px; color: var(--fg-1); }
.self-healing .chain-node.symptom-failed { border-color: var(--danger, #d33); }
.self-healing .chain-arrow { color: var(--fg-3); font-family: var(--font-mono); text-align: center; }
.self-healing .tamper { color: var(--danger, #d33); font-family: var(--font-mono); font-size: 11px; }
`;
