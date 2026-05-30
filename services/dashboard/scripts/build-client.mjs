/**
 * Client-islands build. Bundles the browser entry (`src/client/index.ts`) into
 * a single ES module at `dist/static/client.js` and copies the design-token +
 * shell stylesheets alongside it. The Hono server serves `dist/static/**` at
 * `/static/**` (see `src/main.tsx`).
 *
 * This is the architectural deliverable of P2B-0001: a real bundled
 * client-islands layer, NOT a client SPA. Run via `pnpm build:client`; the
 * package `build` runs the server `tsc` AND this step, so `pnpm -r build`
 * produces both.
 */

import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

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
await cp(resolve(root, "src/design/shell.css"), resolve(outDir, "shell.css"));

console.log("client islands bundled to dist/static/");
