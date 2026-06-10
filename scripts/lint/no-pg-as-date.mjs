// no-pg-as-date (audit RC-6 enforcement). A repo-local lint that REJECTS the
// re-introduction of trust-laundering casts on pg-row reads in the run-detail
// read seam. A `raw.X as Date` / `row["recorded_at"] as Date` cast tells the
// type system a value IS a Date when nothing checked it — a column-type
// migration or a NULL then silently hands garbage to a consumer that trusts the
// type. The fix is to decode raw rows through a Zod row schema (z.coerce.date())
// at the boundary; this lint makes a reverted fix fail the build.
//
// SCOPE (r6 §4 — widened to ALL shipped DB / repository read seams): every
// `.ts(x)` under `services/orchestrator/src/routes/**` (the HTTP read seams) and
// under `db/**` (the schema/decode layer), PLUS the store/repository decode files
// matched by `engine/**/*store*.ts` (every `*store*`/`*Store*` module — runner /
// event / notification / inbox / audit / hold-ceiling / issue-claim stores), PLUS
// the forge-tools event read seam (`engine/forge/tools/read.ts`). These are the
// files that decode raw pg rows; a re-introduced `as Date` / `.parse(...) as Enum`
// launder in ANY of them now fails the build. (The earlier narrow scope —
// `routes/runs/**` + three exact forge files — is subsumed by these globs.)
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

// Scoped directories (prefix match) — every `.ts(x)` beneath is linted. Widened
// (r6 §4) from `routes/runs/` to the WHOLE HTTP read seam (`routes/`) and the DB
// schema/decode layer (`db/`).
const SCOPED_DIRS = ["services/orchestrator/src/routes/", "db/"];

// Scoped GLOBS — store/repository decode modules anywhere under `engine/`. Matches
// `*store*`/`*Store*` (runner/event/notification/inbox/audit/hold-ceiling/issue-claim
// stores). A new store decode site is in scope automatically (no per-file listing).
const SCOPED_GLOBS = [
  "services/orchestrator/src/engine/**/*store*.ts",
  "services/orchestrator/src/engine/**/*Store*.ts",
];

// Scoped EXACT files — specific decode sites outside the dirs/globs above (forge
// row-decoders that are neither `routes/`/`db/` nor `*store*`-named).
const SCOPED_FILES = [
  "services/orchestrator/src/engine/forge/turns.ts",
  "services/orchestrator/src/engine/forge/proposals.ts",
  "services/orchestrator/src/engine/forge/threads.ts",
  // The forge-tools event read seam (`read_events`): it maps raw pg rows into
  // `RedactedEventRow`. Its `ts` cell is Zod-decoded (z.coerce.date()) at the
  // boundary — this scope keeps a re-introduced `row["ts"] as Date` laundering
  // cast (code-integrity r3 finding #4) out of the build.
  "services/orchestrator/src/engine/forge/tools/read.ts",
];

// The lint never reads its own source (the forbidden strings live in its prose).
const SELF = "scripts/lint/no-pg-as-date.mjs";

function normalizePath(path) {
  return path.split("\\").join("/");
}

// `engine/**/*store*.ts` as a predicate: any `.ts` whose basename contains
// `store`/`Store`, anywhere under the orchestrator engine tree.
function matchesStoreGlob(file) {
  if (!file.startsWith("services/orchestrator/src/engine/") || !file.endsWith(".ts")) {
    return false;
  }
  const base = file.slice(file.lastIndexOf("/") + 1);
  return /store/iu.test(base);
}

// Tests / specs are fixtures, not shipped decode seams — never linted.
function isTestFile(file) {
  return /\.(?:test|spec)\.(?:ts|tsx)$/u.test(file);
}

function inScope(file) {
  if (isTestFile(file)) {
    return false;
  }
  return SCOPED_DIRS.some((dir) => file.startsWith(dir)) || SCOPED_FILES.includes(file) || matchesStoreGlob(file);
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
  for (const pattern of SCOPED_GLOBS) {
    for await (const entry of glob(pattern, { cwd: root })) {
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
