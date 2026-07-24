#!/usr/bin/env node
// =============================================================================
// file-followups.mjs — POST-MERGE ONLY: file stashed P2/P3 as claimable issues
// -----------------------------------------------------------------------------
// After a PR MERGES, the P2/P3 findings that were stashed on it (they did NOT
// gate the merge) become claimable follow-up issues on the tracker.
//
//   * Reads the PR's sticky comment: the `followups` fingerprints from the
//     ocr-state marker + the base64 `ocr-stash` block of full P2/P3 records.
//   * Files ONE claimable issue per follow-up fingerprint, referencing the
//     MERGED sha and linking the PR, typed/labelled per the tanren tracker
//     schema (type bug|enhancement + a bucket + a priority P2/P3).
//   * If the PR was NOT merged, files NOTHING (no orphan issues) and exits 0.
//   * Idempotent: fingerprints already recorded in the marker `filed=` set are
//     skipped, and newly-filed ones are written back to `filed=` so a re-run
//     never double-files.
//
// Input: --pr <N> (a MERGED PR number).
// Deps : node built-ins + `gh` (via GH=). --selftest runs offline against a mock.
// =============================================================================

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Sticky-marker parse/serialize are shared across the review scripts (lib.mjs).
import { parseMarker, serializeMarker } from "./lib.mjs";

// ---- marker helpers (stash block + replace are local to this post-merge step) -
const MARKER_RE = /<!--\s*ocr-state\s+v1\s+([\s\S]*?)-->/u;
const STASH_RE = /<!--\s*ocr-stash\s+([A-Za-z0-9+/=]+)\s*-->/u;

function replaceMarker(body, newMarker) {
  return MARKER_RE.test(body) ? body.replace(MARKER_RE, newMarker) : body + "\n" + newMarker;
}

// ---- gh indirection ---------------------------------------------------------
function gh(args, { json = false, allowFail = false } = {}) {
  const res = spawnSync(process.env.GH || "gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    if (allowFail) return null;
    throw new Error(`gh ${args.join(" ")} failed (${res.status}): ${(res.stderr || "").trim()}`);
  }
  const out = res.stdout || "";
  return json ? JSON.parse(out || "null") : out;
}

function repoSlug() {
  if (process.env.GH_REPO) return process.env.GH_REPO;
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY.includes("/")) return process.env.GITHUB_REPOSITORY;
  return gh(["repo", "view", "--json", "nameWithOwner"], { json: true }).nameWithOwner;
}

// ---- follow-up issue shape (tanren tracker schema) --------------------------
// type: bug|enhancement ; priority: P2|P3 ; a bucket label if provided.
function labelsFor(finding) {
  const labels = [];
  const cat = String(finding.category || "").toLowerCase();
  const typeLabel = /security|bug|correct|crash|leak|race|null/u.test(cat) ? "bug" : "enhancement";
  labels.push(typeLabel);
  const prio = finding.priority === "P3" ? "P3" : "P2";
  labels.push(prio);
  if (finding.bucket) labels.push(String(finding.bucket));
  labels.push("ocr-followup");
  return [...new Set(labels)];
}

function issueBody(finding, { pr, prUrl, mergedSha }) {
  return [
    `## Summary`,
    ``,
    (finding.body || finding.title || "OCR follow-up").trim(),
    ``,
    `## Acceptance`,
    ``,
    `- [ ] Resolve the ${finding.priority || "P2"} finding at \`${finding.path || "unknown"}${Number(finding.start_line) > 0 ? ":" + finding.start_line : ""}\``,
    `- [ ] Add a regression pin so it cannot recur`,
    ``,
    `---`,
    `OCR follow-up stashed from PR #${pr} (${prUrl || ""}), merged as \`${mergedSha}\`.`,
    `Fingerprint: \`${finding.fingerprint}\``,
  ].join("\n");
}

function fileFollowups({ pr, dryRun = false }) {
  const slug = repoSlug();
  const [owner, repo] = slug.split("/");

  // --repo <slug>: CI runs from a non-repo dir; resolve the repo explicitly.
  const view = gh(["pr", "view", String(pr), "--repo", slug, "--json", "number,state,mergedAt,mergeCommit,url,comments"], {
    json: true,
  });
  const merged = view.state === "MERGED" || Boolean(view.mergedAt);
  if (!merged) {
    console.error(`PR #${pr} is not merged (state=${view.state}); discarding follow-ups (no orphan issues).`);
    return { filed: [], skipped: [], merged: false };
  }
  const mergedSha = (view.mergeCommit && view.mergeCommit.oid) || "";

  const sticky = (view.comments || []).find(
    (c) => (c.body || "").includes("<!-- ocr-state") && (c.body || "").includes("<!-- ocr-stash"),
  );
  if (!sticky) {
    console.error(`PR #${pr}: no OCR sticky comment / stash found; nothing to file.`);
    return { filed: [], skipped: [], merged: true };
  }

  const marker = parseMarker(sticky.body);
  const stashMatch = sticky.body.match(STASH_RE);
  let stash = [];
  if (stashMatch) {
    try {
      stash = JSON.parse(Buffer.from(stashMatch[1], "base64").toString("utf8")) || [];
    } catch {
      stash = [];
    }
  }
  const stashByFp = new Map(stash.map((f) => [f.fingerprint, f]));

  const alreadyFiled = new Set(marker.filed);
  const toFile = marker.followups.filter((fp) => !alreadyFiled.has(fp));

  const filed = [];
  const skipped = [];
  for (const fp of toFile) {
    const finding = stashByFp.get(fp) || {
      fingerprint: fp,
      title: "OCR follow-up (record not stashed)",
      priority: "P2",
    };
    const title = `${(finding.priority || "P2").toLowerCase()}: ${String(finding.title || "OCR follow-up")
      .trim()
      .slice(0, 80)}`;
    const body = issueBody(finding, { pr, prUrl: view.url, mergedSha });
    const args = ["issue", "create", "--repo", slug, "--title", title, "--body", body];
    for (const l of labelsFor(finding)) args.push("--label", l);
    if (dryRun) {
      skipped.push({ fp, title });
      continue;
    }
    const url = gh(args, { allowFail: true });
    if (url === null) {
      skipped.push({ fp, title, error: "issue create failed" });
      continue;
    }
    filed.push({ fp, url: String(url).trim(), title });
  }

  // Persist idempotency: record newly-filed fingerprints in the marker.
  if (filed.length > 0 && !dryRun) {
    marker.filed = [...new Set([...marker.filed, ...filed.map((f) => f.fp)])];
    const newBody = replaceMarker(sticky.body, serializeMarker(marker));
    gh(["api", "-X", "PATCH", `repos/${owner}/${repo}/issues/comments/${sticky.id}`, "-f", `body=${newBody}`]);
  }

  for (const f of filed) console.error(`filed follow-up ${f.fp} → ${f.url}`);
  return { filed, skipped, merged: true, mergedSha };
}

// ---- selftest ---------------------------------------------------------------
function writeMockGh(dir, capture, { merged = true } = {}) {
  const stash = Buffer.from(
    JSON.stringify([
      {
        fingerprint: "fpF1",
        title: "improve error message",
        body: "detail",
        priority: "P2",
        category: "style",
        path: "a.ts",
        start_line: 3,
      },
      {
        fingerprint: "fpF2",
        title: "possible null deref",
        body: "detail2",
        priority: "P3",
        category: "bug",
        path: "b.ts",
        start_line: 9,
      },
    ]),
    "utf8",
  ).toString("base64");
  const stickyBody =
    `## OCR review\\nsummary\\n<!-- ocr-stash ${stash} -->\\n` +
    `<!-- ocr-state v1 last_reviewed_sha=deadbeef open= dismissed= followups=fpF1,fpF2 filed=fpF1 -->`;
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
const joined = a.join(" ");
function log(o){ fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(o)+"\\n"); }
function out(o){ process.stdout.write(typeof o==="string"?o:JSON.stringify(o)); }
if (joined.includes("repo view")) { out({ nameWithOwner: "cat-cave/tanren" }); process.exit(0); }
if (joined.includes("pr view")) {
  out({ number: 42, state: ${merged ? '"MERGED"' : '"OPEN"'}, mergedAt: ${merged ? '"2026-01-03T00:00:00Z"' : "null"},
        mergeCommit: { oid: "mergedsha999" }, url: "https://github.com/cat-cave/tanren/pull/42",
        comments: [ { id: 77, body: "${stickyBody}" } ] });
  process.exit(0);
}
if (joined.includes("issue create")) { log({ kind: "create", args: a }); out("https://github.com/cat-cave/tanren/issues/500"); process.exit(0); }
if (joined.includes("PATCH") && joined.includes("issues/comments")) { log({ kind: "patch", args: a }); out("{}"); process.exit(0); }
out("null");
`;
  const p = path.join(dir, "mock-gh.cjs");
  fs.writeFileSync(p, script, { mode: 0o755 });
  return p;
}

async function selftest() {
  // Merged PR: files only the not-yet-filed followup (fpF2), skips fpF1 (already in filed=).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-followup-"));
  const capture = path.join(dir, "calls.jsonl");
  fs.writeFileSync(capture, "");
  process.env.GH = writeMockGh(dir, capture, { merged: true });
  const res = await fileFollowups({ pr: 42 });
  const calls = fs
    .readFileSync(capture, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const creates = calls.filter((c) => c.kind === "create");
  const patch = calls.find((c) => c.kind === "patch");
  const createdTitles = creates.map((c) => c.args.join(" "));
  const patchBody = patch ? patch.args.join(" ") : "";

  // Not-merged PR: files nothing.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-followup2-"));
  const capture2 = path.join(dir2, "calls.jsonl");
  fs.writeFileSync(capture2, "");
  process.env.GH = writeMockGh(dir2, capture2, { merged: false });
  const resNoMerge = await fileFollowups({ pr: 42 });

  const checks = [
    [res.merged === true, "merged PR recognized"],
    [creates.length === 1, "files exactly one issue (fpF2); fpF1 skipped as already filed (idempotent)"],
    [res.filed.length === 1 && res.filed[0].fp === "fpF2", "filed the unfiled followup"],
    [/mergedsha999/u.test(createdTitles.join(" ")), "issue references the MERGED sha"],
    [
      /--label P3/u.test(createdTitles.join(" ")) && /--label bug/u.test(createdTitles.join(" ")),
      "labels per tracker schema (type + priority)",
    ],
    [/filed=fpF1,fpF2/u.test(patchBody), "marker filed= updated for idempotency"],
    [resNoMerge.merged === false && resNoMerge.filed.length === 0, "un-merged PR files NOTHING (no orphan issues)"],
  ];
  let ok = true;
  for (const [pass, name] of checks) {
    console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
    if (!pass) ok = false;
  }
  console.log(ok ? "\nfile-followups selftest PASSED" : "\nfile-followups selftest FAILED");
  if (!ok) process.exit(1);
}

// ---- cli --------------------------------------------------------------------
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--selftest") a.selftest = true;
    else if (t === "--pr") a.pr = Number(argv[++i]);
    else if (t === "--dry-run") a.dryRun = true;
    else a._.push(t);
  }
  return a;
}

function help() {
  console.log(
    `file-followups.mjs — POST-MERGE: file stashed P2/P3 findings as claimable issues\n\n` +
      `  --pr <N>     a MERGED PR number (required)\n` +
      `  --dry-run    print what would be filed, create nothing\n` +
      `  --selftest   run offline fixture test\n` +
      `  --help       this text\n\n` +
      `Files nothing if the PR is not merged. Idempotent via the marker filed= set.\n`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return help();
  if (args.selftest) return selftest();
  if (!args.pr) {
    help();
    process.exit(2);
  }
  const res = await fileFollowups({ pr: args.pr, dryRun: args.dryRun });
  console.error(`done: ${res.filed.length} filed, ${res.skipped.length} skipped, merged=${res.merged}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (e) {
    console.error(e.stack || String(e));
    process.exit(1);
  }
}
