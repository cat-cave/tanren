/**
 * P3-0016 brownfield full-track screen CSS. Layered ON TOP of the shared
 * P2B-0002 `OnbStyles` (which owns `.onb`, `.step-heading`, the journey strip,
 * `.col-card`, `.foot`, `.btn`, `.pill`). This adds only the brownfield-specific
 * bits: the recon chapter cards + gap cards, the config-injection file column +
 * preview, the DAG-seed source legend, and the governance posture picker.
 * Token-only (no hardcoded colors) so ink/ash themes both work. Recreated from
 * the hi-fi `view-onboard-existing.jsx`.
 */

export const EXISTING_CSS = `
.ex-journey { display: flex; align-items: center; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; }
.ex-cols { display: grid; grid-template-columns: 1.2fr 1fr; gap: 14px; align-items: start; }
.ex-cols-narrow { display: grid; grid-template-columns: 260px 1fr; gap: 14px; align-items: start; }

.ex-chapter { padding: 10px 12px; border: 1px solid var(--line-1); background: var(--bg-sunken); border-radius: 2px; display: flex; flex-direction: column; gap: 6px; }
.ex-chapter.warn { border-color: var(--status-warn); }
.ex-chapter .h { display: flex; align-items: center; gap: 6px; }
.ex-chapter .gl { font-family: var(--font-mono); font-size: 11px; font-weight: 700; }
.ex-chapter .ch { font-family: var(--font-display); font-weight: 700; font-size: 13px; color: var(--fg-1); letter-spacing: -0.018em; text-transform: lowercase; }
.ex-chapter .body { font-family: var(--font-mono); font-size: 11px; color: var(--fg-2); line-height: 1.55; }
.ex-chapter .from { font-family: var(--font-mono); font-size: 9.5px; color: var(--ember-08); }

.ex-gap { padding: 10px 12px; border: 1px solid var(--status-warn); background: var(--bg-sunken); border-radius: 2px; display: flex; flex-direction: column; gap: 6px; }
.ex-gap .lbl { font-family: var(--font-mono); font-size: 9px; color: var(--ember-08); letter-spacing: 0.18em; text-transform: uppercase; font-weight: 700; }
.ex-gap .q { font-family: var(--font-ui); font-size: 12.5px; color: var(--fg-1); line-height: 1.45; }
.ex-gap .opts { display: flex; gap: 6px; flex-wrap: wrap; }

.ex-filelist { border: 1px solid var(--line-1); border-radius: 2px; overflow: hidden; }
.ex-filerow { display: grid; grid-template-columns: 18px 1fr auto; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--line-1); cursor: pointer; }
.ex-filerow:last-child { border-bottom: none; }
.ex-filerow.on { background: var(--accent-tint); border-left: 2px solid var(--ember-08); }
.ex-filerow.off { opacity: 0.5; }
.ex-filerow .path { font-family: var(--font-mono); font-size: 11.5px; color: var(--fg-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ex-filerow .snap { font-family: var(--font-mono); font-size: 9px; color: var(--ember-08); letter-spacing: 0.1em; margin-left: 4px; }
.ex-filerow .add { font-family: var(--font-mono); font-size: 9.5px; color: var(--status-ok); }

.ex-preview { border: 1px solid var(--line-1); border-radius: 2px; background: var(--bg-canvas); padding: 10px 12px; font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-2); line-height: 1.5; white-space: pre-wrap; max-height: 360px; overflow: auto; }

.ex-legend { display: flex; gap: 14px; flex-wrap: wrap; font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-2); margin: 8px 0; }
.ex-legend .key { display: flex; align-items: center; gap: 6px; }
.ex-legend .swatch { width: 14px; height: 8px; display: inline-block; border: 1px solid var(--line-2); }
.ex-legend .swatch.gap { border-style: dashed; border-color: var(--steel-08); }
.ex-seed-row { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; padding: 7px 10px; background: var(--bg-canvas); border: 1px solid var(--line-1); border-left: 2px solid var(--line-2); border-radius: 2px; }
.ex-seed-row.gap { border-left-style: dashed; border-left-color: var(--steel-08); }
.ex-seed-row .name { font-family: var(--font-mono); font-size: 11.5px; color: var(--fg-1); }
.ex-seed-row .tag { font-family: var(--font-mono); font-size: 9px; color: var(--fg-3); }

.ex-posture { padding: 12px 14px; border: 1px solid var(--line-1); background: var(--bg-sunken); border-radius: 2px; display: flex; flex-direction: column; gap: 6px; cursor: pointer; }
.ex-posture.on { border-color: var(--ember-08); }
.ex-posture .head { display: flex; align-items: center; gap: 8px; }
.ex-posture .radio { width: 14px; height: 14px; border: 1.5px solid var(--line-2); border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; }
.ex-posture.on .radio { border-color: var(--ember-08); }
.ex-posture.on .radio::after { content: ""; width: 6px; height: 6px; background: var(--ember-08); border-radius: 50%; }
.ex-posture .name { font-family: var(--font-display); font-weight: 700; font-size: 14px; color: var(--fg-1); text-transform: lowercase; }
.ex-posture .desc { font-family: var(--font-ui); font-size: 12px; color: var(--fg-2); line-height: 1.45; padding-left: 22px; }
.ex-posture .best { font-family: var(--font-mono); font-size: 10px; color: var(--fg-3); padding-left: 22px; }
.ex-posture.on .best { color: var(--ember-08); }

.ex-policy-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 7px 10px; background: var(--bg-sunken); border: 1px solid var(--line-1); border-left: 2px solid var(--ember-08); border-radius: 2px; }
.ex-policy-row .t { font-family: var(--font-ui); font-size: 12px; color: var(--fg-1); }
.ex-policy-row .a { font-family: var(--font-mono); font-size: 10px; color: var(--ember-08); }
`;

export function ExistingStyles() {
  return <style dangerouslySetInnerHTML={{ __html: EXISTING_CSS }} />;
}
