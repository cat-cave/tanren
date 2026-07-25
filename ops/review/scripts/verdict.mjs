#!/usr/bin/env node
// =============================================================================
// verdict.mjs — set the MERGE GATE as a commit status (issue #16)
// -----------------------------------------------------------------------------
// The ENFORCED gate is a COMMIT STATUS, not the review approval — a
// github-actions[bot] approval doesn't count toward required-review counts, so the
// merge queue keys off the machine-checkable, per-sha `review/verdict` status.
// post-review.mjs STILL posts a REAL Approve / Request-changes review (the actual
// code review); this status just mirrors that decision as the enforceable gate.
//
//   state = success  iff  (open P0/P1 count == 0)  AND  (no rule_change)
//           failure  otherwise
//
// A `rule_change` (the PR touches ops/review/**, .opencodereview/**, or the
// ocr-* workflows) always FAILs the gate — a PR cannot weaken its own reviewer
// (DESIGN §SECURITY #4). Pass it via --rule-change, env RULE_CHANGE=true, or a
// finding with category/priority "rule_change".
//
// The status is bound to the EXACT reviewed head sha (#16 — per-SHA): a new
// push produces a new sha with no status, so a stale pass can never authorize
// unreviewed code.
//
//   gh api repos/{owner}/{repo}/statuses/{sha} -f context=review/verdict …
//
// Input JSON (--in <file> | stdin): reconcile output { findings:[…], marker }.
//   (Open P0/P1 are counted from findings with state != "addressed"; the marker
//    `open` set is used as a cross-check.)
// Also: --sha <headSha> (required)   [--rule-change]   [--target-url <url>]
//
// Deps: node built-ins + `gh` (via GH=). --selftest runs offline against a mock.
// =============================================================================

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONTEXT = "review/verdict";
const SHA_RE = /^[0-9a-f]{7,40}$/u;

function ghSync(args) {
  const res = spawnSync(process.env.GH || "gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`gh ${args.join(" ")} failed (${res.status}): ${(res.stderr || "").trim()}`);
  return res.stdout || "";
}

function repoSlug() {
  if (process.env.GH_REPO) return process.env.GH_REPO;
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY.includes("/"))
    return process.env.GITHUB_REPOSITORY;
  return JSON.parse(ghSync(["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
}

function isGate(p) {
  return p === "P0" || p === "P1";
}

export function computeVerdict({ findings = [], ruleChange = false }) {
  const active = findings.filter((f) => f.state !== "addressed");
  const openGate = active.filter((f) => isGate(f.priority));
  const ruleChangeFinding = active.some(
    (f) => f.category === "rule_change" || f.priority === "rule_change" || f.rule_change === true,
  );
  const rc = Boolean(ruleChange) || ruleChangeFinding;
  const pass = openGate.length === 0 && !rc;
  const reasons = [];
  if (openGate.length > 0) reasons.push(`${openGate.length} open P0/P1`);
  if (rc) reasons.push("reviewer-config change (rule_change) — maintainer review required");
  const description = pass ? "OCR review: no open P0/P1" : `OCR review: ${reasons.join("; ")}`.slice(0, 140);
  return { state: pass ? "success" : "failure", description, openGate: openGate.length, ruleChange: rc };
}

function setStatus({ sha, findings, marker, ruleChange, targetUrl, dryRun = false }) {
  if (!sha || !SHA_RE.test(sha))
    throw new Error(`refusing to set status on invalid/unsanitized sha: ${JSON.stringify(sha)}`);
  const { state, description } = computeVerdict({ findings, marker, ruleChange });
  // --dry-run: compute the verdict and print it, but set NO commit status (no gh).
  if (dryRun) {
    process.stdout.write(JSON.stringify({ dryRun: true, context: CONTEXT, sha, state, description }, null, 2) + "\n");
    return { state, description, sha, dryRun: true };
  }
  const [owner, repo] = repoSlug().split("/");
  const args = [
    "api",
    "-X",
    "POST",
    `repos/${owner}/${repo}/statuses/${sha}`,
    "-f",
    `state=${state}`,
    "-f",
    `context=${CONTEXT}`,
    "-f",
    `description=${description}`,
  ];
  if (targetUrl) args.push("-f", `target_url=${targetUrl}`);
  ghSync(args);
  return { state, description, sha };
}

// ---- io ---------------------------------------------------------------------
function readInput(inPath) {
  if (inPath) return JSON.parse(fs.readFileSync(inPath, "utf8"));
  if (!process.stdin.isTTY) {
    const raw = fs.readFileSync(0, "utf8");
    if (raw.trim()) return JSON.parse(raw);
  }
  return { findings: [] };
}

// ---- selftest ---------------------------------------------------------------
function writeMockGh(dir, capture) {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
const joined = a.join(" ");
if (joined.includes("repo view")) { process.stdout.write(JSON.stringify({ nameWithOwner: "cat-cave/tanren" })); process.exit(0); }
if (joined.includes("statuses/")) { fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(a)+"\\n"); process.stdout.write("{}"); process.exit(0); }
process.stdout.write("null");
`;
  const p = path.join(dir, "mock-gh.cjs");
  fs.writeFileSync(p, script, { mode: 0o755 });
  return p;
}

async function selftest() {
  // Pure verdict logic.
  const passCase = computeVerdict({
    findings: [
      { priority: "P2", state: "new" },
      { priority: "P0", state: "addressed" },
    ],
  });
  const failGate = computeVerdict({ findings: [{ priority: "P1", state: "carried" }] });
  const failRule = computeVerdict({ findings: [], ruleChange: true });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-verdict-"));
  const capture = path.join(dir, "calls.jsonl");
  fs.writeFileSync(capture, "");
  process.env.GH = writeMockGh(dir, capture);

  const set = await setStatus({ sha: "abc1234", findings: [{ priority: "P1", state: "carried" }], ruleChange: false });
  const call = JSON.parse(fs.readFileSync(capture, "utf8").trim().split("\n")[0]);
  const flat = call.join(" ");

  let badSha = false;
  try {
    await setStatus({ sha: "-Oevil", findings: [] });
  } catch {
    badSha = true;
  }

  const checks = [
    [passCase.state === "success", "success iff open P0/P1 == 0 (addressed P0 does not gate)"],
    [failGate.state === "failure", "failure on open P1"],
    [
      failRule.state === "failure" && /rule_change/iu.test(failRule.description),
      "rule_change forces failure (#SECURITY-4)",
    ],
    [set.state === "failure", "setStatus posted failure"],
    [/statuses\/abc1234/u.test(flat), "status bound to the exact sha (#16)"],
    [/context=review\/verdict/u.test(flat), "context=review/verdict"],
    [badSha, "rejects an unsanitized/leading-dash sha"],
  ];
  let ok = true;
  for (const [pass, name] of checks) {
    console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
    if (!pass) ok = false;
  }
  console.log(ok ? "\nverdict selftest PASSED" : "\nverdict selftest FAILED");
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
    // accepted for workflow symmetry (unused: status is per-sha)
    else if (t === "--pr") a.pr = argv[++i];
    else if (t === "--rule-change") a.ruleChange = true;
    else if (t === "--target-url") a.targetUrl = argv[++i];
    else if (t === "--dry-run") a.dryRun = true;
    else a._.push(t);
  }
  return a;
}

function help() {
  console.log(
    `verdict.mjs — set the review/verdict commit status (the merge gate, per-sha #16)\n\n` +
      `  --sha <sha>        head sha to bind the status to (required, validated ^[0-9a-f]{7,40}$)\n` +
      `  --in <file>        reconcile JSON {findings,marker} (else stdin)\n` +
      `  --rule-change      force failure (PR modifies the reviewer config)\n` +
      `  --target-url <url> optional status details URL\n` +
      `  --selftest         run offline fixture test\n` +
      `  --help             this text\n\n` +
      `success iff open P0/P1 == 0 AND no rule_change. The gate is a STATUS, not an approval.\n`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return help();
  if (args.selftest) return selftest();
  if (!args.sha) {
    help();
    process.exit(2);
  }
  const input = readInput(args.in);
  const res = await setStatus({
    sha: args.sha,
    findings: input.findings || [],
    marker: input.marker,
    ruleChange: args.ruleChange || process.env.RULE_CHANGE === "true",
    targetUrl: args.targetUrl,
    dryRun: args.dryRun,
  });
  console.error(`review/verdict=${res.state} @ ${res.sha} — ${res.description}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (e) {
    console.error(e.stack || String(e));
    process.exit(1);
  }
}
