#!/usr/bin/env node
// =============================================================================
// post-review.mjs — post the NATIVE PR review (issues #80 / #158)
// -----------------------------------------------------------------------------
// Posts exactly ONE native review per run (the GitHub reviews endpoint — the
// same object `gh pr review` creates, but via the API so inline comments can
// ride along on the single review):
//
//   * event = REQUEST_CHANGES  iff any OPEN P0/P1 finding this round,
//             else APPROVE. This is a REAL native code review, not advisory
//             comments — Changes requested / Approved shows on the PR. The
//             reviewer is github-actions[bot] (never the PR author) so APPROVE
//             is allowed; a COMMENT fallback covers any config that blocks a bot
//             approval. The `review/verdict` commit status set by verdict.mjs is
//             the machine-enforced merge gate (a bot approval doesn't count toward
//             required-review counts), but the review itself is the actual review.
//
//   * Inline comments only on GROUNDED findings (line in the changed-hunk set).
//     A finding at line 0/0 or otherwise ungrounded is ROLLED INTO the
//     file-level / summary body — NEVER dropped (#80).
//
//   * Inline comments are CAPPED per run (env MAX_INLINE, default 25);
//     overflow rolls into the summary body (#158).
//
//   * Every gh write is throttled and retried with exponential backoff on a
//     GitHub 403 secondary-rate-limit response (#158).
//
//   * The sticky SUMMARY comment (a PR issue comment) is upserted with the
//     running summary, a base64 stash of P2/P3 findings (for file-followups),
//     and the ocr-state marker.
//
// Input JSON (--in <file> | stdin): the reconcile.mjs output —
//   { findings:[…tagged…], addressed:[fp…], marker:"<!-- ocr-state … -->" }
// Also: --pr <N>  (required)   --sha <headSha> (default: PR headRefOid)
//
// Deps: node built-ins + `gh` (via GH=). --selftest runs offline against a mock.
// =============================================================================

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMarker, serializeMarker } from "./lib.mjs";

const ghBin = () => process.env.GH || "gh";
const MAX_INLINE = Number(process.env.MAX_INLINE || 25);
const BACKOFF_MS = Number(process.env.REVIEW_BACKOFF_MS || 2000);
const BACKOFF_TRIES = Number(process.env.REVIEW_BACKOFF_TRIES || 6);
const THROTTLE_MS = Number(process.env.REVIEW_THROTTLE_MS || 0);

const STICKY_HEADER = "## OCR review";

const sleep = (ms) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

// ---- gh indirection with rate-limit backoff ---------------------------------
function ghSync(args, input) {
  const res = spawnSync(ghBin(), args, { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw res.error;
  return res;
}

function isSecondaryRateLimit(stderr) {
  const s = String(stderr || "").toLowerCase();
  return s.includes("secondary rate limit") || s.includes("rate limit") || /\b403\b/u.test(s) || s.includes("abuse");
}

async function gh(args, { json = false, input } = {}) {
  let attempt = 0;
  for (;;) {
    if (THROTTLE_MS) await sleep(THROTTLE_MS);
    const res = ghSync(args, input);
    if (res.status === 0) {
      const out = res.stdout || "";
      return json ? JSON.parse(out || "null") : out;
    }
    if (isSecondaryRateLimit(res.stderr) && attempt < BACKOFF_TRIES) {
      const wait = BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 500);
      attempt++;
      console.error(`gh 403/rate-limit; backoff ${wait}ms (attempt ${attempt}/${BACKOFF_TRIES})`);
      await sleep(wait);
      continue;
    }
    throw new Error(`gh ${args.join(" ")} failed (${res.status}): ${(res.stderr || "").trim()}`);
  }
}

function repoSlug() {
  if (process.env.GH_REPO) return process.env.GH_REPO;
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY.includes("/"))
    return process.env.GITHUB_REPOSITORY;
  const res = ghSync(["repo", "view", "--json", "nameWithOwner"]);
  if (res.status !== 0) throw new Error(`repo view failed: ${res.stderr}`);
  return JSON.parse(res.stdout).nameWithOwner;
}

// ---- body composition -------------------------------------------------------
function isGate(p) {
  return p === "P0" || p === "P1";
}
function isGrounded(f) {
  return f.grounded === true && Number(f.start_line) > 0;
}

// Rewrite the sticky marker's `open` entries so each carries the LOCATION
// (path + line range) of its finding, drawn from the reconciled finding records.
// The prior round can then tell an ADDRESSED finding (its hunk changed) from a
// nondeterministic disappearance (#247). Findings supply the authoritative
// location; a marker fp with no matching finding keeps whatever it already had
// (reconcile-provided location, or bare for legacy/unlocatable).
export function relocateMarker(markerStr, findings) {
  if (!markerStr) return markerStr;
  const state = parseMarker(markerStr);
  const locByFp = new Map();
  for (const f of findings || []) {
    if (!f || !f.fingerprint || f.state === "addressed") continue;
    if (!isGate(f.priority)) continue;
    const s = Number(f.start_line) || 0;
    const e = Number(f.end_line) || s;
    if (f.path && s > 0) locByFp.set(f.fingerprint, { path: f.path, start_line: s, end_line: e });
  }
  state.open = (state.open || []).map((o) => {
    const entry = typeof o === "string" ? { fp: o } : { ...o };
    const loc = locByFp.get(entry.fp);
    return loc ? { fp: entry.fp, path: loc.path, start_line: loc.start_line, end_line: loc.end_line } : entry;
  });
  return serializeMarker(state);
}

export function partitionFindings(findings, maxInline) {
  const open = findings.filter((f) => f.state !== "addressed");
  const grounded = open.filter((f) => isGrounded(f));
  const ungrounded = open.filter((f) => !isGrounded(f));
  const inline = grounded.slice(0, Math.max(0, maxInline));
  const overflow = grounded.slice(Math.max(0, maxInline));
  return { open, inline, overflow, ungrounded };
}

function inlineComment(f) {
  const c = {
    path: f.path,
    body: `${prio(f)} ${bold(f.title)}\n\n${f.body || ""}\n\n<!-- ocr-finding fp=${f.fingerprint} -->`,
    side: "RIGHT",
  };
  const start = Number(f.start_line);
  const end = Number(f.end_line) || start;
  if (end > start) {
    c.start_line = start;
    c.start_side = "RIGHT";
    c.line = end;
  } else {
    c.line = start;
  }
  return c;
}

function prio(f) {
  return `[${f.priority || "P?"}]`;
}
function bold(s) {
  return `**${String(s || "").trim()}**`;
}

function summaryBody({ pr, sha, open, overflow, ungrounded, addressed, marker, stashB64 }) {
  const lines = [STICKY_HEADER, "", `Reviewed head \`${String(sha).slice(0, 12)}\` for PR #${pr}.`, ""];

  const gate = open.filter((f) => isGate(f.priority));
  lines.push(
    gate.length > 0
      ? `**${gate.length} open P0/P1 finding(s) — \`review/verdict\` will FAIL.**`
      : `No open P0/P1 findings — \`review/verdict\` may pass; P2/P3 stashed as follow-ups.`,
    "",
  );

  if (open.length > 0) {
    lines.push("### Findings this round");
    for (const f of open) {
      const loc = Number(f.start_line) > 0 ? `${f.path}:${f.start_line}` : `${f.path} (unlocatable)`;
      lines.push(`- ${prio(f)} ${String(f.title || "").trim()} — \`${loc}\`${f.state ? ` _(${f.state})_` : ""}`);
    }
    lines.push("");
  }

  // Never drop: ungrounded + overflow inline findings live here in full.
  const rolled = [...ungrounded, ...overflow];
  if (rolled.length > 0) {
    lines.push("### Findings not shown inline (rolled into summary — never dropped)");
    for (const f of rolled) {
      lines.push(`- ${prio(f)} ${bold(f.title)} — \`${f.path}${Number(f.start_line) > 0 ? ":" + f.start_line : ""}\``);
      if (f.body) lines.push(`  ${String(f.body).replaceAll(/\s+/gu, " ").trim().slice(0, 500)}`);
    }
    lines.push("");
  }

  if (addressed && addressed.length > 0) {
    lines.push(
      `### Resolved since last review`,
      `${addressed.length} prior finding(s) addressed (hunk changed, no longer raised).`,
      "",
    );
  }

  lines.push(`<!-- ocr-stash ${stashB64} -->`);
  lines.push(marker);
  return lines.join("\n");
}

// ---- native review + sticky upsert ------------------------------------------
async function postReview({ pr, sha, findings, addressed, marker, dryRun = false }) {
  const maxInline = Number(process.env.MAX_INLINE || MAX_INLINE);

  // --dry-run: compute the exact review payload + sticky body from the inputs and
  // the given head sha, print them, and make ZERO gh calls (no read, no write).
  if (dryRun) {
    if (!sha) throw new Error("--dry-run requires --sha/--head (no gh read to derive headRefOid)");
    const { open, inline, overflow, ungrounded } = partitionFindings(findings, maxInline);
    const gateOpen = open.some((f) => isGate(f.priority));
    const event = gateOpen ? "REQUEST_CHANGES" : "APPROVE";
    const stash = open.filter((f) => f.priority === "P2" || f.priority === "P3");
    const stashB64 = Buffer.from(JSON.stringify(stash), "utf8").toString("base64");
    const outMarker = relocateMarker(marker, findings);
    const body = summaryBody({ pr, sha, open, overflow, ungrounded, addressed, marker: outMarker, stashB64 });
    const reviewPayload = {
      commit_id: sha,
      event,
      body: gateOpen
        ? `${STICKY_HEADER}: **Changes requested** — ${open.filter((f) => isGate(f.priority)).length} open P0/P1 finding(s). See the inline comments and the pinned summary.`
        : `${STICKY_HEADER}: **Approved** — no open P0/P1 findings.${stash.length > 0 ? ` ${stash.length} P2/P3 filed as follow-ups.` : ""}`,
      comments: inline.map((f) => inlineComment(f)),
    };
    process.stdout.write(JSON.stringify({ dryRun: true, reviewPayload, summaryBody: body }, null, 2) + "\n");
    return {
      event,
      inlineCount: inline.length,
      rolledUp: overflow.length + ungrounded.length,
      headSha: sha,
      dryRun: true,
    };
  }

  const slug = repoSlug();
  const [owner, repo] = slug.split("/");

  // --repo <slug>: CI runs from a non-repo dir; resolve the repo explicitly.
  const view = await gh(["pr", "view", String(pr), "--repo", slug, "--json", "headRefOid,comments"], { json: true });
  const headSha = sha || view.headRefOid;

  const { open, inline, overflow, ungrounded } = partitionFindings(findings, maxInline);
  // Real native review: REQUEST_CHANGES on open P0/P1, else APPROVE (the reviewer is
  // github-actions[bot], not the PR author, so APPROVE is allowed; COMMENT fallback below).
  const gateOpen = open.some((f) => isGate(f.priority));
  const event = gateOpen ? "REQUEST_CHANGES" : "APPROVE";

  const stash = open.filter((f) => f.priority === "P2" || f.priority === "P3");
  const stashB64 = Buffer.from(JSON.stringify(stash), "utf8").toString("base64");

  const outMarker = relocateMarker(marker, findings);
  const body = summaryBody({ pr, sha: headSha, open, overflow, ungrounded, addressed, marker: outMarker, stashB64 });

  // ONE native review, inline comments attached, bound to the exact head sha.
  const reviewPayload = {
    commit_id: headSha,
    event,
    body: gateOpen
      ? `${STICKY_HEADER}: **Changes requested** — ${open.filter((f) => isGate(f.priority)).length} open P0/P1 finding(s). See the inline comments and the pinned summary.`
      : `${STICKY_HEADER}: **Approved** — no open P0/P1 findings.${stash.length > 0 ? ` ${stash.length} P2/P3 filed as follow-ups.` : ""}`,
    comments: inline.map((f) => inlineComment(f)),
  };
  try {
    await gh(["api", "-X", "POST", `repos/${owner}/${repo}/pulls/${pr}/reviews`, "--input", "-"], {
      input: JSON.stringify(reviewPayload),
    });
  } catch (e) {
    // Fallback: if a bot APPROVE is blocked by repo config, post the same review as a COMMENT.
    if (reviewPayload.event === "APPROVE") {
      reviewPayload.event = "COMMENT";
      await gh(["api", "-X", "POST", `repos/${owner}/${repo}/pulls/${pr}/reviews`, "--input", "-"], {
        input: JSON.stringify(reviewPayload),
      });
    } else {
      throw e;
    }
  }

  // Upsert the sticky summary comment (carries stash + marker).
  const existing = (view.comments || []).find(
    (c) => (c.body || "").includes("<!-- ocr-state") && (c.body || "").includes(STICKY_HEADER),
  );
  if (existing) {
    await gh(["api", "-X", "PATCH", `repos/${owner}/${repo}/issues/comments/${existing.id}`, "-f", `body=${body}`]);
  } else {
    await gh(["api", "-X", "POST", `repos/${owner}/${repo}/issues/${pr}/comments`, "-f", `body=${body}`]);
  }

  return { event, inlineCount: inline.length, rolledUp: overflow.length + ungrounded.length, headSha };
}

// ---- io ---------------------------------------------------------------------
function readInput(inPath) {
  if (inPath) return JSON.parse(fs.readFileSync(inPath, "utf8"));
  if (!process.stdin.isTTY) {
    const raw = fs.readFileSync(0, "utf8");
    if (raw.trim()) return JSON.parse(raw);
  }
  throw new Error("no input: pass --in <file> or pipe reconcile JSON on stdin");
}

// ---- selftest ---------------------------------------------------------------
function writeMockGh(dir, capture) {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
const joined = a.join(" ");
const cap = ${JSON.stringify(capture)};
function log(o){ fs.appendFileSync(cap, JSON.stringify(o)+"\\n"); }
function out(o){ process.stdout.write(typeof o==="string"?o:JSON.stringify(o)); }
if (joined.includes("repo view")) { out({ nameWithOwner: "cat-cave/tanren" }); process.exit(0); }
if (joined.includes("pr view")) { out({ headRefOid: "headsha123456", comments: [] }); process.exit(0); }
if (joined.includes("/reviews")) {
  // read --input - payload from stdin
  let payload = ""; try { payload = fs.readFileSync(0, "utf8"); } catch {}
  log({ kind: "review", payload: JSON.parse(payload || "{}") });
  out({ id: 1 }); process.exit(0);
}
if (joined.includes("/comments")) { log({ kind: "sticky", args: a }); out({ id: 99 }); process.exit(0); }
out("null");
`;
  const p = path.join(dir, "mock-gh.cjs");
  fs.writeFileSync(p, script, { mode: 0o755 });
  return p;
}

async function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-post-"));
  const capture = path.join(dir, "calls.jsonl");
  fs.writeFileSync(capture, "");
  process.env.GH = writeMockGh(dir, capture);
  process.env.MAX_INLINE = "2";

  const findings = [
    {
      fingerprint: "g1",
      path: "a.ts",
      start_line: 10,
      end_line: 12,
      priority: "P0",
      grounded: true,
      title: "sqli",
      body: "bad",
      state: "new",
    },
    {
      fingerprint: "g2",
      path: "b.ts",
      start_line: 20,
      end_line: 20,
      priority: "P1",
      grounded: true,
      title: "authz",
      body: "x",
      state: "carried",
    },
    {
      fingerprint: "g3",
      path: "c.ts",
      start_line: 30,
      end_line: 30,
      priority: "P2",
      grounded: true,
      title: "overflow-inline",
      body: "y",
      state: "new",
    },
    {
      fingerprint: "u1",
      path: "d.ts",
      start_line: 0,
      end_line: 0,
      priority: "P1",
      grounded: false,
      title: "ungrounded",
      body: "z",
      state: "new",
    },
    {
      fingerprint: "a1",
      path: "e.ts",
      start_line: 5,
      end_line: 5,
      priority: "P0",
      grounded: true,
      title: "was resolved",
      state: "addressed",
    },
  ];
  const marker = "<!-- ocr-state v1 last_reviewed_sha=headsha123456 open=g1,g2 dismissed= followups=g3 -->";
  const res = await postReview({ pr: 42, sha: "headsha123456", findings, addressed: ["a1"], marker });

  const calls = fs
    .readFileSync(capture, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const review = calls.find((c) => c.kind === "review");
  const sticky = calls.find((c) => c.kind === "sticky");
  const stickyBody = sticky ? sticky.args.join(" ") : "";

  const checks = [
    [review && review.payload.event === "REQUEST_CHANGES", "event=REQUEST_CHANGES (open P0/P1)"],
    [review && !/advisory/u.test(review.payload.body), "review body is a real decision, not 'advisory comments only'"],
    [review && review.payload.commit_id === "headsha123456", "review bound to exact head sha (#16)"],
    [review && review.payload.comments.length === 2, "inline capped at MAX_INLINE=2 (#158)"],
    [res.rolledUp >= 2, "overflow + ungrounded rolled into summary, not dropped (#80)"],
    [/ocr-stash/u.test(stickyBody), "sticky carries P2/P3 stash for file-followups"],
    [/ocr-state v2/u.test(stickyBody), "sticky carries the v2 ocr-state marker"],
    [/open=g1:a\.ts:10-12/u.test(stickyBody), "open entry populated with finding location (#247 addressed-detection)"],
    [/never dropped/u.test(stickyBody), "ungrounded/overflow section present in summary"],
  ];
  let ok = true;
  for (const [pass, name] of checks) {
    console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
    if (!pass) ok = false;
  }
  console.log(ok ? "\npost-review selftest PASSED" : "\npost-review selftest FAILED");
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
    else if (t === "--pr") a.pr = Number(argv[++i]);
    // --head: workflow alias
    else if (t === "--sha" || t === "--head") a.sha = argv[++i];
    else if (t === "--dry-run") a.dryRun = true;
    else a._.push(t);
  }
  return a;
}

function help() {
  console.log(
    `post-review.mjs — post ONE native PR review + upsert the sticky summary\n\n` +
      `  --pr <N>     PR number (required)\n` +
      `  --sha <sha>  head sha to bind the review to (default: PR headRefOid)\n` +
      `  --in <file>  reconcile JSON {findings,addressed,marker} (else stdin)\n` +
      `  --selftest   run offline fixture test\n` +
      `  --help       this text\n\n` +
      `env: MAX_INLINE (25) REVIEW_BACKOFF_MS (2000) REVIEW_BACKOFF_TRIES (6) REVIEW_THROTTLE_MS (0)\n` +
      `Posts a REAL native review (Approve / Request-changes); the review/verdict status is the enforced gate.\n`,
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
  const input = readInput(args.in);
  const res = await postReview({
    pr: args.pr,
    sha: args.sha,
    findings: input.findings || [],
    addressed: input.addressed || [],
    marker: input.marker || "",
    dryRun: args.dryRun,
  });
  console.error(`posted ${res.event}: ${res.inlineCount} inline, ${res.rolledUp} rolled into summary @ ${res.headSha}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (e) {
    console.error(e.stack || String(e));
    process.exit(1);
  }
}
