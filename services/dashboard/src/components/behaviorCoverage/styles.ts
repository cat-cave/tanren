export const BEHAVIOR_COVERAGE_SCREEN_CSS = `
.behavior-coverage-screen { display: flex; flex-direction: column; gap: 14px; font-family: var(--font-ui); }
.behavior-coverage-screen .panel { border: 1px solid var(--line-1); border-radius: 10px; background: var(--bg-surface, var(--bg-canvas)); }
.behavior-coverage-screen .panel-pad { padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; }
.behavior-coverage-screen .mini-eyebrow { font-family: var(--font-mono); font-size: 9px; letter-spacing: .16em; text-transform: uppercase; font-weight: 700; color: var(--fg-3); }
.behavior-coverage-screen .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.behavior-coverage-screen .stat { border: 1px solid var(--line-1); border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; }
.behavior-coverage-screen .stat b { font-family: var(--font-mono); font-size: 24px; font-weight: 600; color: var(--fg-1); }
.behavior-coverage-screen .stat span { font-family: var(--font-mono); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: var(--fg-3); }
.behavior-coverage-screen .alert { border: 1px solid var(--ember-08, var(--line-2)); border-radius: 8px; padding: 11px 13px; color: var(--fg-2); font-size: 12px; line-height: 1.45; }
.behavior-coverage-screen .alert b { color: var(--ember-08, var(--fg-1)); }
.behavior-coverage-screen .empty { padding: 20px 4px; color: var(--fg-3); font-size: 13px; line-height: 1.5; }
.behavior-coverage-screen table { width: 100%; border-collapse: collapse; font-size: 12px; }
.behavior-coverage-screen th { padding: 8px; text-align: left; border-bottom: 1px solid var(--line-1); color: var(--fg-3); font-family: var(--font-mono); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; }
.behavior-coverage-screen td { padding: 10px 8px; border-bottom: 1px solid var(--line-1); vertical-align: top; color: var(--fg-2); }
.behavior-coverage-screen tr:last-child td { border-bottom: 0; }
.behavior-coverage-screen code { font-family: var(--font-mono); font-size: 10px; color: var(--fg-2); overflow-wrap: anywhere; }
.behavior-coverage-screen .edge-list, .behavior-coverage-screen .result-list { display: flex; flex-direction: column; gap: 5px; }
.behavior-coverage-screen .edge { display: grid; grid-template-columns: minmax(75px, auto) 1fr; gap: 8px; }
.behavior-coverage-screen .tag { width: fit-content; border: 1px solid var(--line-1); border-radius: 999px; padding: 2px 7px; font-family: var(--font-mono); font-size: 9px; color: var(--fg-2); }
.behavior-coverage-screen .tag.warn { border-color: var(--ember-08, var(--line-2)); color: var(--ember-08, var(--fg-1)); }
.behavior-coverage-screen form { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; }
.behavior-coverage-screen label { display: flex; flex-direction: column; gap: 4px; color: var(--fg-3); font-family: var(--font-mono); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; }
.behavior-coverage-screen input, .behavior-coverage-screen select { min-width: 150px; padding: 8px 10px; border: 1px solid var(--line-1); border-radius: 6px; background: var(--bg-canvas); color: var(--fg-1); font: 12px var(--font-mono); }
.behavior-coverage-screen input { min-width: min(420px, 70vw); }
.behavior-coverage-screen button { padding: 8px 13px; border: 1px solid var(--ember-08, var(--line-2)); border-radius: 6px; background: var(--bg-canvas); color: var(--ember-08, var(--fg-1)); font: 700 10px var(--font-mono); letter-spacing: .08em; text-transform: uppercase; cursor: pointer; }
.behavior-coverage-screen .result-row { border: 1px solid var(--line-1); border-radius: 7px; padding: 9px 11px; display: flex; flex-direction: column; gap: 5px; }
`;
