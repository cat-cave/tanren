#!/usr/bin/env node
// ---------------------------------------------------------------------------
// dedup.mjs — SEMANTIC DEDUP (issue #369, with #59)
//
// OCR is nondeterministic and PR-incremental: the same defect reappears across
// re-runs with reworded prose and shifted line numbers, and a finding a
// maintainer already DISMISSED must never resurface. This collapses near-
// duplicates by a stable SEMANTIC fingerprint (not exact text) and drops the
// dismissed set.
//
//   fingerprint = sha1( normPath(path) + " " + symbol + " " + normClaim(claim) )
//     normPath   : lowercase, backslash->slash, strip leading ./
//     symbol     : first backtick-quoted token, lowercased
//     normClaim  : lowercase, strip urls, digits (line numbers), punctuation
//   (byte-identical to the fingerprint ground-findings.mjs emits — recomputed
//    here so dedup is correct even on findings from another producer.)
//
//   * collapse: findings sharing a fingerprint -> keep the first (highest
//     priority wins on ties), record duplicates_collapsed.
//   * drop:     fingerprint in `dismissed` -> removed (never resurface, #59/#369).
//   * carry:    fingerprint in `open` -> tag prior_open=true (reconcile uses it).
//
// Deps: node built-ins only.
//
// Usage:
//   node dedup.mjs --findings <findings.json> --open "<fp,fp>" --dismissed "<fp,fp>"
//   node dedup.mjs --findings <findings.json> --open-file open.txt --dismissed-file d.txt
//   cat findings.json | node dedup.mjs --dismissed "<fp>"
//   node dedup.mjs --help
//   node dedup.mjs --selftest
// Env: OPEN_FPS, DISMISSED_FPS (comma/space/newline separated)
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
// fingerprint + readMarker are shared across the review scripts (lib.mjs).
import { fingerprint, readMarker } from "./lib.mjs";

function claimTextOf(f) {
  return `${f.title || ""} ${f.body || ""}`;
}
function fpOf(f) {
  // trust an existing well-formed fingerprint; otherwise recompute.
  if (typeof f.fingerprint === "string" && /^[0-9a-f]{40}$/u.test(f.fingerprint)) return f.fingerprint;
  return fingerprint(f.path, claimTextOf(f));
}

// ---- priority ordering for "keep the strongest of a duplicate cluster" ------
const PRIO_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
function prioRank(f) {
  return PRIO_RANK[f.priority] ?? 4;
}

// ---- pure dedup core --------------------------------------------------------
function dedup(findings, openSet, dismissedSet) {
  const byFp = new Map();
  let droppedDismissed = 0;
  let collapsed = 0;
  for (const raw of findings) {
    const fp = fpOf(raw);
    const f = { ...raw, fingerprint: fp };
    if (dismissedSet.has(fp)) {
      droppedDismissed++;
      // never resurface (#59/#369)
      continue;
    }
    f.prior_open = openSet.has(fp);
    const existing = byFp.get(fp);
    if (existing) {
      collapsed++;
      existing.duplicates_collapsed = (existing.duplicates_collapsed || 0) + 1;
      // keep the stronger (lower prio rank); preserve grounded if either was.
      existing.grounded = existing.grounded || f.grounded;
      if (prioRank(f) < prioRank(existing)) {
        f.duplicates_collapsed = existing.duplicates_collapsed;
        f.grounded = existing.grounded;
        byFp.set(fp, f);
      }
    } else {
      f.duplicates_collapsed = 0;
      byFp.set(fp, f);
    }
  }
  return { findings: [...byFp.values()], stats: { in: findings.length, out: byFp.size, collapsed, droppedDismissed } };
}

// ---- fp-list parsing --------------------------------------------------------
function parseFpList(s) {
  return new Set(
    String(s || "")
      .split(/[\s,]+/u)
      .map((x) => x.trim().toLowerCase())
      .filter((x) => /^[0-9a-f]{40}$/u.test(x)),
  );
}

// ---- cli --------------------------------------------------------------------
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--selftest") a.selftest = true;
    // --in: workflow alias
    else if (t === "--findings" || t === "--in") a.findings = argv[++i];
    // read prior open/dismissed fps from the sticky marker
    else if (t === "--pr") a.pr = argv[++i];
    else if (t === "--open") a.open = argv[++i];
    else if (t === "--dismissed") a.dismissed = argv[++i];
    else if (t === "--open-file") a.openFile = argv[++i];
    else if (t === "--dismissed-file") a.dismissedFile = argv[++i];
  }
  return a;
}
const HELP = `dedup.mjs — semantic fingerprint dedup + dismissed drop (#369/#59)

  node dedup.mjs --findings <findings.json> --open "<fp,..>" --dismissed "<fp,..>"
  cat findings.json | node dedup.mjs --dismissed-file d.txt

In: canonical findings (array, or {findings:[...]}) + prior open/dismissed
    fingerprint lists (args, --*-file, or OPEN_FPS/DISMISSED_FPS env).
Out: {findings:[...deduped], stats:{in,out,collapsed,droppedDismissed}} to stdout.
Duplicates collapse by fingerprint; dismissed fingerprints are removed for good.

  --selftest   run in-memory fixture assertions and exit
  --help       this text`;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
// Canonical seam envelope in: bare array OR {findings:[…], changedHunks?, base?, head?}.
function loadInput(args) {
  const text = args.findings ? readFileSync(args.findings, "utf8") : readStdin();
  if (!text.trim()) throw new Error("no findings input (pass --findings/--in or pipe JSON on stdin)");
  const parsed = JSON.parse(text);
  const findings = Array.isArray(parsed) ? parsed : Array.isArray(parsed.findings) ? parsed.findings : [];
  const envelope = Array.isArray(parsed) ? {} : parsed;
  return { findings, envelope };
}

function selftestAssert(c, m) {
  if (!c) throw new Error("SELFTEST FAIL: " + m);
}
function selftestMk(path, title, body, priority, grounded = true) {
  return {
    path,
    title,
    body,
    priority,
    grounded,
    fingerprint: fingerprint(path, `${title} ${body}`),
  };
}

function selftest() {
  const assert = selftestAssert;
  const mk = selftestMk;

  const a1 = mk("src/a.ts", "Fail-open in `land()`", "missing lease guard at line 12", "P1");
  // same defect, reworded line, stronger prio
  const a2 = mk("src/a.ts", "Fail-open in `land()`", "missing lease guard at line 88", "P0");
  const b = mk("src/b.ts", "Raw error leaked", "String(error) returned", "P2");
  const dismissedFinding = mk("src/c.ts", "Nit spacing", "cosmetic", "P3");

  assert(a1.fingerprint === a2.fingerprint, "line-number variance collapses to same fp");

  const dismissed = parseFpList(dismissedFinding.fingerprint);
  const open = parseFpList(a1.fingerprint);
  const r = dedup([a1, a2, b, dismissedFinding], open, dismissed);

  assert(r.stats.in === 4, "in=4");
  assert(r.stats.droppedDismissed === 1, "dropped 1 dismissed, got " + r.stats.droppedDismissed);
  assert(r.stats.collapsed === 1, "collapsed 1 dup, got " + r.stats.collapsed);
  assert(r.findings.length === 2, "2 survive, got " + r.findings.length);
  const kept = r.findings.find((f) => f.path === "src/a.ts");
  assert(kept.priority === "P0", "kept the stronger P0 of the cluster, got " + kept.priority);
  assert(kept.duplicates_collapsed === 1, "records 1 collapsed dup");
  assert(kept.prior_open === true, "carried from prior open set");
  assert(!r.findings.some((f) => f.fingerprint === dismissedFinding.fingerprint), "dismissed never resurfaces");

  // recompute path: a finding lacking a fingerprint still dedups by content.
  const noFp = {
    path: "src/a.ts",
    title: "Fail-open in `land()`",
    body: "missing lease guard at line 999",
    priority: "P1",
    grounded: true,
  };
  const r2 = dedup([noFp, a1], new Set(), new Set());
  assert(r2.findings.length === 1, "recomputed fp collapses with existing, got " + r2.findings.length);

  console.log("dedup.mjs selftest: OK");
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
  // Prior open/dismissed fingerprints: explicit args/files/env win; else read
  // them from the PR's sticky ocr-state marker (#seam1 standalone marker reader).
  let openRaw = args.open || (args.openFile && readFileSync(args.openFile, "utf8")) || process.env.OPEN_FPS;
  let dismissedRaw =
    args.dismissed || (args.dismissedFile && readFileSync(args.dismissedFile, "utf8")) || process.env.DISMISSED_FPS;
  if (args.pr && openRaw === null && dismissedRaw === null) {
    const marker = readMarker(args.pr);
    openRaw = marker.open.map((o) => (typeof o === "string" ? o : o.fp)).join(",");
    dismissedRaw = marker.dismissed.join(",");
  }
  const openSet = parseFpList(openRaw);
  const dismissedSet = parseFpList(dismissedRaw);
  const { findings, envelope } = loadInput(args);
  const r = dedup(findings, openSet, dismissedSet);
  // Thread the changedHunks seam (+base/head) through to reconcile.
  if (envelope.changedHunks) r.changedHunks = envelope.changedHunks;
  if (envelope.base) r.base = envelope.base;
  if (envelope.head) r.head = envelope.head;
  process.stdout.write(JSON.stringify(r, null, 2) + "\n");
}

main();
