/**
 * Client-islands build. Bundles the browser entry (`src/client/index.ts`) into
 * a single ES module at `dist/static/client.js` and copies the design-token
 * stylesheet alongside it. The Hono server serves `dist/static/**` at
 * `/static/**` (see `src/main.tsx`).
 *
 * This is the architectural deliverable of P2B-0001: a real bundled
 * client-islands layer, NOT a client SPA. Run via `pnpm build:client`; the
 * package `build` runs the server `tsc` AND this step, so `pnpm -r build`
 * produces both.
 */

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { SHELL_MODULES } from "../src/design/shell-manifest.mjs";

const here = import.meta.dirname;
const root = resolve(here, "..");
const outDir = resolve(root, "dist/static");

await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [resolve(root, "src/client/index.ts")],
  bundle: true,
  format: "esm",
  target: ["es2022"],
  platform: "browser",
  minify: true,
  sourcemap: true,
  outfile: resolve(outDir, "client.js"),
  tsconfig: resolve(root, "tsconfig.client.json"),
  logLevel: "info",
});

// Stylesheets served as static assets next to the bundle.
await cp(resolve(root, "src/design/tokens.css"), resolve(outDir, "tokens.css"));
// The shell chrome is split into ordered modules under src/design/shell/ (each
// under the 500-line source cap — see scripts/check-architecture-line-cap.mjs).
// They are exact contiguous slices of the original shell.css, concatenated here
// at BUILD time so the server still publishes a single /static/shell.css asset
// (no browser @imports to unpublished module paths). The concatenation is
// byte-identical to the pre-split original (verified by the pinned digests in
// scripts/css-modules.test.ts), so rendered behavior is preserved. The ordered
// stem list is the ONE shared authority in src/design/shell-manifest.mjs,
// consumed here AND by the regression test, so the build and test cannot drift.
let shellCss = "";
for (const module of SHELL_MODULES) {
  shellCss += await readFile(resolve(root, "src/design/shell", `${module}.css`), "utf8");
}
await writeFile(resolve(outDir, "shell.css"), shellCss);

console.log("client islands bundled to dist/static/");
