// The canonical file-collection + 500-line-cap authority for the architecture
// checker. Extracted from `check-architecture.mjs` into this focused sibling so
// the orchestrator module stays under the same 500-line cap it enforces.
//
// This module owns THREE concerns:
//   1. WHICH tracked files the whole checker family scans (`collectFiles` /
//      `readProjectFiles`) — the canonical collector. Adding an extension here
//      opts it INTO every check, not just line-cap.
//   2. The `file-line-max-500` rule (`checkLineMax`) — the source/config/docs
//      line cap from PROJECT_BRIEF.md §1.2 invariant 8.
//   3. The finite, enumerated line-cap exclusions (narrative docs + vendored
//      data). There is NO directory-prefix blanket exemption: every exemption
//      is a named file (narrative doc), a named data file, or a documented
//      generated-output prefix in `checkLineMax` itself.

import { glob, readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Tracked source/config/docs extensions. `css` covers the design surfaces
 *  (dashboard shell + hi-fi prototype); `html`/`jsx`/`txt` cover the hi-fi
 *  prototype markup + the control-plane docs (e.g. integrated-build-dag.html,
 *  build-workflow.mjs.txt) so they are bounded by the 500-line cap too. */
export const patterns = [
  "**/*.{ts,tsx,js,mjs,json,md,yml,yaml,sql,sh,css,html,jsx,txt}",
  ".github/**/*.{yml,yaml}",
  "Dockerfile",
  "**/Dockerfile",
  "justfile",
];

const ignoredDirs = new Set(["node_modules", "dist", "coverage", ".git"]);

// Long-running narrative docs (gain sections as the plan evolves) — the
// 500-line source cap doesn't fit. This is a finite, enumerated list of NAMED
// files, NOT a directory blanket. The mission-complete per-node specs
// (`docs/roadmap/mission-complete/nodes/*`) live here as individual entries:
// they are the long-running narrative node specs that gain detail each wave, the
// same category as `docs/roadmap/timeout-eradication.md`. Only the node specs
// currently over 500 lines are listed (the rest stay under the cap); a node that
// later grows past 500 is added here as a named entry. There is no longer a
// `docs/roadmap/mission-complete/` prefix blanket — runnable modules under that
// tree (e.g. a future `.mjs`/`.ts`) ARE scanned.
const roadmapDocs = [
  "PROJECT_BRIEF.md",
  "ROADMAP.md",
  "docs/architecture/autonomy-engine.md",
  "docs/operator-guide/apex-run-playbook.md",
  "docs/roadmap/timeout-eradication.md",
  "docs/roadmap/mission-complete/nodes/runtime.md",
  "docs/roadmap/mission-complete/nodes/backhalf.md",
  "docs/roadmap/mission-complete/nodes/integrations.md",
  "docs/roadmap/mission-complete/nodes/governance.md",
  "docs/roadmap/mission-complete/nodes/design.md",
];

// DATA, exempt from the 500-line source cap: the vendored LiteLLM model-price
// snapshot + cspell.json word-list (both grow with the codebase).
const vendoredData = ["services/orchestrator/src/engine/costs/pricing/model_prices.json", "cspell.json"];

const lineMaxExclusions = new Set([...roadmapDocs, ...vendoredData, "pnpm-lock.yaml", "justfile"]);

export const LINE_MAX = 500;

export function normalizePath(path) {
  return path.split("\\").join("/");
}

export function isIgnored(path) {
  return normalizePath(path)
    .split("/")
    .some((part) => ignoredDirs.has(part));
}

export async function collectFiles(root) {
  const files = new Set();
  for (const pattern of patterns) {
    for await (const entry of glob(pattern, { cwd: root })) {
      const file = normalizePath(entry);
      if (!isIgnored(file)) {
        files.add(file);
      }
    }
  }
  return [...files].toSorted();
}

export async function readProjectFiles(root) {
  const files = await collectFiles(root);
  const projectFiles = [];
  for (const file of files) {
    projectFiles.push({ file, text: await readFile(resolve(root, file), "utf8") });
  }
  return projectFiles;
}

function diagnostic(rule, file, message, line = 1) {
  return { rule, file, line, message };
}

/**
 * `file-line-max-500`: source, config, and docs files must stay at or below
 * LINE_MAX lines. Named narrative docs and vendored data are excluded above;
 * generated output is excluded by the documented prefixes below (db migrations,
 * the answerer JSON-Schema mirror, the unified contract mirror). There is NO
 * directory-blanket exemption for `docs/roadmap/mission-complete/`.
 */
export function checkLineMax(projectFiles) {
  const diagnostics = [];
  for (const { file, text } of projectFiles) {
    if (
      lineMaxExclusions.has(file) ||
      // The collapsed single baseline (db/migrations/0000_*.sql) is generated
      // DDL + the RLS/role/grant tail, not a source module — exempt like meta/.
      file.startsWith("db/migrations/") ||
      file.startsWith("services/orchestrator/src/engine/answerers/schemas/generated/") ||
      file.startsWith("contracts/json/")
    ) {
      continue;
    }
    const lineCount = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
    if (lineCount > LINE_MAX) {
      diagnostics.push(diagnostic("file-line-max-500", file, `${lineCount} lines exceeds the 500-line cap`));
    }
  }
  return diagnostics;
}
