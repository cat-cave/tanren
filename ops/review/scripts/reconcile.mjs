#!/usr/bin/env node
// =============================================================================
// reconcile.mjs — finding LIFECYCLE + sticky-marker state (no external DB)
// -----------------------------------------------------------------------------
// The finding lifecycle across incremental reviews of ONE PR:
//
//   new       — a fingerprint not present in the prior `open` set (and not
//               `dismissed`). Raised for the first time this round.
//   carried   — a fingerprint present in the prior `open` set AND still raised
//               this round. Still unresolved.
//   addressed — a prior `open` fingerprint that is NO LONGER raised this round
//               AND whose file+hunk CHANGED this round. Only a changed hunk
//               clears it — bare absence is treated as OCR nondeterminism
//               (#247) and the finding is RESURRECTED as `carried` (stays open).
//   dismissed — a fingerprint a maintainer resolved; carried forward, NEVER
//               resurfaced (#59 / #369). Dropped from the current set on sight.
//
// Sticky marker (DESIGN §Sticky-marker) — the only state, lives in the PR:
//   <!-- ocr-state v1 last_reviewed_sha=<sha> open=<fp,…> dismissed=<fp,…> followups=<fp,…> -->
//     open      = unresolved P0/P1 fingerprints (gate-blocking)
//     dismissed = maintainer-resolved fingerprints (immutable here)
//     followups = stashed P2/P3 fingerprints to file post-merge
//   (a `filed=` sub-field may be appended by file-followups.mjs; preserved here)
//
// Input JSON (--in <file> | stdin):
//   { findings:[…deduped canonical records…],
//     changedHunks:[{path,start,end}…],          // this round's diff hunks
//     priorOpenFindings:[{fingerprint,path,start_line,end_line,priority}…],  // optional locations for prior open fps
//     marker:"<!-- ocr-state … -->" | null }
// Also: --sha <headSha> (the reviewed sha to stamp as last_reviewed_sha).
//
// Output JSON (stdout): { findings:[…tagged with .state…], addressed:[fp…],
//                         marker:"<updated marker string>", state:{parsed marker} }
//
// Deps: node built-ins only (crypto for fallback fingerprints). No gh, no network.
// =============================================================================

import crypto from "node:crypto";
import fs from "node:fs";
// Sticky-marker parse/serialize + standalone reader are shared via lib.mjs.
import { parseMarker, serializeMarker, readMarker } from "./lib.mjs";

// ---- helpers ----------------------------------------------------------------
export function normPath(p) {
  return String(p || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .trim()
    .toLowerCase();
}

function normClaim(s) {
  return String(s || "")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

export function computeFingerprint(f) {
  if (f.fingerprint) return f.fingerprint;
  const h = crypto.createHash("sha1");
  h.update(
    normPath(f.path) + "\n" + (f.symbol || "") + "\n" + normClaim(f.title || "") + "\n" + normClaim(f.body || ""),
  );
  return h.digest("hex");
}

function rangesOverlap(s1, e1, s2, e2) {
  return s1 <= e2 && s2 <= e1;
}

function isGate(p) {
  return p === "P0" || p === "P1";
}

// ---- core lifecycle ---------------------------------------------------------
export function reconcile({
  findings = [],
  changedHunks = [],
  priorOpenFindings = [],
  marker = null,
  sha = "",
  newlyDismissed = [],
}) {
  const prior = typeof marker === "string" || marker === null ? parseMarker(marker) : marker;
  // UNION the marker's prior dismissed set with newly-dismissed fps (human signal:
  // resolved threads / 👎 reactions, via gather-signal.mjs). The union is written
  // back into the new marker below, so a dismissed finding NEVER resurfaces (#59/#369).
  const dismissed = new Set([
    ...prior.dismissed,
    ...(newlyDismissed || [])
      .map((s) =>
        String(s || "")
          .trim()
          .toLowerCase(),
      )
      .filter((x) => /^[0-9a-f]{40}$/u.test(x)),
  ]);
  // prior.open is now an array of {fp,path,start_line,end_line} (v2) — legacy v1
  // markers parse to bare {fp, path:null}. Derive the fp set from either shape.
  const priorOpenEntries = (prior.open || [])
    .map((o) => (typeof o === "string" ? { fp: o } : o))
    .filter((o) => o && o.fp);
  const priorOpen = new Set(priorOpenEntries.map((o) => o.fp));

  // Location map for prior-open fps: the marker's own located entries seed it, and
  // an explicit priorOpenFindings input (richer: carries priority) overrides.
  const locByFp = new Map();
  for (const o of priorOpenEntries) {
    if (o.path !== null || o.start_line !== null)
      locByFp.set(o.fp, { fingerprint: o.fp, path: o.path, start_line: o.start_line, end_line: o.end_line });
  }
  for (const f of priorOpenFindings) if (f && f.fingerprint) locByFp.set(f.fingerprint, f);

  const changedByFile = new Map();
  for (const h of changedHunks) {
    const k = normPath(h.path);
    if (!changedByFile.has(k)) changedByFile.set(k, []);
    changedByFile.get(k).push([Number(h.start) || 0, Number(h.end) || 0]);
  }
  function hunkChanged(p, start, end) {
    const ranges = changedByFile.get(normPath(p));
    if (!ranges || ranges.length === 0) return false;
    const s = Number(start) || 0;
    const e = Number(end) || 0;
    // unlocatable prior finding, but file did change
    if (!s && !e) return true;
    for (const [rs, re] of ranges) if (rangesOverlap(rs, re || rs, s, e || s)) return true;
    return false;
  }

  const currentFps = new Set();
  const tagged = [];
  for (const raw of findings) {
    const fp = computeFingerprint(raw);
    // never resurface a maintainer-dismissed finding
    if (dismissed.has(fp)) continue;
    // defensive de-dup
    if (currentFps.has(fp)) continue;
    currentFps.add(fp);
    tagged.push({ ...raw, fingerprint: fp, state: priorOpen.has(fp) ? "carried" : "new" });
  }

  // Prior-open fingerprints that vanished this round.
  const addressed = [];
  const unknownStillOpen = [];
  for (const fp of priorOpen) {
    if (currentFps.has(fp)) continue;
    const loc = locByFp.get(fp);
    if (loc && hunkChanged(loc.path, loc.start_line, loc.end_line)) {
      // hunk changed + no longer raised ⇒ genuinely resolved
      addressed.push(fp);
    } else if (loc) {
      // Absent but hunk did NOT change → nondeterminism (#247); keep it OPEN.
      tagged.push({
        ...loc,
        fingerprint: fp,
        state: "carried",
        priority: loc.priority || "P1",
        grounded: false,
        resurrected: true,
      });
      currentFps.add(fp);
    } else {
      // No location to test the hunk → cannot confirm resolution; keep OPEN.
      unknownStillOpen.push(fp);
    }
  }

  // Recompute open (P0/P1) and followups (P2/P3) from the tagged set. Each open
  // entry carries its LOCATION so the NEXT round can detect it being addressed
  // (v2 marker); an unlocatable prior-open fp is kept open with no location.
  const openByFp = new Map();
  const followupSet = new Set(prior.followups);
  for (const f of tagged) {
    if (isGate(f.priority)) {
      const s = Number(f.start_line) || 0;
      const e = Number(f.end_line) || s;
      openByFp.set(
        f.fingerprint,
        f.path && s > 0 ? { fp: f.fingerprint, path: f.path, start_line: s, end_line: e } : { fp: f.fingerprint },
      );
    } else if (f.priority === "P2" || f.priority === "P3") followupSet.add(f.fingerprint);
  }
  for (const fp of unknownStillOpen)
    if (!openByFp.has(fp)) openByFp.set(fp, { fp, path: null, start_line: null, end_line: null });
  for (const fp of addressed) {
    followupSet.delete(fp);
  }
  for (const fp of dismissed) followupSet.delete(fp);

  const state = {
    last_reviewed_sha: sha || prior.last_reviewed_sha || "",
    open: [...openByFp.values()],
    dismissed: [...dismissed],
    followups: [...followupSet],
    filed: prior.filed || [],
    extra: prior.extra || {},
  };
  return { findings: tagged, addressed, marker: serializeMarker(state), state };
}

// ---- io ---------------------------------------------------------------------
function readInput(inPath) {
  if (inPath) return JSON.parse(fs.readFileSync(inPath, "utf8"));
  if (!process.stdin.isTTY) {
    const raw = fs.readFileSync(0, "utf8");
    if (raw.trim()) return JSON.parse(raw);
  }
  throw new Error("no input: pass --in <file> or pipe JSON on stdin");
}

// ---- selftest ---------------------------------------------------------------
function selftest() {
  const prior = serializeMarker({
    last_reviewed_sha: "old111",
    open: ["fpA", "fpB", "fpU"],
    dismissed: ["fpD"],
    followups: ["fpF2"],
    filed: [],
    extra: {},
  });
  // A 40-hex fp newly dismissed by human signal this round (gather-signal.mjs).
  const humanDismissed = "e".repeat(40);
  const out = reconcile({
    sha: "new222",
    marker: prior,
    // non-hex entry must be filtered out
    newlyDismissed: [humanDismissed, "not-a-hex-fp"],
    changedHunks: [
      // fpA's hunk changed → addressed
      { path: "a.ts", start: 10, end: 20 },
      { path: "new.ts", start: 1, end: 5 },
    ],
    priorOpenFindings: [
      { fingerprint: "fpA", path: "a.ts", start_line: 12, end_line: 15, priority: "P1" },
      // hunk NOT changed → resurrected
      { fingerprint: "fpB", path: "b.ts", start_line: 30, end_line: 40, priority: "P0" },
    ],
    findings: [
      // carried (also still raised)
      { fingerprint: "fpB", path: "b.ts", priority: "P0", title: "still here" },
      // new
      { fingerprint: "fpNew", path: "new.ts", start_line: 2, end_line: 3, priority: "P1", title: "new one" },
      // followup
      { fingerprint: "fpP2", path: "c.ts", priority: "P2", title: "minor" },
      // dropped (prior marker dismissed)
      { fingerprint: "fpD", path: "d.ts", priority: "P0", title: "dismissed reraise" },
      // dropped (newly human-dismissed this round → must not resurface)
      { fingerprint: humanDismissed, path: "h.ts", priority: "P0", title: "just dismissed" },
    ],
  });

  const st = out.state;
  const byFp = Object.fromEntries(out.findings.map((f) => [f.fingerprint, f]));
  const openFps = new Set(st.open.map((o) => o.fp));
  const openByFp = Object.fromEntries(st.open.map((o) => [o.fp, o]));
  const rt = parseMarker(out.marker);
  const checks = [
    [out.addressed.includes("fpA"), "fpA addressed (hunk changed + absent)"],
    [!out.addressed.includes("fpB"), "fpB NOT addressed (absent but hunk unchanged)"],
    [byFp.fpB && byFp.fpB.state === "carried", "fpB carried (still raised)"],
    [byFp.fpNew && byFp.fpNew.state === "new", "fpNew tagged new"],
    [!byFp.fpD, "dismissed fpD dropped, never resurfaced"],
    [openFps.has("fpB") && openFps.has("fpNew"), "open set = current P0/P1"],
    [openFps.has("fpU"), "fpU (unknown-location prior open) stays open (conservative)"],
    [!openFps.has("fpA"), "addressed fpA left the open set"],
    [
      openByFp.fpNew && openByFp.fpNew.path === "new.ts" && openByFp.fpNew.start_line > 0,
      "open entry carries location for next round",
    ],
    [openByFp.fpU && openByFp.fpU.path === null, "unlocatable open entry has no location"],
    [st.followups.includes("fpP2") && st.followups.includes("fpF2"), "followups union prior+new P2/P3"],
    [st.dismissed.includes("fpD"), "dismissed carried forward"],
    [st.dismissed.includes(humanDismissed), "newly human-dismissed fp UNIONed into marker dismissed"],
    [!st.dismissed.includes("not-a-hex-fp"), "non-hex newlyDismissed entry filtered out"],
    [!byFp[humanDismissed], "newly human-dismissed finding dropped, never resurfaced"],
    [st.last_reviewed_sha === "new222", "last_reviewed_sha stamped to reviewed sha"],
    [
      rt.open.length === st.open.length && rt.open.find((o) => o.fp === "fpNew")?.start_line > 0,
      "marker round-trips with locations",
    ],
  ];
  let ok = true;
  for (const [pass, name] of checks) {
    console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
    if (!pass) ok = false;
  }
  console.log(ok ? "\nreconcile selftest PASSED" : "\nreconcile selftest FAILED");
  if (!ok) process.exit(1);
}

// ---- cli --------------------------------------------------------------------
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--selftest") a.selftest = true;
    else if (t === "--in") a.in = argv[++i];
    // --head: workflow alias
    else if (t === "--sha" || t === "--head") a.sha = argv[++i];
    // read the prior sticky marker standalone
    else if (t === "--pr") a.pr = argv[++i];
    // newly-dismissed fps (human signal) to UNION into the marker's dismissed set
    else if (t === "--dismissed") a.dismissed = argv[++i];
    else a._.push(t);
  }
  return a;
}

function help() {
  console.log(
    `reconcile.mjs — finding lifecycle + sticky-marker state\n\n` +
      `  --in <file>   input JSON {findings,changedHunks,priorOpenFindings,marker} (else stdin)\n` +
      `  --sha <sha>   head sha to stamp as last_reviewed_sha\n` +
      `  --selftest    run offline fixture test\n` +
      `  --help        this text\n\n` +
      `Emits the tagged findings + updated marker JSON on stdout.\n`,
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return help();
  if (args.selftest) return selftest();
  // Canonical seam input: {findings:[…], changedHunks:[…]} from dedup via --in.
  // The prior marker is NOT in that stream — read it standalone from the PR's
  // sticky comment (#seam1). priorOpenFindings (fp->location) is not recoverable
  // from the marker alone, so absent prior-open fps stay OPEN conservatively (#247).
  const input = readInput(args.in);
  const marker = input.marker === null ? (args.pr ? readMarker(args.pr) : null) : input.marker;
  const cliDismissed = args.dismissed ? args.dismissed.split(/[\s,]+/u).filter(Boolean) : [];
  const newlyDismissed = [...(Array.isArray(input.dismissed) ? input.dismissed : []), ...cliDismissed];
  const out = reconcile({ ...input, marker, sha: args.sha || input.sha || "", newlyDismissed });
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    console.error(e.stack || String(e));
    process.exit(1);
  }
}
