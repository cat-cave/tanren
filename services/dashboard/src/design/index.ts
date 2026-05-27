/**
 * Tanren design system — dashboard surface.
 *
 * This package is the dashboard's only entry point into the design tokens.
 * Source of truth lives in `docs/design/tokens/`; the CSS sheet at
 * `./tokens.css` is a verbatim copy verified by
 * `scripts/check-design-tokens-drift.mjs` (wired into `just fast-check`).
 *
 * Usage:
 *   // CSS (server-rendered <style>):
 *   import tokensCss from "./design/tokens.css" with { type: "text" };
 *   // TypeScript constants:
 *   import { fontFamilies, spacing, radius, duration, ease } from "./design";
 *
 * Per P2A-0016: this package is import-only in Phase 2A. Do not restyle any
 * existing dashboard surface in the same commit that introduces it.
 */

export * from "./tokens.js";
