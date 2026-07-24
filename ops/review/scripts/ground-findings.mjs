#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ground-findings.mjs — GROUNDING + normalisation (issues #6 / #167 / #16 / #369)
//
// OCR is a stateless diff engine; it will happily attribute a finding to a line
// it never touched, or to the wrong file. This script anchors every finding to
// the ACTUAL changed-hunk line set of the diff before anything downstream can
// gate on it, and emits the DESIGN §"Canonical finding record" shape.
//
// For each OCR comment:
//   * grounded = true  iff [start_line..end_line] intersects a changed hunk in
//                       the SAME file (new-side line numbers from git diff -U0).
//   * file not in the diff  -> grounded=false, file_in_diff=false (wrong-file
//                              misattribution) — FLAGGED, not silently trusted.
//   * line off-diff         -> grounded=false, locatable=true.
//   * start_line == 0       -> grounded=false, locatable=false  (PRESERVED for the
//                              summary fallback in post-review.mjs — never dropped, #80).
//
// Also derives OUR priority ladder from OCR severity and a semantic fingerprint.
//   Priority: critical->P0  high->P1  medium->P2  low->P3  info->P3   (#16)
//   Fingerprint (shared verbatim with dedup.mjs): sha1(normPath + symbol + normClaim).
//
// Deps: node built-ins + `git` CLI only. Nothing is dropped here.
//
// OCR JSON shape assumed:
//   { summary:{...}, comments:[{path,start_line,end_line,content,category,severity}],
//     warnings:[], session_id }
//
// Usage:
//   node ground-findings.mjs --ocr <ocr.json> --base <sha> --head <sha>
//   node ground-findings.mjs --ocr <ocr.json> --base <sha> --head <sha> --out findings.json
//   node ground-findings.mjs --help
//   node ground-findings.mjs --selftest
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
// fingerprint + normPath are shared verbatim across the review scripts (lib.mjs).
import { fingerprint, normPath } from "./lib.mjs";

// ---- severity -> priority ladder (#16) --------------------------------------
const PRIORITY = { critical: "P0", high: "P1", medium: "P2", low: "P3", info: "P3" };
function toPriority(sev) {
  return PRIORITY[String(sev || "").toLowerCase()] || "P3";
}

// ---- content -> title/body --------------------------------------------------
function splitContent(content) {
  const c = String(content || "");
  const nl = c.indexOf("\n");
  if (nl === -1) return { title: c.trim().replace(/^#+\s*/u, ""), body: "" };
  return {
    title: c
      .slice(0, nl)
      .trim()
      .replace(/^#+\s*/u, ""),
    body: c.slice(nl + 1).trim(),
  };
}

// ---- hunk-set intersection --------------------------------------------------
function intersects(ranges, s, e) {
  for (const [a, b] of ranges) if (s <= b && e >= a) return true;
  return false;
}

// ---- pure grounding core ----------------------------------------------------
// hunkMap: { <path>: [[startLine,endLine], ...] }  (new-side line numbers)
function groundFindings(ocr, hunkMap) {
  const comments = Array.isArray(ocr?.comments) ? ocr.comments : [];
  return comments.map((c) => {
    const path = String(c.path || "");
    const start = Number.isFinite(c.start_line) ? c.start_line : parseInt(c.start_line, 10) || 0;
    const endRaw = Number.isFinite(c.end_line) ? c.end_line : parseInt(c.end_line, 10) || 0;
    const end = endRaw >= start ? endRaw : start;
    const { title, body } = splitContent(c.content);
    const fileRanges = hunkMap[path] || hunkMap[normPath(path)];
    const fileInDiff = Array.isArray(fileRanges);

    let grounded = false;
    let locatable = false;
    let reason;
    if (start <= 0) {
      // unlocatable: OCR could not place it — keep for summary fallback (#80).
      reason = "unlocatable (start_line=0)";
    } else if (!fileInDiff) {
      // wrong-file misattribution (#167).
      reason = "misattributed (file not in diff)";
      locatable = true;
    } else if (intersects(fileRanges, start, end)) {
      grounded = true;
      locatable = true;
      reason = "grounded (intersects changed hunk)";
    } else {
      // real file, but the cited lines are outside what this PR changed (#6).
      reason = "off-diff (line not in a changed hunk)";
      locatable = true;
    }

    return {
      path,
      start_line: start,
      end_line: end,
      severity_ocr: String(c.severity || "").toLowerCase(),
      priority: toPriority(c.severity),
      category: c.category || "",
      title,
      body,
      fingerprint: fingerprint(path, `${title} ${body}`),
      grounded,
      locatable,
      file_in_diff: fileInDiff,
      reason,
      state: "new",
    };
  });
}

// ---- git diff -U0 -> hunkMap ------------------------------------------------
function parseUnifiedZero(diffText) {
  const map = {};
  let cur = null;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      cur = p === "/dev/null" ? null : p.replace(/^b\//u, "");
      if (cur && !map[cur]) map[cur] = [];
    } else if (line.startsWith("@@")) {
      // @@ -a,b +c,d @@   (d omitted => 1)
      const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u);
      if (m && cur) {
        const startL = parseInt(m[1], 10);
        const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
        if (count > 0) map[cur].push([startL, startL + count - 1]);
        // count===0 is a pure deletion at this point; no new-side lines to ground on.
      }
    }
  }
  return map;
}

// hunkMap {path:[[s,e]…]} -> flat [{path,start,end}…] for the reconcile seam.
function hunkMapToChangedHunks(hunkMap) {
  const out = [];
  for (const [path, ranges] of Object.entries(hunkMap)) {
    for (const [start, end] of ranges) out.push({ path, start, end });
  }
  return out;
}

// ---- ref sanitisation (#110) ------------------------------------------------
function validateRef(ref, label) {
  const r = String(ref || "");
  if (!r) throw new Error(`${label} sha required`);
  if (r.startsWith("-")) throw new Error(`${label} rejected: leading '-'`);
  if (!/^[0-9a-fA-F]{7,40}$/u.test(r) && !/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/u.test(r))
    throw new Error(`${label} rejected: bad ref grammar`);
  return r;
}

// ---- io / cli ---------------------------------------------------------------
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--selftest") a.selftest = true;
    else if (t === "--ocr") a.ocr = argv[++i];
    else if (t === "--base") a.base = argv[++i];
    else if (t === "--head") a.head = argv[++i];
    else if (t === "--out") a.out = argv[++i];
  }
  return a;
}
const HELP = `ground-findings.mjs — anchor OCR findings to the real diff (#6/#167)

  node ground-findings.mjs --ocr <ocr.json> --base <sha> --head <sha> [--out findings.json]

Reads OCR JSON {comments:[{path,start_line,end_line,content,category,severity}], ...},
builds the changed-hunk line set (git diff -U0 base..head), and emits canonical
findings with grounded/locatable/priority/fingerprint. Nothing is dropped:
off-diff, wrong-file, and start_line=0 findings are FLAGGED (grounded=false) and kept.

  --selftest   run in-memory fixture assertions and exit
  --help       this text`;

function assert(c, m) {
  if (!c) throw new Error("SELFTEST FAIL: " + m);
}

function selftest() {
  // hunk parse
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,0 +11,3 @@",
    "@@ -40 +50 @@",
    "diff --git a/src/b.ts b/src/b.ts",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -1,2 +1,0 @@",
  ].join("\n");
  const hunks = parseUnifiedZero(diff);
  assert(
    JSON.stringify(hunks["src/a.ts"]) ===
      JSON.stringify([
        [11, 13],
        [50, 50],
      ]),
    "a.ts hunks: " + JSON.stringify(hunks["src/a.ts"]),
  );
  assert(Array.isArray(hunks["src/b.ts"]) && hunks["src/b.ts"].length === 0, "b.ts pure-deletion -> empty ranges");

  const ocr = {
    session_id: "s1",
    warnings: [],
    comments: [
      {
        path: "src/a.ts",
        start_line: 12,
        end_line: 12,
        content: "Fail-open in `land()`\nMissing lease guard.",
        category: "security",
        severity: "critical",
      },
      { path: "src/a.ts", start_line: 41, end_line: 41, content: "Off-diff note", category: "style", severity: "low" },
      { path: "src/ghost.ts", start_line: 5, end_line: 5, content: "Wrong file", category: "bug", severity: "high" },
      {
        path: "src/a.ts",
        start_line: 0,
        end_line: 0,
        content: "General summary point",
        category: "design",
        severity: "medium",
      },
    ],
  };
  const out = groundFindings(ocr, hunks);
  assert(out.length === 4, "no drops, got " + out.length);
  assert(out[0].grounded === true && out[0].priority === "P0", "critical in-hunk grounded P0");
  assert(out[0].title === "Fail-open in `land()`", "title parsed");
  assert(
    out[1].grounded === false && out[1].locatable === true && out[1].file_in_diff === true,
    "off-diff line flagged",
  );
  assert(out[2].grounded === false && out[2].file_in_diff === false, "wrong-file flagged misattributed");
  assert(
    out[3].grounded === false && out[3].locatable === false && out[3].priority === "P2",
    "start_line=0 preserved as unlocatable P2",
  );
  assert(/^[0-9a-f]{40}$/u.test(out[0].fingerprint), "sha1 fingerprint");
  // fingerprint stable across line-number changes (semantic)
  const fpA = fingerprint("src/a.ts", "Fail-open in `land()` Missing lease guard on line 12.");
  const fpB = fingerprint("src/a.ts", "Fail-open in `land()` Missing lease guard on line 99.");
  assert(fpA === fpB, "fingerprint ignores line numbers");

  console.log("ground-findings.mjs selftest: OK");
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

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
  if (!args.ocr) throw new Error("--ocr <ocr.json> required");
  const base = validateRef(args.base || process.env.BASE_SHA, "base");
  const head = validateRef(args.head || process.env.HEAD_SHA, "head");
  const ocr = JSON.parse(readFileSync(args.ocr, "utf8"));

  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const diffText = git(root, ["diff", "-U0", "-M", `${base}..${head}`]);
  const hunkMap = parseUnifiedZero(diffText);

  const findings = groundFindings(ocr, hunkMap);
  // changedHunks seam (#seam2): reconcile.mjs needs this round's changed-hunk set
  // to decide `addressed`. We already computed it here, so EMIT it flattened as
  // [{path,start,end}] and thread it through dedup -> reconcile (single git diff).
  const changedHunks = hunkMapToChangedHunks(hunkMap);
  const payload = {
    // Canonical seam envelope: {findings:[…canonical records…], changedHunks, base, head, …}
    session_id: ocr.session_id ?? null,
    base,
    head,
    changedHunks,
    counts: {
      total: findings.length,
      grounded: findings.filter((f) => f.grounded).length,
      off_diff: findings.filter((f) => f.locatable && !f.grounded && f.file_in_diff).length,
      misattributed: findings.filter((f) => !f.file_in_diff && f.start_line > 0).length,
      unlocatable: findings.filter((f) => !f.locatable).length,
    },
    findings,
  };
  const text = JSON.stringify(payload, null, 2) + "\n";
  if (args.out) writeFileSync(args.out, text);
  else process.stdout.write(text);
}

main();
