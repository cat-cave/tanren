// ds-4 sub-node #1 — the browser-free design-system render/capture harness
// public surface. Sub-nodes #2 (verdict oracle), #3 (design_render gate wiring),
// and #4 (negative controls) import the harness + its capture contracts here.

export * from "./renderCaptureContracts.js";
export * from "./browserFreeRenderCaptureHarness.js";
export { captureDomA11y, type DomA11yCapture } from "./domA11yAudit.js";
export { renderComponentToStaticMarkup, type SsrRenderInput, type SsrRenderResult } from "./componentSsrRenderer.js";
export * from "./renderVerdictOracle.js";
// ds-4 Slice B — the pixel render-worker path (real containerized screenshot + visual diff).
export * from "./pixelRenderContracts.js";
export * from "./pixelRenderCaptureHarness.js";
export * from "./podmanScreenshotRunner.js";
export * from "./visualDiffOracle.js";
export { checkpointFromPixelVerdict } from "./pixelRenderCheckpoint.js";
