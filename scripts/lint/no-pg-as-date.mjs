// no-pg-as-date (audit RC-6 enforcement). A repo-local lint that REJECTS the
// re-introduction of trust-laundering casts on pg-row reads in the run-detail
// read seam. A `raw.X as Date` / `row["recorded_at"] as Date` cast tells the
// type system a value IS a Date when nothing checked it — a column-type
// migration or a NULL then silently hands garbage to a consumer that trusts the
// type. The fix is to decode raw rows through a Zod row schema (z.coerce.date())
// at the boundary; this lint makes a reverted fix fail the build.
//
// SCOPE (deliberately narrow): the `services/orchestrator/src/routes/runs/**`
// read seam cleaned by the first RC-6 wave, PLUS the three forge decode sites
// cleaned by the forge-decode wave — `engine/forge/turns.ts` (`decodeTurnRow`),
// `proposals.ts` (`decodeRow`), and `threads.ts` (`decodeThreadRow`), each now
// decoding raw rows through a Zod row schema (z.coerce.date() + enum cells). The
// forge files are listed as EXACT paths (not the whole `engine/forge/` dir) so
// the lint guards the decode sites without clashing with the INSERT/index logic
// or the sibling files in that dir. Widen further in a follow-up.
//
// FORBIDDEN forms inside the scoped dirs:
//   - `... as Date`                       (the laundering cast this audit removed)
//   - `<x>.parse(...) as <ClosedEnum>`    (casting AWAY a Zod-parsed value's type)
//   - `JSON.parse(...) as <ClosedEnum>`   (same, for JSON.parse output)
// `as const` is allowed (not a row-shape cast). Comment/JSDoc lines are ignored
// so the prose that documents the removed cast doesn't trip the lint.

import { glob, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { exit } from "node:process";

// Scoped directories (prefix match) — every `.ts(x)` beneath is linted.
const SCOPED_DIRS = ["services/orchestrator/src/routes/runs/"];

// Scoped EXACT files — guarded individually so the lint covers a specific decode
// site without pulling its sibling files in the same dir into scope.
const SCOPED_FILES = [
  "services/orchestrator/src/engine/forge/turns.ts",
  "services/orchestrator/src/engine/forge/proposals.ts",
  "services/orchestrator/src/engine/forge/threads.ts",
];

// The lint never reads its own source (the forbidden strings live in its prose).
const SELF = "scripts/lint/no-pg-as-date.mjs";

function normalizePath(path) {
  return path.split("\\").join("/");
}

function inScope(file) {
  return SCOPED_DIRS.some((dir) => file.startsWith(dir)) || SCOPED_FILES.includes(file);
}

// Strip a `//` line comment / `*`-prefixed block-comment body so a `as Date`
// mention in prose isn't flagged. String literals are left intact.
function stripCommentary(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
    return "";
  }
  const idx = line.indexOf("//");
  return idx === -1 ? line : line.slice(0, idx);
}

// `... as Date` — the laundering cast. (We do not need to anchor what precedes
// it; any `as Date` in this seam must instead come from a Zod decode.)
const AS_DATE = /\bas\s+Date\b/u;
// `.parse(...) as Foo` / `JSON.parse(...) as Foo` — casting away a parsed value's
// type. Excludes `as const` and `as unknown` (neither launders to a typed
// domain shape). Matches a closed-enum/type identifier or an indexed access
// (`as RunCostRecord["billingMode"]`).
const PARSE_THEN_CAST = /\.parse\s*\([^;]*\)\s*as\s+(?!const\b|unknown\b)[A-Za-z_$]/u;

export function scanLineForViolations(line) {
  const code = stripCommentary(line);
  const violations = [];
  if (AS_DATE.test(code)) {
    violations.push("`as Date` cast — decode pg timestamps through a Zod row schema (z.coerce.date()) instead");
  }
  if (PARSE_THEN_CAST.test(code)) {
    violations.push("`.parse(...) as <Type>` — a parsed value is already typed; drop the cast");
  }
  return violations;
}

function scanText(file, text) {
  const diagnostics = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    for (const message of scanLineForViolations(line)) {
      diagnostics.push({ rule: "no-pg-as-date", file, line: index + 1, message });
    }
  }
  return diagnostics;
}

async function collectScopedFiles(root) {
  const files = new Set();
  for (const dir of SCOPED_DIRS) {
    for await (const entry of glob(`${dir}**/*.{ts,tsx}`, { cwd: root })) {
      const file = normalizePath(entry);
      if (file !== SELF) files.add(file);
    }
  }
  for (const file of SCOPED_FILES) {
    if (file === SELF) continue;
    // An exact-scoped file is only linted if it exists under this root (test
    // fixtures stand up a partial tree; the repo root always has all three).
    const exists = await stat(resolve(root, file)).then(
      () => true,
      () => false,
    );
    if (exists) files.add(normalizePath(file));
  }
  return [...files].toSorted();
}

export async function runNoPgAsDateLint({ root = process.cwd() } = {}) {
  const resolvedRoot = resolve(root);
  const files = await collectScopedFiles(resolvedRoot);
  const diagnostics = [];
  for (const file of files) {
    if (!inScope(file)) continue;
    const text = await readFile(resolve(resolvedRoot, file), "utf8");
    diagnostics.push(...scanText(file, text));
  }
  return diagnostics;
}

export function formatDiagnostics(diagnostics, root = process.cwd()) {
  return diagnostics
    .map((d) => `${relative(root, resolve(root, d.file))}:${d.line}: ${d.rule}: ${d.message}`)
    .join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const diagnostics = await runNoPgAsDateLint();
  if (diagnostics.length > 0) {
    console.error(formatDiagnostics(diagnostics));
    exit(1);
  }
  console.log("no-pg-as-date lint passed");
}
