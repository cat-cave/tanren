#!/usr/bin/env node
// =============================================================================
// assemble-context.mjs — build the OCR --background-file (issues #59 / #324)
// -----------------------------------------------------------------------------
// Input : a PR number.
// Does  : fetches, via the `gh` CLI, everything the reviewer must be aware of but
//         that is NOT in the diff —
//           * prior OCR review findings (our own bot's inline + summary comments),
//           * human / other-bot discussion comments, in thread order,
//           * the PR discussion thread (issue comments + review-thread comments),
//           * the linked issue body (its Acceptance criteria + the REQUIRED
//             negative control).
//         Writes `context.md` and prints its ABSOLUTE path (issue #324 — OCR's
//         --background-file must be absolute).
//         On an INCREMENTAL re-review (a prior OCR sticky-marker exists) it
//         PREPENDS: "Prior findings to verify resolved (do not re-raise): <list>"
//         so the model checks resolution instead of re-litigating (#59).
//
// Deps  : node built-ins + `gh` only. All gh calls route through GH= (default
//         `gh`) so --selftest can point at a mock and stay offline.
//
// Usage : node assemble-context.mjs --pr <N> [--out <dir>] [--sha <headSha>]
//         node assemble-context.mjs --help | --selftest
//   env : REVIEW_WORKDIR  dir for context.md (default: os.tmpdir())
//         GH              gh binary / mock (default: gh)
//         GH_REPO         owner/repo override (else derived from gh)
// Output: prints the absolute path of the written context.md on stdout.
// =============================================================================

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---- gh indirection (GH resolved per-call so selftest can override) ---------
function ghBin() {
  return process.env.GH || "gh";
}
function gh(args, { json = false } = {}) {
  const res = spawnSync(ghBin(), args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed (${res.status}): ${(res.stderr || "").trim()}`);
  }
  const out = res.stdout || "";
  return json ? JSON.parse(out || "null") : out;
}

function repoSlug() {
  if (process.env.GH_REPO) return process.env.GH_REPO;
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY.includes("/")) return process.env.GITHUB_REPOSITORY;
  const r = gh(["repo", "view", "--json", "nameWithOwner"], { json: true });
  return r.nameWithOwner;
}

// A comment is "ours" (a prior OCR finding/summary) iff it carries an OCR marker.
const OCR_MARKER_RE = /<!--\s*ocr-(?:state|finding|stash)\b/u;
const FINDING_TITLE_RE = /<!--\s*ocr-finding[^>]*-->\s*(?:\*\*)?(.+?)(?:\*\*)?\s*(?:\n|$)/gu;

function isOurs(body) {
  return OCR_MARKER_RE.test(body || "");
}

function extractPriorFindingTitles(bodies) {
  const titles = [];
  for (const body of bodies) {
    let m;
    FINDING_TITLE_RE.lastIndex = 0;
    while ((m = FINDING_TITLE_RE.exec(body)) !== null) {
      const t = m[1].trim();
      if (t) titles.push(t);
    }
    // Fallback: bullet lines under an "Open findings" section.
    for (const line of (body || "").split("\n")) {
      const b = line.match(/^\s*[-*]\s+\[(P[0-3])\]\s+(.+)$/u);
      if (b) titles.push(`${b[1]} ${b[2].trim()}`);
    }
  }
  return [...new Set(titles)];
}

// Parse a linked issue number out of a PR body (Closes/Fixes/Resolves #N, or #N).
function linkedIssueFromBody(body) {
  if (!body) return null;
  const kw = body.match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[^#\n]*#(\d+)/iu);
  if (kw) return Number(kw[1]);
  const any = body.match(/#(\d+)/u);
  return any ? Number(any[1]) : null;
}

function extractSection(body, names) {
  // Return the text of the first heading whose title matches one of `names`.
  if (!body) return "";
  const lines = body.split("\n");
  const out = [];
  let capturing = false;
  const nameRe = new RegExp(`^#{1,6}\\s+(${names.join("|")})\\b`, "iu");
  for (const line of lines) {
    if (/^#{1,6}\s+/u.test(line)) {
      // next heading ends the section
      if (capturing) break;
      capturing = nameRe.test(line);
      if (capturing) out.push(line);
      continue;
    }
    if (capturing) out.push(line);
  }
  return out.join("\n").trim();
}

// ---- core -------------------------------------------------------------------
export function buildContextMarkdown({ pr, issue, priorFindingTitles, humanComments, threadEntries }) {
  const parts = [];
  const incremental = priorFindingTitles.length > 0;

  if (incremental) {
    parts.push(
      `> Prior findings to verify resolved (do not re-raise): ` + priorFindingTitles.map((t) => `“${t}”`).join("; "),
      "",
    );
  }

  parts.push(`# Review background for PR #${pr.number} — ${pr.title || ""}`.trim(), "");
  if (pr.url) parts.push(`PR: ${pr.url}`, "");

  // Linked issue: acceptance + negative control are the spec the diff must meet.
  parts.push("## Linked issue (spec / acceptance)");
  if (issue) {
    parts.push(`Issue #${issue.number} — ${issue.title || ""}`.trim(), "");
    const accept = extractSection(issue.body, ["Acceptance", "Acceptance criteria"]);
    const negctl = extractSection(issue.body, ["Negative control", "Required negative control"]);
    if (accept) parts.push("### Acceptance", accept, "");
    if (negctl) parts.push("### Required negative control", negctl, "");
    if (!accept && !negctl) parts.push(issue.body || "(no issue body)", "");
  } else {
    parts.push("(no linked issue found — acceptance/negative-control unknown)", "");
  }

  parts.push("## Prior OCR review findings");
  parts.push(incremental ? priorFindingTitles.map((t) => `- ${t}`).join("\n") : "(none — first review of this PR)", "");

  parts.push("## Human / other-bot comments");
  parts.push(
    humanComments.length > 0 ? humanComments.map((c) => `- **${c.author}**: ${oneLine(c.body)}`).join("\n") : "(none)",
    "",
  );

  parts.push("## Discussion thread (chronological)");
  parts.push(
    threadEntries.length > 0
      ? threadEntries
          .map((c) => `- ${c.ts || ""} **${c.author}**${c.ours ? " (OCR)" : ""}: ${oneLine(c.body)}`)
          .join("\n")
      : "(none)",
    "",
  );

  return parts.join("\n");
}

function oneLine(s) {
  // Strip HTML-comment markers (ocr-state/finding/stash) — they are wrapper
  // bookkeeping, not review signal, and must not pollute the model's context.
  return String(s || "")
    .replaceAll(/<!--[\s\S]*?-->/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, 600);
}

function assemble({ pr, out, sha }) {
  const slug = repoSlug();
  const [owner, repo] = slug.split("/");

  const view = gh(
    // --repo <slug>: CI runs this from a non-repo dir, so gh cannot infer the
    // repo from git — resolve it explicitly (repoSlug → GITHUB_REPOSITORY).
    ["pr", "view", String(pr), "--repo", slug, "--json", "number,title,body,url,headRefOid,comments,reviews,closingIssuesReferences"],
    { json: true },
  );

  // Review-thread (inline) comments — where prior OCR findings live.
  let reviewComments = [];
  try {
    reviewComments = gh(["api", "--paginate", `repos/${owner}/${repo}/pulls/${pr}/comments`], { json: true }) || [];
  } catch {
    reviewComments = [];
  }

  const allComments = [
    ...(view.comments || []).map((c) => ({
      author: (c.author && c.author.login) || "unknown",
      body: c.body || "",
      ts: c.createdAt || "",
    })),
    ...(view.reviews || [])
      .filter((r) => r.body)
      .map((r) => ({ author: (r.author && r.author.login) || "unknown", body: r.body, ts: r.submittedAt || "" })),
    ...reviewComments.map((c) => ({
      author: (c.user && c.user.login) || "unknown",
      body: c.body || "",
      ts: c.created_at || "",
    })),
  ];

  const oursBodies = allComments.filter((c) => isOurs(c.body)).map((c) => c.body);
  const priorFindingTitles = extractPriorFindingTitles(oursBodies);
  const humanComments = allComments.filter((c) => !isOurs(c.body));
  const threadEntries = allComments
    .map((c) => ({ ...c, ours: isOurs(c.body) }))
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  // Linked issue: prefer GraphQL closingIssuesReferences, else parse the body.
  let issue = null;
  const refNum =
    (view.closingIssuesReferences && view.closingIssuesReferences[0] && view.closingIssuesReferences[0].number) ||
    linkedIssueFromBody(view.body);
  if (refNum) {
    try {
      issue = gh(["issue", "view", String(refNum), "--repo", slug, "--json", "number,title,body"], { json: true });
    } catch {
      issue = null;
    }
  }

  const md = buildContextMarkdown({
    pr: { number: view.number, title: view.title, url: view.url },
    issue,
    priorFindingTitles,
    humanComments,
    threadEntries,
  });

  const dir = out || process.env.REVIEW_WORKDIR || os.tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  const headSha = sha || view.headRefOid || "head";
  const file = path.resolve(dir, `ocr-context-PR${pr}-${String(headSha).slice(0, 12)}.md`);
  fs.writeFileSync(file, md, "utf8");
  return file;
}

// ---- selftest ---------------------------------------------------------------
function writeMockGh(dir) {
  const script = `#!/usr/bin/env node
const a = process.argv.slice(2).join(" ");
function out(o){ process.stdout.write(typeof o === "string" ? o : JSON.stringify(o)); }
if (a.includes("repo view")) { out({ nameWithOwner: "cat-cave/tanren" }); }
else if (a.includes("pr view")) {
  out({
    number: 42, title: "add widget", url: "https://github.com/cat-cave/tanren/pull/42",
    headRefOid: "abc1234def5678",
    body: "Implements the thing.\\nCloses #100",
    comments: [
      { author: { login: "alice" }, body: "please add a test", createdAt: "2026-01-01T00:00:00Z" },
      { author: { login: "ocr-bot" }, body: "## OCR review\\n<!-- ocr-state v1 last_reviewed_sha=old open=fp1 dismissed= followups= -->", createdAt: "2026-01-02T00:00:00Z" }
    ],
    reviews: [ { author: { login: "ocr-bot" }, body: "<!-- ocr-finding fp=fp1 -->**P1 SQL injection in query builder**", submittedAt: "2026-01-02T00:00:01Z" } ],
    closingIssuesReferences: [ { number: 100 } ]
  });
}
else if (a.includes("/comments")) { out([]); }
else if (a.includes("issue view")) {
  out({ number: 100, title: "Widget feature", body: "## Summary\\ndo it\\n## Acceptance\\n- widget renders\\n## Required negative control\\n- rejects bad input" });
}
else { out("null"); }
`;
  const p = path.join(dir, "mock-gh.mjs");
  fs.writeFileSync(p, script, { mode: 0o755 });
  return p;
}

async function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-assemble-"));
  process.env.GH = writeMockGh(dir);
  process.env.REVIEW_WORKDIR = dir;
  const file = await assemble({ pr: 42 });
  const md = fs.readFileSync(file, "utf8");
  const checks = [
    [path.isAbsolute(file), "context path is absolute (#324)"],
    [/Prior findings to verify resolved \(do not re-raise\)/u.test(md), "incremental prepend present (#59)"],
    [/SQL injection in query builder/u.test(md), "prior OCR finding surfaced"],
    [/### Acceptance/u.test(md), "linked-issue acceptance extracted"],
    [/### Required negative control/u.test(md), "linked-issue negative control extracted"],
    [/\*\*alice\*\*/u.test(md), "human comment retained"],
    [!/(^|\n)- .*ocr-state/u.test(md), "raw markers not dumped into thread"],
  ];
  let ok = true;
  for (const [pass, name] of checks) {
    console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
    if (!pass) ok = false;
  }
  console.log(ok ? "\nassemble-context selftest PASSED" : "\nassemble-context selftest FAILED");
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
    else if (t === "--out") a.out = argv[++i];
    else if (t === "--sha") a.sha = argv[++i];
    else a._.push(t);
  }
  return a;
}

function help() {
  console.log(
    `assemble-context.mjs — build the OCR --background-file (absolute path printed on stdout)\n\n` +
      `  --pr <N>       PR number (required)\n` +
      `  --out <dir>    output dir (default $REVIEW_WORKDIR or os.tmpdir())\n` +
      `  --sha <sha>    head sha for the filename (default: PR headRefOid)\n` +
      `  --selftest     run offline fixture test\n` +
      `  --help         this text\n`,
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
  const file = await assemble({ pr: args.pr, out: args.out, sha: args.sha });
  process.stdout.write(file + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (e) {
    console.error(e.stack || String(e));
    process.exit(1);
  }
}
