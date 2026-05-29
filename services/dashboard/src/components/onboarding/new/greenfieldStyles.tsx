/**
 * P3-0015 greenfield-onboarding screen CSS. Layered ON TOP of the shared
 * P2B-0002 `OnbStyles` (which owns `.onb`, `.step-heading`, the journey strip)
 * — this only adds the greenfield-specific bits: the interview chat + the live
 * "what forge captured" panel, the derived-DAG frame, and the arrival card.
 * Token-only (no hardcoded colors) so ink/ash themes both work. Recreated from
 * the hi-fi `view-onboard-new.jsx`.
 */

export const GREENFIELD_CSS = `
.gf-cols { display: grid; grid-template-columns: 1.3fr 1fr; gap: 14px; align-items: start; }
.gf-chat { display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--line-1); background: var(--bg-sunken); border-radius: 4px; padding: 14px; }
.gf-chat .head { display: flex; align-items: baseline; gap: 10px; }
.gf-chat .head .t { font-family: var(--font-display); font-weight: 700; font-size: 14px; color: var(--fg-1); text-transform: lowercase; }
.gf-chat .head .meta { font-family: var(--font-mono); font-size: 10px; color: var(--ember-08); }
.gf-turn { padding: 9px 11px; border-radius: 2px; font-family: var(--font-ui); font-size: 13px; line-height: 1.5; }
.gf-turn.forge { background: var(--bg-canvas); border: 1px solid var(--line-1); border-left: 2px solid var(--ember-08); color: var(--fg-1); }
.gf-turn.user { background: var(--accent-tint); border: 1px solid var(--line-2); color: var(--fg-1); align-self: flex-end; }
.gf-suggest { display: flex; gap: 6px; flex-wrap: wrap; }
.gf-suggest button { font-family: var(--font-mono); font-size: 11px; }
.gf-answer { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.gf-answer textarea { width: 100%; min-height: 64px; resize: vertical; font-family: var(--font-ui); font-size: 13px; padding: 9px 11px; background: var(--bg-canvas); border: 1px solid var(--line-2); border-radius: 2px; color: var(--fg-1); box-sizing: border-box; }
.gf-answer .row { display: flex; align-items: center; gap: 10px; }
.gf-answer .hint { font-family: var(--font-mono); font-size: 10px; color: var(--status-ok); }

.gf-capture { display: flex; flex-direction: column; gap: 8px; }
.gf-capture .label { font-family: var(--font-mono); font-size: 9px; color: var(--ember-08); letter-spacing: 0.22em; text-transform: uppercase; font-weight: 700; }
.gf-card { padding: 10px 12px; border: 1px solid var(--line-1); background: var(--bg-sunken); border-radius: 2px; display: flex; flex-direction: column; gap: 6px; }
.gf-card.live { border-color: var(--ember-08); }
.gf-card .h { display: flex; align-items: center; gap: 6px; }
.gf-card .h .ch { font-family: var(--font-display); font-weight: 700; font-size: 13px; color: var(--fg-1); letter-spacing: -0.018em; text-transform: lowercase; }
.gf-card .h .gl { font-family: var(--font-mono); font-size: 11px; font-weight: 700; }
.gf-card .body { font-family: var(--font-mono); font-size: 11px; color: var(--fg-2); line-height: 1.55; }
.gf-card .empty { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-3); }

.gf-dag-frame { border: 1px solid var(--line-1); background: var(--bg-sunken); border-radius: 4px; padding: 12px; min-height: 360px; }
.gf-dag-empty { font-family: var(--font-mono); font-size: 12px; color: var(--fg-3); padding: 24px; text-align: center; }

.gf-cols3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; align-items: start; }
.gf-panel { border: 1px solid var(--line-1); background: var(--bg-sunken); border-radius: 4px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.gf-panel .ph { font-family: var(--font-display); font-weight: 700; font-size: 14px; color: var(--fg-1); text-transform: lowercase; }
.gf-panel .ph em { font-style: italic; color: var(--ember-08); }
.gf-row { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; padding: 7px 10px; background: var(--bg-canvas); border: 1px solid var(--line-1); border-left: 2px solid var(--line-2); border-radius: 2px; }
.gf-row.on { border-left-color: var(--ember-08); }
.gf-row .name { font-family: var(--font-display); font-weight: 600; font-size: 12.5px; color: var(--fg-1); text-transform: lowercase; }
.gf-row .desc { font-family: var(--font-mono); font-size: 9.5px; color: var(--fg-3); }
.gf-row .badge { font-family: var(--font-mono); font-size: 9px; color: var(--fg-3); }
.gf-row.on .badge { color: var(--status-ok); }

.gf-arrival { position: relative; overflow: hidden; border: 1px solid var(--ember-08); background: var(--accent-tint); border-radius: 4px; padding: 18px; display: flex; flex-direction: column; gap: 8px; }
.gf-arrival .eyebrow { font-family: var(--font-mono); font-size: 9px; color: var(--ember-08); letter-spacing: 0.22em; text-transform: uppercase; font-weight: 700; }
.gf-arrival .display { font-family: var(--font-display); font-weight: 700; font-size: 28px; letter-spacing: -0.028em; line-height: 1.05; color: var(--fg-1); text-transform: lowercase; }
.gf-arrival .display em { font-style: italic; color: var(--ember-08); }
.gf-arrival .sub { font-family: var(--font-ui); font-size: 12.5px; color: var(--fg-2); line-height: 1.45; }
.gf-arrival .actions { display: flex; gap: 8px; margin-top: 4px; }
.gf-arrival .footnote { font-family: var(--font-mono); font-size: 10px; color: var(--fg-3); }

.gf-foot { display: flex; align-items: center; gap: 12px; padding-top: 12px; border-top: 1px solid var(--line-1); }
.gf-foot .hint { font-family: var(--font-mono); font-size: 10px; color: var(--fg-3); }
.gf-foot .spacer { margin-left: auto; display: flex; gap: 8px; }
`;

export function GreenfieldStyles() {
  return <style dangerouslySetInnerHTML={{ __html: GREENFIELD_CSS }} />;
}
