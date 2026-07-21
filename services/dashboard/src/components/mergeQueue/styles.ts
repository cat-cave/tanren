/**
 * Merge-queue panel screen-scoped CSS. Lives in the owned
 * `components/mergeQueue` subtree (NOT shell.css) and is emitted as a
 * `<style data-screen="merge-queue">` block by the body. Every color is a design
 * token — no hardcoded palette. Class names are namespaced under
 * `.merge-queue-screen` so they never collide with shell chrome or other screens.
 * Deliberately mirrors the DORA panel's tokens/scale for a consistent metrics look.
 */

export const MERGE_QUEUE_SCREEN_CSS = `
.merge-queue-screen {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-family: var(--font-ui);
}
.merge-queue-screen .panel {
  border: 1px solid var(--line-1);
  border-radius: 10px;
  background: var(--bg-surface, var(--bg-canvas));
  display: flex;
  flex-direction: column;
}
.merge-queue-screen .panel-pad { padding: 14px 18px; gap: 10px; display: flex; flex-direction: column; }
.merge-queue-screen .mini-eyebrow {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  font-weight: 700;
  color: var(--fg-3);
}

/* Headline verdict line for rebase vs rebuild */
.merge-queue-screen .verdict {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.merge-queue-screen .verdict.cheaper { color: var(--ember-08); }
.merge-queue-screen .verdict.neutral { color: var(--fg-3); }

/* Stat grid (shared by both panels) */
.merge-queue-screen .mq-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}
.merge-queue-screen .mq-card {
  border: 1px solid var(--line-1);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.merge-queue-screen .mq-card .label {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-weight: 700;
  color: var(--fg-3);
}
.merge-queue-screen .mq-card .value {
  font-family: var(--font-mono);
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--fg-1);
  font-variant-numeric: tabular-nums;
}
.merge-queue-screen .mq-card .value.empty { color: var(--fg-4); }
.merge-queue-screen .mq-card .sub { font-family: var(--font-ui); font-size: 11px; color: var(--fg-3); line-height: 1.35; }
.merge-queue-screen .mq-card .sample { font-family: var(--font-mono); font-size: 9.5px; color: var(--fg-4); }

.merge-queue-screen .note {
  font-family: var(--font-ui);
  font-size: 11.5px;
  color: var(--fg-2);
  line-height: 1.45;
  padding-top: 10px;
  border-top: 1px solid var(--line-1);
}
.merge-queue-screen .note b { color: var(--ember-08); }
.merge-queue-screen .window-tag { font-family: var(--font-mono); font-size: 10px; color: var(--fg-3); }
.merge-queue-screen .empty {
  padding: 24px 18px;
  font-family: var(--font-ui);
  font-size: 13px;
  color: var(--fg-3);
}
.merge-queue-screen .mq-policy-controls { display: flex; flex-wrap: wrap; gap: 8px; }
.merge-queue-screen .mq-policy-controls form { margin: 0; }
.merge-queue-screen .mq-policy-controls button { font: inherit; font-size: 11px; }
`;
