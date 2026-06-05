/**
 * Screen-scoped CSS for the onboarding / credentials / notifications
 * surfaces. The shell owns `shell.css`; child screens may not edit
 * it, so we ship our own token-driven styles inlined via a `<style>` tag (see
 * `OnbStyles`). Recreated from the hi-fi (`view-onboard-org.jsx`,
 * `view-onboard-existing.jsx`, `flows.jsx`, `styles.css`); token-only, no
 * hardcoded colors so ink/ash both work.
 */

export const ONBOARDING_CSS = `
.onb { display: flex; flex-direction: column; gap: 14px; }
.onb .journey {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding-bottom: 12px; border-bottom: 1px solid var(--line-1);
}
.onb .j-step {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 10px; border: 1px solid var(--line-1); border-radius: 2px;
  font-family: var(--font-mono); font-size: 11px; color: var(--fg-3);
  text-transform: lowercase; text-decoration: none;
}
.onb .j-step .num {
  width: 16px; height: 16px; display: flex; align-items: center;
  justify-content: center; border: 1px solid var(--line-2); border-radius: 2px;
  font-size: 9px; font-weight: 700;
}
.onb .j-step.done { color: var(--status-ok); border-color: var(--status-ok); }
.onb .j-step.done .num { background: var(--status-ok); color: var(--ink-12); border-color: var(--status-ok); }
.onb .j-step.live { color: var(--ember-08); border-color: var(--ember-08); background: var(--accent-tint); font-weight: 700; }
.onb .j-step.live .num { background: var(--ember-08); color: var(--ink-12); border-color: var(--ember-08); }
.onb .j-arrow { color: var(--line-2); font-family: var(--font-mono); }

.onb .step-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.onb .step-heading .eyebrow { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.22em; font-weight: 700; color: var(--ember-08); }
.onb .step-heading .title { font-family: var(--font-display); font-weight: 700; font-size: 24px; letter-spacing: -0.028em; line-height: 1.1; text-transform: lowercase; color: var(--fg-1); margin-top: 4px; max-width: 720px; }
.onb .step-heading .title em { font-style: italic; color: var(--ember-08); }
.onb .step-heading .sub { font-family: var(--font-ui); font-size: 13px; color: var(--fg-2); line-height: 1.5; margin-top: 8px; max-width: 760px; }

.onb .cols-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }
.onb .cols-2-1 { display: grid; grid-template-columns: 2fr 1fr; gap: 14px; align-items: start; }
.onb .cols-narrow { display: grid; grid-template-columns: 1fr 1.6fr; gap: 14px; align-items: start; }

.onb .col-card {
  display: flex; flex-direction: column; gap: 10px;
  background: var(--bg-surface); border: 1px solid var(--line-1);
  border-radius: 3px; padding: 14px;
}
.onb .col-card.live { border-color: var(--ember-08); }
.onb .col-card .h { display: flex; align-items: center; gap: 8px; font-family: var(--font-display); font-weight: 700; font-size: 14px; text-transform: lowercase; color: var(--fg-1); }
.onb .col-card .h em { font-style: italic; color: var(--ember-08); }
.onb .display-h { font-family: var(--font-display); font-weight: 700; font-size: 15px; letter-spacing: -0.02em; text-transform: lowercase; color: var(--fg-1); }
.onb .display-h em { font-style: italic; color: var(--ember-08); }

.onb .sunken { background: var(--bg-sunken); border: 1px solid var(--line-1); border-radius: 2px; padding: 12px; }
.onb .mono { font-family: var(--font-mono); font-size: 11px; color: var(--fg-1); line-height: 1.6; }
.onb .mono-dim { font-family: var(--font-mono); font-size: 10px; color: var(--fg-3); }
.onb .section-label { font-family: var(--font-mono); font-size: 9px; color: var(--fg-3); letter-spacing: 0.22em; text-transform: uppercase; font-weight: 700; }

.onb .pill { display: inline-flex; align-items: center; gap: 5px; font-family: var(--font-mono); font-size: 9px; padding: 2px 6px; border-radius: 2px; white-space: nowrap; }
.onb .pill .d { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.onb .pill.ok { color: var(--status-ok); }
.onb .pill.warn { color: var(--status-warn); }
.onb .pill.fail { color: var(--status-fail); }
.onb .pill.hot { color: var(--ember-08); background: var(--accent-tint); }
.onb .pill.cold { color: var(--fg-3); }

.onb .btn {
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  font-family: var(--font-mono); font-size: 11px; padding: 7px 12px;
  border: 1px solid var(--line-1); background: transparent; color: var(--fg-1);
  border-radius: 2px; text-decoration: none;
}
.onb .btn:hover { border-color: var(--fg-3); }
.onb .btn.ghost { border-color: transparent; color: var(--fg-2); }
.onb .btn.primary { background: var(--ember-08); border-color: var(--ember-08); color: var(--ink-12); font-weight: 700; }
.onb .btn.primary:hover { background: var(--ember-09); border-color: var(--ember-09); }
.onb .btn.danger { color: var(--status-fail); border-color: var(--line-1); }
.onb .btn:disabled { opacity: 0.4; cursor: not-allowed; }

.onb .field { display: flex; flex-direction: column; gap: 4px; }
.onb .field label { font-family: var(--font-mono); font-size: 9.5px; color: var(--fg-3); letter-spacing: 0.16em; text-transform: uppercase; }
.onb .field input, .onb .field select {
  font-family: var(--font-mono); font-size: 12px; color: var(--fg-1);
  background: var(--bg-canvas); border: 1px solid var(--line-1);
  border-radius: 2px; padding: 8px 10px; width: 100%;
}
.onb .field input::placeholder { color: var(--fg-4); }
.onb .field .hint { font-family: var(--font-mono); font-size: 9.5px; color: var(--fg-3); line-height: 1.4; }
.onb .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }

.onb .toggle { position: relative; width: 30px; height: 16px; border-radius: 9px; flex-shrink: 0; border: none; cursor: pointer; padding: 0; }
.onb .toggle.on { background: var(--ember-08); }
.onb .toggle.off { background: var(--line-2); }
.onb .toggle .knob { position: absolute; top: 1px; width: 14px; height: 14px; border-radius: 50%; background: var(--ink-12); transition: left var(--dur-fast) var(--ease-out); }
.onb .toggle.on .knob { left: 15px; }
.onb .toggle.off .knob { left: 1px; background: var(--fg-3); }

.onb .phase-badge { font-family: var(--font-mono); font-size: 8px; letter-spacing: 0.14em; text-transform: uppercase; padding: 1px 5px; border: 1px solid var(--line-2); border-radius: 2px; color: var(--fg-3); }
.onb .phase-badge.phase-v0 { color: var(--status-ok); border-color: var(--status-ok); }
.onb .phase-badge.phase-p3, .onb .phase-badge.phase-p4 { color: var(--steel-08); border-color: var(--steel-08); }

.onb .status-badge { font-family: var(--font-mono); font-size: 9px; padding: 2px 6px; border-radius: 2px; }
.onb .status-badge.status-on { color: var(--status-ok); }
.onb .status-badge.status-warn { color: var(--status-warn); }
.onb .status-badge.status-off { color: var(--fg-3); }

.onb .row-card { display: grid; grid-template-columns: auto 1fr auto auto auto; align-items: center; gap: 10px; padding: 9px 11px; background: var(--bg-sunken); border: 1px solid var(--line-1); border-radius: 2px; }
.onb .row-card.on { border-color: var(--ember-08); }
.onb .row-card .glyph { font-family: var(--font-mono); font-size: 14px; color: var(--fg-2); width: 18px; text-align: center; }
.onb .row-card .name { font-family: var(--font-mono); font-size: 12px; color: var(--fg-1); }
.onb .row-card .desc { font-family: var(--font-mono); font-size: 9.5px; color: var(--fg-3); }
.onb .row-card .unwired { font-family: var(--font-mono); font-size: 9px; color: var(--status-warn); margin-top: 2px; }

.onb .matrix-head, .onb .matrix-row { display: grid; grid-template-columns: 1.6fr repeat(var(--matrix-cols, 1), 0.7fr) 0.6fr; align-items: center; gap: 6px; padding: 7px 12px; }
.onb .matrix-head { border-bottom: 1px solid var(--line-1); font-family: var(--font-mono); font-size: 9px; color: var(--fg-3); letter-spacing: 0.16em; text-transform: uppercase; }
.onb .matrix-row { border-bottom: 1px solid var(--line-1); font-family: var(--font-mono); font-size: 11px; color: var(--fg-1); }
.onb .matrix-cell { display: flex; align-items: center; justify-content: center; }
.onb .matrix-check { width: 18px; height: 18px; border: 1px solid var(--line-2); border-radius: 2px; background: transparent; cursor: pointer; color: transparent; font-size: 11px; }
.onb .matrix-check.on { background: var(--ember-08); border-color: var(--ember-08); color: var(--ink-12); }
.onb .matrix-check.override.on { background: var(--steel-08); border-color: var(--steel-08); }
.onb .matrix-sev { font-family: var(--font-mono); font-size: 9px; text-align: center; }
.onb .matrix-sev.ok { color: var(--status-ok); }
.onb .matrix-sev.info { color: var(--steel-08); }
.onb .matrix-sev.warn { color: var(--status-warn); }
.onb .matrix-sev.fail { color: var(--status-fail); }

.onb .arrival-card { position: relative; overflow: hidden; padding: 18px; border: 1px solid var(--ember-08); border-radius: 3px; background: var(--accent-tint); display: flex; flex-direction: column; gap: 8px; }
.onb .arrival-card .kanji-bg { position: absolute; right: 8px; top: -14px; font-family: var(--font-jp); font-size: 90px; color: var(--ember-08); opacity: 0.12; pointer-events: none; }
.onb .arrival-card .eyebrow { font-family: var(--font-mono); font-size: 10px; color: var(--ember-08); letter-spacing: 0.18em; text-transform: uppercase; font-weight: 700; }
.onb .arrival-card .display { font-family: var(--font-display); font-weight: 800; font-size: 26px; letter-spacing: -0.03em; text-transform: lowercase; color: var(--fg-1); }
.onb .arrival-card .actions { display: flex; gap: 8px; margin-top: 4px; }

.onb .alert { padding: 10px 12px; border: 1px solid; border-radius: 2px; font-family: var(--font-ui); font-size: 12px; line-height: 1.45; }
.onb .alert.ok { color: var(--status-ok); border-color: var(--status-ok); background: var(--bg-sunken); }
.onb .alert.warn { color: var(--status-warn); border-color: var(--status-warn); background: var(--bg-sunken); }
.onb .alert.fail { color: var(--status-fail); border-color: var(--status-fail); background: var(--bg-sunken); }

.onb .scope-list { display: flex; flex-direction: column; gap: 5px; list-style: none; margin: 0; padding: 0; font-family: var(--font-mono); font-size: 11px; }
.onb .scope-list li { color: var(--fg-1); }
.onb .scope-list li.never { color: var(--fg-3); }
.onb .scope-list .g { margin-right: 8px; font-weight: 700; }

.onb .repo-row { display: grid; grid-template-columns: 16px 1fr auto; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--line-1); border-left: 2px solid transparent; cursor: pointer; }
.onb .repo-row.selected { background: var(--accent-tint); border-left-color: var(--ember-08); }
.onb .repo-row .radio { width: 14px; height: 14px; border: 1.5px solid var(--line-2); border-radius: 2px; }
.onb .repo-row.selected .radio { background: var(--ember-08); border-color: var(--ember-08); }
.onb .repo-row .rname { font-family: var(--font-mono); font-size: 12.5px; color: var(--fg-1); display: flex; align-items: center; gap: 6px; }
.onb .repo-row .rdesc { font-family: var(--font-ui); font-size: 11px; color: var(--fg-3); margin-top: 1px; }
.onb .priv { font-family: var(--font-mono); font-size: 8.5px; color: var(--fg-3); letter-spacing: 0.16em; padding: 1px 4px; border: 1px solid var(--line-1); border-radius: 2px; }

.onb .foot { display: flex; align-items: center; gap: 12px; padding-top: 14px; border-top: 1px solid var(--line-1); margin-top: 6px; }
.onb .foot .hint { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-3); }
.onb .foot .grow { flex: 1; }
`;

/** Inline the screen CSS once per page (child screens can't edit shell.css). */
export function OnbStyles() {
  return <style dangerouslySetInnerHTML={{ __html: ONBOARDING_CSS }} />;
}
