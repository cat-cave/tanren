// Copies committed runtime asset files that `tsc` does not emit into `dist/`.
//
// The orchestrator build is a bare `tsc -p tsconfig.json`, which emits only
// `.js`/`.d.ts` and silently drops non-TS files. The answerer schema adapter
// (`engine/answerers/schemas/adapter.ts`) reads its canonical JSON Schemas at
// runtime from `dist/engine/answerers/schemas/generated/*.json` via
// `readFileSync(resolve(import.meta.dirname, "generated", file))`. Without this
// copy the built worker image throws `ENOENT … generated/plan.json` the first
// time a real (non-fake) answerer runs — a gap neither `just smoke` (fake
// answerers) nor the vitest live tests (which run from `src/` via tsx) catch.
//
// Run as the orchestrator build's second step:
//   "build": "tsc -p tsconfig.json && node ../../scripts/copy-orchestrator-runtime-assets.mjs"
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const orchestrator = resolve(repoRoot, "services/orchestrator");

// Each entry: a directory (relative to the orchestrator package) whose files are
// copied verbatim from `src/` to the mirror path under `dist/`.
const ASSET_DIRS = [
  "engine/answerers/schemas/generated",
  // The vendored LiteLLM model-price snapshot read at runtime by
  // engine/costs/pricing/modelPriceSource.ts (same `readFileSync(import.meta.dirname)`
  // pattern as the answerer schemas — bare `tsc` drops the .json, so copy it).
  "engine/costs/pricing",
];

let copied = 0;
for (const rel of ASSET_DIRS) {
  const srcDir = resolve(orchestrator, "src", rel);
  const distDir = resolve(orchestrator, "dist", rel);
  if (!existsSync(srcDir)) {
    throw new Error(`runtime-asset source missing: ${srcDir}`);
  }
  mkdirSync(distDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith(".json")) continue;
    cpSync(resolve(srcDir, name), resolve(distDir, name));
    copied += 1;
  }
}

console.log(`[copy-runtime-assets] copied ${copied} asset file(s) into dist`);
