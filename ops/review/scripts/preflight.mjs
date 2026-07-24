#!/usr/bin/env node
// ---------------------------------------------------------------------------
// preflight.mjs — OCR review COST GATE (issue #409)
//
// OCR `review` has NO internal budget, so this runs FIRST in the untrusted job
// and bounds the work. Given a base+head sha it:
//   1. computes the changed file set        (git diff --name-only base..head)
//   2. drops non-reviewable noise            (ignore-glob from DESIGN §COST)
//   3. measures net diff lines               (git diff --numstat, add+del)
//   4. flags oversized                       (> MAX_FILES files OR > MAX_DIFF_LINES lines)
//      -> emits oversized=true + a PRIORITIZED reviewable list (engine/db/routes
//         first) rather than silently dropping (DESIGN: "never silently drop").
//   5. emits a global deadline               (REVIEW_DEADLINE_SEC, default 1800)
//
// Runs from the git ROOT (#287): all git invocations use `cwd = <toplevel>`.
// Refs are sha/branch-grammar validated + leading-`-` rejected (#110).
//
// Deps: node built-ins + `git` CLI only. No npm.
// Output: canonical JSON to stdout + GITHUB_OUTPUT keys.
//
// Usage:
//   node preflight.mjs --base <sha> --head <sha>
//   BASE_SHA=<sha> HEAD_SHA=<sha> node preflight.mjs
//   node preflight.mjs --help
//   node preflight.mjs --selftest
// Env: MAX_FILES(60) MAX_DIFF_LINES(8000) REVIEW_DEADLINE_SEC(1800) GITHUB_OUTPUT
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

// ---- ignore-glob (DESIGN §COST: extend OCR default_exclude + our list) ------
const IGNORE_GLOBS = [
  "**/*.snap",
  "**/__snapshots__/**",
  "db/migrations/meta/**",
  "**/*.generated.*",
  "**/dist/**",
  "contracts/json/**",
  "**/contracts/json/**",
  // lockfiles
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/Cargo.lock",
  "**/go.sum",
  "**/poetry.lock",
  "**/composer.lock",
  "**/Gemfile.lock",
];

// ---- tiny glob matcher (supports **, *, ?, {a,b}) ---------------------------
function expandBraces(glob) {
  const m = glob.match(/\{([^{}]*)\}/u);
  if (!m) return [glob];
  const out = [];
  for (const alt of m[1].split(",")) {
    out.push(...expandBraces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length)));
  }
  return out;
}
function globPartToRegex(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          // **/ => zero-or-more leading dirs
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp(out + "$", "u");
}
const IGNORE_RES = IGNORE_GLOBS.flatMap((g) => expandBraces(g)).map((g) => globPartToRegex(g));
function isExcluded(path) {
  return IGNORE_RES.some((re) => re.test(path));
}

// ---- priority ranking (engine/db/routes first) ------------------------------
function priorityRank(path) {
  const p = path.toLowerCase();
  if (/(^|\/)engine\//u.test(p) || /\/merge\//u.test(p)) return 0;
  if (/(^|\/)db\//u.test(p) || /migrations\//u.test(p) || /orgscope/u.test(p)) return 1;
  if (/(^|\/)routes?\//u.test(p)) return 2;
  return 3;
}
function prioritize(files) {
  return [...files].sort((a, b) => priorityRank(a) - priorityRank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

// ---- ref sanitisation (#110) ------------------------------------------------
function validateRef(ref, label) {
  const r = String(ref || "");
  if (!r) throw new Error(`${label} is required (pass --${label.toLowerCase()} or ${label.toUpperCase()}_SHA)`);
  if (r.startsWith("-")) throw new Error(`${label} rejected: leading '-' (option injection)`);
  const isSha = /^[0-9a-fA-F]{7,40}$/u.test(r);
  const isBranch = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/u.test(r);
  if (!isSha && !isBranch) throw new Error(`${label} rejected: not a sha or safe ref grammar`);
  return r;
}

// ---- numstat parsing (rename-aware) -----------------------------------------
function finalPathFromNumstat(rawPath) {
  let f = rawPath;
  if (f.includes("=>")) {
    if (f.includes("{")) f = f.replace(/\{[^{}]*=>\s*([^{}]*)\}/u, "$1");
    else f = f.split("=>").pop();
    f = f.replaceAll("//", "/").trim();
  }
  return f.trim();
}
// numstatText: lines of "added<TAB>deleted<TAB>path". Binary files show "-".
function parseNumstat(numstatText) {
  const rows = [];
  for (const line of numstatText.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const added = parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0;
    const deleted = parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0;
    const path = finalPathFromNumstat(parts.slice(2).join("\t"));
    rows.push({ path, added, deleted });
  }
  return rows;
}

// ---- pure gate core ---------------------------------------------------------
function computePreflight(numstatRows, opts) {
  const maxFiles = opts.maxFiles;
  const maxDiffLines = opts.maxDiffLines;
  const included = [];
  const excluded = [];
  let netDiffLines = 0;
  for (const row of numstatRows) {
    if (isExcluded(row.path)) {
      excluded.push(row.path);
      continue;
    }
    included.push(row.path);
    netDiffLines += row.added + row.deleted;
  }
  const reviewable = prioritize(included);
  const oversized = reviewable.length > maxFiles || netDiffLines > maxDiffLines;
  const reason = oversized
    ? `oversized: ${reviewable.length} reviewable files (max ${maxFiles}), ${netDiffLines} net diff lines (max ${maxDiffLines}); reviewing top-priority paths only`
    : `within budget: ${reviewable.length} reviewable files, ${netDiffLines} net diff lines`;
  return {
    oversized,
    total_changed: numstatRows.length,
    non_excluded_count: reviewable.length,
    net_diff_lines: netDiffLines,
    max_files: maxFiles,
    max_diff_lines: maxDiffLines,
    reviewable_files: reviewable,
    excluded_files: excluded.sort(),
    reason,
  };
}

// ---- io helpers -------------------------------------------------------------
function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}
function setOutput(key, val) {
  const f = process.env.GITHUB_OUTPUT;
  if (!f) return;
  const s = typeof val === "string" ? val : JSON.stringify(val);
  if (s.includes("\n")) appendFileSync(f, `${key}<<__GH_EOF__\n${s}\n__GH_EOF__\n`);
  else appendFileSync(f, `${key}=${s}\n`);
}
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--selftest") a.selftest = true;
    else if (t === "--base") a.base = argv[++i];
    else if (t === "--head") a.head = argv[++i];
  }
  return a;
}
const HELP = `preflight.mjs — OCR review cost gate (#409)

  node preflight.mjs --base <sha> --head <sha>
  BASE_SHA=<sha> HEAD_SHA=<sha> node preflight.mjs

Env: MAX_FILES(60) MAX_DIFF_LINES(8000) REVIEW_DEADLINE_SEC(1800) GITHUB_OUTPUT
Emits JSON {oversized, reviewable_files, excluded_files, net_diff_lines, deadline, ...}
to stdout and to GITHUB_OUTPUT. Runs git from the repo root (#287).

  --selftest   run in-memory fixture assertions and exit
  --help       this text`;

// ---- self-test --------------------------------------------------------------
function assert(c, m) {
  if (!c) throw new Error("SELFTEST FAIL: " + m);
}

function selftest() {
  // exclusion coverage
  for (const p of [
    "services/x/__snapshots__/a.snap",
    "db/migrations/meta/0001_snapshot.json",
    "app/foo.generated.ts",
    "services/x/dist/bundle.js",
    "pnpm-lock.yaml",
    "contracts/json/Thing.json",
    "packages/y/contracts/json/Thing.json",
  ]) {
    assert(isExcluded(p), "should be excluded: " + p);
  }
  for (const p of ["services/orchestrator/src/engine/merge/land.ts", "db/src/orgScope.ts", "README.md"]) {
    assert(!isExcluded(p), "should NOT be excluded: " + p);
  }
  // priority ordering: engine < db < routes < other
  const ranked = prioritize([
    "docs/readme.md",
    "services/api/routes/x.ts",
    "db/src/orgScope.ts",
    "services/orchestrator/src/engine/merge/land.ts",
  ]);
  assert(ranked[0].includes("engine/merge"), "engine first, got " + ranked[0]);
  assert(ranked[1].includes("orgScope"), "db second, got " + ranked[1]);
  assert(ranked[2].includes("routes"), "routes third, got " + ranked[2]);

  // gate: not oversized
  const small = parseNumstat(["10\t2\tservices/x/engine/a.ts", "5\t0\tdb/migrations/meta/0001.json"].join("\n"));
  let r = computePreflight(small, { maxFiles: 60, maxDiffLines: 8000 });
  assert(r.oversized === false, "small diff not oversized");
  assert(r.non_excluded_count === 1, "meta excluded -> 1 reviewable, got " + r.non_excluded_count);
  assert(r.net_diff_lines === 12, "net lines 12, got " + r.net_diff_lines);
  assert(r.excluded_files.length === 1, "one excluded");

  // gate: oversized by lines
  r = computePreflight(parseNumstat("9000\t0\tservices/x/engine/big.ts"), { maxFiles: 60, maxDiffLines: 8000 });
  assert(r.oversized === true, "9000 lines oversized");

  // gate: oversized by file count, still prioritized (engine floats up)
  const many = [];
  for (let i = 0; i < 61; i++) many.push(`1\t0\tservices/pkg/mod${i}.ts`);
  many.push("1\t0\tservices/x/engine/hot.ts");
  r = computePreflight(parseNumstat(many.join("\n")), { maxFiles: 60, maxDiffLines: 8000 });
  assert(r.oversized === true, "62 files oversized");
  assert(r.reviewable_files[0].includes("engine/"), "engine prioritized first when oversized");

  // rename parsing
  assert(finalPathFromNumstat("src/{old => new}/x.ts") === "src/new/x.ts", "brace rename");
  assert(finalPathFromNumstat("old.ts => new.ts") === "new.ts", "plain rename");

  // ref validation
  assert(validateRef("abc1234", "base") === "abc1234", "sha ok");
  let threw = false;
  try {
    validateRef("-O./pwn.sh", "head");
  } catch {
    threw = true;
  }
  assert(threw, "leading-dash ref rejected");

  console.log("preflight.mjs selftest: OK");
}

// ---- main -------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.selftest) {
    selftest();
    return;
  }
  const base = validateRef(args.base || process.env.BASE_SHA, "base");
  const head = validateRef(args.head || process.env.HEAD_SHA, "head");
  const maxFiles = parseInt(process.env.MAX_FILES || "60", 10);
  const maxDiffLines = parseInt(process.env.MAX_DIFF_LINES || "8000", 10);
  const deadline = parseInt(process.env.REVIEW_DEADLINE_SEC || "1800", 10);

  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const numstatText = git(root, ["diff", "--numstat", "-M", `${base}..${head}`]);
  const rows = parseNumstat(numstatText);

  const result = computePreflight(rows, { maxFiles, maxDiffLines });
  result.base = base;
  result.head = head;
  result.deadline = deadline;

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  setOutput("oversized", String(result.oversized));
  setOutput("deadline", String(deadline));
  setOutput("non_excluded_count", String(result.non_excluded_count));
  setOutput("net_diff_lines", String(result.net_diff_lines));
  setOutput("reviewable_files", JSON.stringify(result.reviewable_files));
  setOutput("preflight_json", JSON.stringify(result));
}

main();
