#!/usr/bin/env node
// =============================================================================
// lib.mjs — shared primitives for the OCR review layer (seam de-duplication)
// -----------------------------------------------------------------------------
// The 10 review scripts were authored independently and each re-implemented the
// same two primitives, with subtle drift risk:
//   * the SEMANTIC fingerprint (ground-findings.mjs + dedup.mjs), and
//   * the sticky-marker parse/serialize (reconcile.mjs + file-followups.mjs).
// They are hoisted here VERBATIM so every seam agrees byte-for-byte, plus one
// new primitive the pipeline needed but nobody owned:
//   * readMarker(pr, {gh}) — fetch the PRIOR sticky comment and return its
//     parsed ocr-state marker, so dedup (open/dismissed fps) and reconcile
//     (marker + prior state) can read it standalone instead of each re-deriving.
//
// Deps: node built-ins + `gh` (via GH=, injectable) only.
// =============================================================================

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

// ---- semantic fingerprint (byte-identical to the old ground/dedup copies) ----
// fingerprint = sha1( normPath(path) + " " + symbol + " " + normClaim(claim) )
//   normPath : lowercase, backslash->slash, strip leading ./
//   symbol   : first backtick-quoted token, lowercased
//   normClaim: lowercase, strip urls, digits (line numbers), punctuation
export function normPath(p) {
  return String(p || "")
    .trim()
    .toLowerCase()
    .replaceAll("\\", "/")
    .replace(/^\.?\/+/u, "");
}
export function extractSymbol(text) {
  // first backtick-quoted token
  const m = String(text || "").match(/`([^`]+)`/u);
  return m ? m[1].trim().toLowerCase() : "";
}
export function normClaim(text) {
  return (
    String(text || "")
      .toLowerCase()
      .replaceAll(/https?:\/\/\S+/gu, " ")
      // strip line numbers / any digits
      .replaceAll(/[0-9]+/gu, " ")
      // strip punctuation
      .replaceAll(/[^a-z\s]/gu, " ")
      .replaceAll(/\s+/gu, " ")
      .trim()
  );
}
export function fingerprint(path, claimText) {
  const h = createHash("sha1");
  h.update(normPath(path) + " " + extractSymbol(claimText) + " " + normClaim(claimText));
  return h.digest("hex");
}

// ---- sticky-marker parse / serialize ----------------------------------------
// v2 extends v1: `open` entries may carry the finding's LOCATION so reconcile can
// tell an ADDRESSED finding (hunk changed) from a nondeterministic disappearance
// (#247). An open entry serializes as `fp:path:start-end` when located, else bare
// `fp` (the v1 form). BOTH v1 and v2 markers PARSE (bare-fp entries carry null
// location). `dismissed`/`followups`/`filed` stay bare-fp lists in both versions.
//   parseMarker → open: [{fp, path|null, start_line|null, end_line|null}, …]
//   serializeMarker accepts that shape (or a bare-string fp) for open.
const MARKER_VERSION = "2";
const MARKER_RE = /<!--\s*ocr-state\s+v\d+\s+([\s\S]*?)-->/u;
const KNOWN = new Set(["last_reviewed_sha", "open", "dismissed", "followups", "filed"]);
const BARE_LIST_KEYS = new Set(["dismissed", "followups", "filed"]);

// Parse one `open` token: bare `fp` (v1) or `fp:path:start-end` (v2). A fingerprint
// never contains ':' so any ':' marks a located entry; a malformed range degrades to
// path-only / bare rather than throwing.
export function parseOpenEntry(tok) {
  const ci = tok.indexOf(":");
  if (ci < 0) return { fp: tok, path: null, start_line: null, end_line: null };
  const fp = tok.slice(0, ci);
  const rest = tok.slice(ci + 1);
  const di = rest.lastIndexOf(":");
  if (di < 0) return { fp, path: rest || null, start_line: null, end_line: null };
  const path = rest.slice(0, di) || null;
  const m = rest.slice(di + 1).match(/^(\d+)-(\d+)$/u);
  if (!m) return { fp, path, start_line: null, end_line: null };
  return { fp, path, start_line: Number(m[1]), end_line: Number(m[2]) };
}

// Serialize one `open` entry to a token. Accepts the object shape or a bare fp string.
export function serializeOpenEntry(o) {
  if (typeof o === "string") return o;
  if (!o || !o.fp) return "";
  const s = Number(o.start_line);
  const e = Number(o.end_line);
  if (o.path && s > 0 && e > 0) return `${o.fp}:${o.path}:${s}-${e}`;
  return o.fp;
}

export function parseMarker(text) {
  const base = {
    version: MARKER_VERSION,
    last_reviewed_sha: "",
    open: [],
    dismissed: [],
    followups: [],
    filed: [],
    extra: {},
  };
  if (!text) return base;
  const m = String(text).match(MARKER_RE);
  if (!m) return base;
  const vm = String(text).match(/ocr-state\s+v(\d+)/u);
  if (vm) base.version = vm[1];
  for (const tok of m[1].trim().split(/\s+/u)) {
    const i = tok.indexOf("=");
    if (i < 0) continue;
    const k = tok.slice(0, i);
    const v = tok.slice(i + 1);
    if (k === "last_reviewed_sha") base.last_reviewed_sha = v;
    else if (k === "open")
      base.open = v
        ? v
            .split(",")
            .filter(Boolean)
            .map((t) => parseOpenEntry(t))
        : [];
    else if (BARE_LIST_KEYS.has(k)) base[k] = v ? v.split(",").filter(Boolean) : [];
    else base.extra[k] = v;
  }
  return base;
}

export function serializeMarker(s) {
  const open = (s.open || []).map((o) => serializeOpenEntry(o)).filter(Boolean);
  const parts = [
    `last_reviewed_sha=${s.last_reviewed_sha || ""}`,
    `open=${open.join(",")}`,
    `dismissed=${(s.dismissed || []).join(",")}`,
    `followups=${(s.followups || []).join(",")}`,
  ];
  if (s.filed && s.filed.length > 0) parts.push(`filed=${s.filed.join(",")}`);
  for (const [k, v] of Object.entries(s.extra || {})) if (!KNOWN.has(k)) parts.push(`${k}=${v}`);
  return `<!-- ocr-state v${MARKER_VERSION} ${parts.join(" ")} -->`;
}

// ---- gh indirection (default runner; injectable for offline tests) ----------
export function defaultGh(args, { json = false } = {}) {
  const res = spawnSync(process.env.GH || "gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`gh ${args.join(" ")} failed (${res.status}): ${(res.stderr || "").trim()}`);
  const out = res.stdout || "";
  return json ? JSON.parse(out || "null") : out;
}

// ---- repo resolution (CI-safe) ----------------------------------------------
// In CI the pipeline runs from a directory that is NOT the target repo's git
// root (a split base/head checkout, or a bare workspace), so `gh` cannot infer
// the repo from git remotes — it crashes with "not a git repository". Resolve
// the slug from the env GitHub always sets (GITHUB_REPOSITORY) or an explicit
// GH_REPO override, and pass it to every git-inferring gh call via `--repo`.
// Returns null only outside CI with no override (local runs in a normal repo,
// where git inference works and `--repo` is unnecessary).
export function repoSlug() {
  const r = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || "";
  return r.includes("/") ? r : null;
}
export function repoArgs() {
  const s = repoSlug();
  return s ? ["--repo", s] : [];
}

// ---- readMarker: fetch the prior sticky comment's ocr-state marker ----------
// Returns the parseMarker() shape: {version,last_reviewed_sha,open,dismissed,
// followups,filed,extra}. Empty marker if the PR has no OCR sticky comment yet.
// `gh` is injectable (for offline tests / GH= mock); defaults to defaultGh.
export function readMarker(pr, { gh = defaultGh } = {}) {
  let view;
  try {
    view = gh(["pr", "view", String(pr), ...repoArgs(), "--json", "comments"], { json: true });
  } catch {
    return parseMarker("");
  }
  const comments = (view && view.comments) || [];
  const sticky = comments.find((c) => MARKER_RE.test(c.body || ""));
  return parseMarker(sticky ? sticky.body : "");
}

// ---- selftest (codec round-trip; offline) -----------------------------------
function selftest() {
  const checks = [];
  const T = (pass, name) => checks.push([pass, name]);

  // v1 legacy marker: bare-fp open entries parse with null location.
  const v1 = "<!-- ocr-state v1 last_reviewed_sha=old open=fpA,fpB dismissed=fpD followups=fpF filed=fpX -->";
  const p1 = parseMarker(v1);
  T(p1.version === "1", "v1 marker parses (version=1)");
  T(
    p1.open.length === 2 && p1.open[0].fp === "fpA" && p1.open[0].path === null,
    "v1 open entries are bare fps, null location",
  );
  T(p1.dismissed[0] === "fpD" && p1.followups[0] === "fpF" && p1.filed[0] === "fpX", "v1 bare lists parse");

  // v2 marker: located open entries round-trip.
  const state = {
    last_reviewed_sha: "sha1",
    open: [
      { fp: "fp1", path: "src/a.ts", start_line: 10, end_line: 20 },
      // unlocated → serializes bare
      { fp: "fp2" },
    ],
    dismissed: ["fpD"],
    followups: ["fpF"],
    filed: [],
    extra: {},
  };
  const ser = serializeMarker(state);
  T(/ocr-state v2 /u.test(ser), "serialize emits v2");
  T(ser.includes("open=fp1:src/a.ts:10-20,fp2"), "located + bare open co-serialize");
  const rp = parseMarker(ser);
  T(
    rp.open[0].path === "src/a.ts" && rp.open[0].start_line === 10 && rp.open[0].end_line === 20,
    "v2 located entry round-trips",
  );
  T(rp.open[1].fp === "fp2" && rp.open[1].path === null, "v2 bare entry round-trips");

  // path with a colon-free range guard: malformed range degrades, never throws.
  const badRange = parseOpenEntry("fpZ:some/path.ts:notarange");
  T(
    badRange.fp === "fpZ" && badRange.path === "some/path.ts" && badRange.start_line === null,
    "malformed range degrades to path-only",
  );

  let ok = true;
  for (const [pass, name] of checks) {
    console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
    if (!pass) ok = false;
  }
  console.log(ok ? "\nlib codec selftest PASSED" : "\nlib codec selftest FAILED");
  if (!ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--selftest")) selftest();
  else console.log("lib.mjs — shared OCR review primitives (import me). Run --selftest for the codec test.");
}
