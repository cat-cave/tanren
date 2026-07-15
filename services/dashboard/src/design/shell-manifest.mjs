// Single authority for the dashboard shell CSS module ordering. Consumed by
// BOTH the build (services/dashboard/scripts/build-client.mjs, which concatenates
// these exact contiguous slices into the one published /static/shell.css) AND the
// regression test (scripts/css-modules.test.ts, which reconstructs + digests the
// same ordered modules). Keeping the order here means the build and the test
// cannot drift — there is no second hardcoded list.
//
// This is a pure DATA module (no side effects); importing it from a test does
// NOT run the build. The modules are exact contiguous slices of the pre-split
// src/design/shell.css, so concatenating them in this order is byte-identical to
// the original (the pinned SHA-256 in css-modules.test.ts guards that).

/** Repo-relative directory holding the shell modules. */
export const SHELL_MODULE_DIR = "services/dashboard/src/design/shell";

/** Ordered module stems. Order IS the cascade — do not reorder. */
export const SHELL_MODULES = ["base", "topbar", "sidenav", "main", "palette", "theme"];
