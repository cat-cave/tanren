#!/usr/bin/env node
// TYPECHECK THE TEST TREES — the gate's blind spot, and a ratchet that closes it.
//
// Every package `tsconfig.json` scopes to `src/**`, and `check:types-lint` runs oxlint over
// `services/*/src` only. Nothing in `tests/**` — 1,157 files — was ever typechecked, so a
// test file could not fail to compile. That is not a cosmetic gap. It is a generator for a
// specific defect: a fixture built with the WRONG SHAPE still runs, and if the code under
// test happens not to read the fields that went missing, every assertion passes.
//
// The instance that motivated this: two tests constructed `PersistentSshOutageError` and
// `RunStateWriteTransportError` with the wrong constructor signatures. `classifyRunFailure`
// keys on `error.name` alone, so the classifier matched, 15 assertions passed, and the
// objects being classified had `undefined` in every field — a test that appeared to prove
// the classifier handles a real SSH outage was handing it an empty shell.
//
// THE RATCHET, NOT A BIG-BANG FIX. Turning this on cleanly means fixing 2,983 errors, which
// is not one reviewable change. So the existing debt is recorded per file in
// `test-types-baseline.json` and this check fails when:
//   - a file NOT in the baseline has an error (new debt cannot land), or
//   - a baselined file has MORE errors than recorded (existing debt cannot grow), or
//   - a baselined file has FEWER errors than recorded (debt was paid; the baseline must
//     shrink with it, or the ratchet silently loosens and stops protecting the file).
//
// Regenerate with `node scripts/check-test-types.mjs --write` after fixing files.

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const BASELINE_PATH = path.join(ROOT, "scripts", "test-types-baseline.json");

// Each project owns a `tsconfig.tests.json` that adds its test tree to its normal `src`
// scope. The root entry covers `scripts/**/*.test.ts` and `tests/e2e/**`, which sit under
// no package config at all.
const PROJECTS = ["services/orchestrator", "services/allocator", "services/dashboard", "db", "cli", "."];

// `path/to/file.ts(12,5): error TS2345: message`
const ERROR_LINE = /^(?<file>[^(]+)\((?<line>\d+),(?<col>\d+)\): error (?<code>TS\d+):/u;

/** Run tsc for one project and return repo-relative file -> error count. */
async function collectProject(project) {
  const cwd = path.join(ROOT, project);
  let stdout = "";
  try {
    const result = await execFileAsync(
      "node",
      [
        path.join(ROOT, "node_modules", "typescript", "bin", "tsc"),
        "--noEmit",
        "--pretty",
        "false",
        "-p",
        "tsconfig.tests.json",
      ],
      { cwd, maxBuffer: 64 * 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (error) {
    // tsc exits non-zero WHENEVER there are errors, which is the normal case here.
    // A genuine invocation failure has no parseable diagnostics and is re-thrown below.
    stdout = typeof error?.stdout === "string" ? error.stdout : "";
    if (stdout === "") throw error;
  }
  const counts = new Map();
  for (const rawLine of stdout.split("\n")) {
    const match = ERROR_LINE.exec(rawLine.trim());
    if (match?.groups === undefined) continue;
    // Normalize to a repo-relative POSIX path so the baseline is platform-stable.
    const abs = path.resolve(cwd, match.groups["file"]);
    const rel = path.relative(ROOT, abs).split(path.sep).join("/");
    counts.set(rel, (counts.get(rel) ?? 0) + 1);
  }
  return counts;
}

async function collectAll() {
  const perProject = await Promise.all(PROJECTS.map((project) => collectProject(project)));
  const merged = new Map();
  for (const counts of perProject) {
    for (const [file, n] of counts) {
      // A file can appear under two projects (a shared helper pulled in by both); take the
      // HIGHER count so the baseline is never below what some project actually reports.
      merged.set(file, Math.max(merged.get(file) ?? 0, n));
    }
  }
  return Object.fromEntries([...merged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const current = await collectAll();

if (process.argv.includes("--write")) {
  const total = Object.values(current).reduce((sum, n) => sum + n, 0);
  await writeFile(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`test-types baseline written: ${Object.keys(current).length} files, ${total} errors`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8"));
} catch {
  console.error(`missing ${path.relative(ROOT, BASELINE_PATH)} — run 'node scripts/check-test-types.mjs --write'`);
  process.exit(1);
}

const introduced = [];
const grew = [];
const improved = [];
for (const [file, count] of Object.entries(current)) {
  const allowed = baseline[file];
  if (allowed === undefined) introduced.push(`${file} (${count})`);
  else if (count > allowed) grew.push(`${file} (${allowed} -> ${count})`);
}
for (const [file, allowed] of Object.entries(baseline)) {
  const count = current[file] ?? 0;
  if (count < allowed) improved.push(`${file} (${allowed} -> ${count})`);
}

const report = (label, items, hint) => {
  if (items.length === 0) return;
  console.error(`\n${label}`);
  for (const item of items.slice(0, 40)) console.error(`  ${item}`);
  if (items.length > 40) console.error(`  ... and ${items.length - 40} more`);
  console.error(`  ${hint}`);
};

report(
  `TYPE ERRORS IN ${introduced.length} TEST FILE(S) WITH NO RECORDED DEBT:`,
  introduced,
  "Fix them. A test that does not compile is a test whose fixtures may be the wrong shape.",
);
report(
  `TYPE ERRORS GREW IN ${grew.length} TEST FILE(S):`,
  grew,
  "Fix the new errors; the baseline records existing debt, it does not license more.",
);
report(
  `${improved.length} TEST FILE(S) IMPROVED BUT THE BASELINE STILL RECORDS THE OLD DEBT:`,
  improved,
  "Run 'node scripts/check-test-types.mjs --write' and commit, so the ratchet keeps them clean.",
);

if (introduced.length > 0 || grew.length > 0 || improved.length > 0) process.exit(1);

const total = Object.values(current).reduce((sum, n) => sum + n, 0);
console.log(`test-types ratchet holds: ${Object.keys(current).length} files carrying ${total} known errors, none new`);
