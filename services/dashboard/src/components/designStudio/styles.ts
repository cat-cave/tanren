// ds-5 — scoped CSS for the design Studio screen. Kept tiny + inline (the same
// per-screen <style> pattern the behavior-coverage screen uses).

export const DESIGN_STUDIO_SCREEN_CSS = `
.design-studio-screen { display: flex; flex-direction: column; gap: 16px; }
.design-studio-screen .panel { border: 1px solid var(--hair, #2a2a33); border-radius: 10px; }
.design-studio-screen .panel-pad { padding: 14px 16px; }
.design-studio-screen .mini-eyebrow { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; opacity: .6; margin-bottom: 8px; }
.design-studio-screen .system-row { display: flex; flex-direction: column; gap: 4px; padding: 10px 0; border-top: 1px solid var(--hair, #2a2a33); }
.design-studio-screen .system-row:first-child { border-top: 0; }
.design-studio-screen .row-head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.design-studio-screen .row-head b { font-size: 14px; }
.design-studio-screen code { font-size: 11px; opacity: .8; word-break: break-all; }
.design-studio-screen .tag { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--hair, #2a2a33); text-transform: uppercase; letter-spacing: .05em; }
.design-studio-screen .tag.pass { color: #6fe0a4; border-color: #29553f; }
.design-studio-screen .tag.fail { color: #ff8f8f; border-color: #5e2a2a; }
.design-studio-screen .tag.warn { color: #ffce7a; border-color: #5e4a2a; }
.design-studio-screen .tag.reuse { color: #8fc7ff; border-color: #2a3f5e; }
.design-studio-screen .alert { border: 1px solid #5e2a2a; background: rgba(94,42,42,.15); border-radius: 8px; padding: 10px 12px; font-size: 13px; }
.design-studio-screen .notice { border: 1px solid #29553f; background: rgba(41,85,63,.15); border-radius: 8px; padding: 10px 12px; font-size: 13px; }
.design-studio-screen .empty { opacity: .6; font-size: 13px; padding: 8px 0; }
.design-studio-screen form { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-end; margin-top: 10px; }
.design-studio-screen label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; opacity: .8; }
.design-studio-screen input, .design-studio-screen select { background: transparent; border: 1px solid var(--hair, #2a2a33); border-radius: 6px; padding: 5px 8px; color: inherit; font: inherit; }
.design-studio-screen button { border: 1px solid var(--hair, #2a2a33); border-radius: 6px; padding: 6px 12px; background: transparent; color: inherit; cursor: pointer; }
.design-studio-screen .export-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.design-studio-screen .export-row { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.design-studio-screen .checkpoint { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; border-top: 1px solid var(--hair, #2a2a33); }
`;
