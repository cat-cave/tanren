/**
 * Client-islands entry point. This is the ONLY browser-shipped bundle: the
 * server renders the page, and this script hydrates the specific interactive
 * islands (palette, theme toggle, project switcher). Not a SPA — there is no
 * client router and no virtual DOM. esbuild bundles this to `static/client.js`.
 */

import { initOrgSwitcher } from "./orgSwitcher.js";
import { initPalette } from "./palette.js";
import { initReviewHandoff } from "./reviewHandoff.js";
import { initRunStream } from "./runStream.js";
import { initTheme } from "./theme.js";

function boot(): void {
  initTheme();
  initOrgSwitcher();
  initPalette();
  // P2B-0004 run-detail + review islands (no-op when their markup is absent).
  initRunStream();
  initReviewHandoff();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
