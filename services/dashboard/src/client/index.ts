/**
 * Client-islands entry point. This is the ONLY browser-shipped bundle: the
 * server renders the page, and this script hydrates the specific interactive
 * islands (palette, theme toggle, project switcher). Not a SPA — there is no
 * client router and no virtual DOM. esbuild bundles this to `static/client.js`.
 */

import { initOrgSwitcher } from "./orgSwitcher.js";
import { initPalette } from "./palette.js";
import { initTheme } from "./theme.js";

function boot(): void {
  initTheme();
  initOrgSwitcher();
  initPalette();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
