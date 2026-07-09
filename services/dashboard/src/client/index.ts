/**
 * Client-islands entry point. This is the ONLY browser-shipped bundle: the
 * server renders the page, and this script hydrates the specific interactive
 * islands (palette, theme toggle, project switcher). Not a SPA — there is no
 * client router and no virtual DOM. esbuild bundles this to `static/client.js`.
 */

import { initDagCanvas } from "./dagCanvas.js";
import { initDiscovery } from "./discovery.js";
import { initOrgSwitcher } from "./orgSwitcher.js";
import { initPalette } from "./palette.js";
import { injectFormCsrfFields } from "./paletteChat.js";
import { initReviewHandoff } from "./reviewHandoff.js";
import { initRunStream } from "./runStream.js";
import { initTheme } from "./theme.js";

function boot(): void {
  initTheme();
  initOrgSwitcher();
  initPalette();
  // Ensure POST forms carry the shell CSRF field (safety net if a form
  // missed a server-rendered <CsrfField>).
  injectFormCsrfFields();
  // run-detail + review islands (no-op when their markup is absent).
  initRunStream();
  initReviewHandoff();
  // DAG-primary canvas + spec drawer (no-op when absent).
  initDagCanvas();
  // spec-discovery placement selection (no-op when absent).
  initDiscovery();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
