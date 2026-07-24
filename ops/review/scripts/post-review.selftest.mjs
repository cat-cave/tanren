#!/usr/bin/env node
// =============================================================================
// post-review.selftest.mjs — offline fixture test for post-review.mjs.
// -----------------------------------------------------------------------------
// Extracted from post-review.mjs to keep that file under the 500-line lint cap.
// `post-review.mjs --selftest` dynamically imports runSelftest() and injects its
// own postReview() so the test drives the real code path. Everything runs against
// a mock `gh` (via GH=) that records WRITE calls and serves READ calls from
// pre-seeded JSON — ZERO network. Asserts the exact POST/PATCH/DELETE-comment and
// POST-review call counts across simulated re-review rounds.
// =============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mock gh: records WRITE calls (comment-create/patch/delete, review-submit,
// sticky) to $MOCK_CAP, and serves READ calls (pr view, review-comment list,
// review list) from pre-seeded JSON in $MOCK_SEED_DIR. Endpoint + method drive
// the arm so the two `…/pulls/{pr}/comments` shapes (GET list vs POST create) and
// the `…/pulls/comments/{id}` shape (PATCH vs DELETE) never collide.
function writeMockGh(dir) {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
const joined = a.join(" ");
const cap = process.env.MOCK_CAP;
const seedDir = process.env.MOCK_SEED_DIR || "";
function log(o){ fs.appendFileSync(cap, JSON.stringify(o)+"\\n"); }
function out(o){ process.stdout.write(typeof o==="string"?o:JSON.stringify(o)); }
function seed(name){ try { return JSON.parse(fs.readFileSync(seedDir+"/"+name,"utf8")); } catch { return []; } }
function stdin(){ try { return fs.readFileSync(0,"utf8"); } catch { return ""; } }
let method = "GET"; const xi = a.indexOf("-X"); if (xi>=0 && a[xi+1]) method = a[xi+1];
const ep = a.find(t=>t.startsWith("repos/")) || "";
if (joined.includes("repo view")) { out({ nameWithOwner: "cat-cave/tanren" }); process.exit(0); }
if (joined.includes("pr view")) { out({ headRefOid: "headsha123456", comments: seed("seed-issue-comments.json") }); process.exit(0); }
if (/\\/pulls\\/\\d+\\/reviews$/.test(ep)) {
  if (method === "POST") { log({ kind: "review-submit", payload: JSON.parse(stdin()||"{}") }); out({ id: 1 }); process.exit(0); }
  out(seed("seed-reviews.json")); process.exit(0);
}
if (/\\/pulls\\/\\d+\\/comments$/.test(ep)) {
  if (method === "POST") { log({ kind: "comment-create", payload: JSON.parse(stdin()||"{}") }); out({ id: Math.floor(Math.random()*1e6) }); process.exit(0); }
  out(seed("seed-comments.json")); process.exit(0);
}
if (/\\/pulls\\/comments\\/\\d+$/.test(ep)) {
  if (method === "DELETE") { log({ kind: "comment-delete", ep }); out(""); process.exit(0); }
  if (method === "PATCH") { log({ kind: "comment-patch", ep, payload: JSON.parse(stdin()||"{}") }); out({ id: 1 }); process.exit(0); }
}
if (/\\/issues\\/comments\\/\\d+$/.test(ep) || /\\/issues\\/\\d+\\/comments$/.test(ep)) { log({ kind: "sticky", args: a }); out({ id: 99 }); process.exit(0); }
out("null");
`;
  const p = path.join(dir, "mock-gh.cjs");
  fs.writeFileSync(p, script, { mode: 0o755 });
  return p;
}

export async function runSelftest(postReview) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-post-"));
  const cap = path.join(dir, "calls.jsonl");
  process.env.GH = writeMockGh(dir);
  process.env.MOCK_CAP = cap;
  process.env.MOCK_SEED_DIR = dir;
  process.env.REVIEW_BOT_LOGIN = "github-actions[bot]";

  const HEAD = "headsha123456";
  const botUser = { login: "github-actions[bot]" };
  const marker = "<!-- ocr-state v1 last_reviewed_sha=headsha123456 open=g1,g2 dismissed= followups= -->";

  // Grounded P0/P1 findings shared across rounds; g5 is the round-2 newcomer.
  const g1 = {
    fingerprint: "g1",
    path: "a.ts",
    start_line: 10,
    end_line: 12,
    priority: "P0",
    grounded: true,
    title: "sqli",
    body: "bad",
    state: "new",
  };
  const g2 = {
    fingerprint: "g2",
    path: "b.ts",
    start_line: 20,
    end_line: 20,
    priority: "P1",
    grounded: true,
    title: "authz",
    body: "x",
    state: "carried",
  };
  const g5 = {
    fingerprint: "g5",
    path: "f.ts",
    start_line: 40,
    end_line: 40,
    priority: "P0",
    grounded: true,
    title: "new-bug",
    body: "n",
    state: "new",
  };

  // Seed a bot review comment for a finding at its anchor line (matches what R1 POSTs).
  const seedComment = (f, id) => ({
    id,
    user: botUser,
    path: f.path,
    line: Number(f.end_line) || Number(f.start_line),
    body: `[${f.priority}] **${f.title}**\n\nx\n\n<!-- ocr-finding:${f.fingerprint} -->`,
  });
  const writeSeeds = ({ comments = [], reviews = [], issueComments = [] } = {}) => {
    fs.writeFileSync(cap, "");
    fs.writeFileSync(path.join(dir, "seed-comments.json"), JSON.stringify(comments));
    fs.writeFileSync(path.join(dir, "seed-reviews.json"), JSON.stringify(reviews));
    fs.writeFileSync(path.join(dir, "seed-issue-comments.json"), JSON.stringify(issueComments));
  };
  const tally = () => {
    const calls = fs
      .readFileSync(cap, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    return {
      calls,
      commentPost: calls.filter((c) => c.kind === "comment-create").length,
      commentPatch: calls.filter((c) => c.kind === "comment-patch").length,
      commentDelete: calls.filter((c) => c.kind === "comment-delete").length,
      reviewPost: calls.filter((c) => c.kind === "review-submit").length,
      review: calls.find((c) => c.kind === "review-submit"),
      sticky: calls.find((c) => c.kind === "sticky"),
    };
  };

  const checks = [];
  const T = (pass, name) => checks.push([pass, name]);

  // ---- ROUND 1: greenfield — no existing bot comments, no prior review --------
  process.env.MAX_INLINE = "25";
  writeSeeds({});
  const r1res = await postReview({ pr: 42, sha: HEAD, findings: [g1, g2], addressed: [], marker });
  const r1 = tally();
  T(r1.commentPost === 2, "R1: 2 grounded findings → 2 POST /pulls/{pr}/comments");
  T(r1.commentPatch === 0 && r1.commentDelete === 0, "R1: no PATCH/DELETE on a greenfield PR");
  T(
    r1.calls.filter((c) => c.kind === "comment-create").every((c) => /ocr-finding:/u.test(c.payload.body)),
    "R1: every POSTed comment body carries an ocr-finding: marker",
  );
  T(r1.reviewPost === 1, "R1: exactly ONE review submitted (no prior bot review)");
  T(r1.review && r1.review.payload.event === "REQUEST_CHANGES", "R1: review event REQUEST_CHANGES (open P0/P1)");
  T(r1.review && r1.review.payload.commit_id === HEAD, "R1: review bound to the exact head sha (#16)");
  T(r1.review && !r1.review.payload.comments, "R1: submitted review carries NO inline comments[] (managed separately)");
  T(r1.review && !/advisory/u.test(r1.review.payload.body), "R1: review body is a real decision, not 'advisory'");
  T(r1res.submitted === true, "R1: result reports submitted=true");

  // ---- ROUND 2: same findings + prior CHANGES_REQUESTED review ----------------
  // Seed round-1 comments (g1,g2) + a now-resolved comment (g4) + prior review.
  const g4resolved = {
    fingerprint: "g4",
    path: "x.ts",
    start_line: 99,
    end_line: 99,
    priority: "P1",
    title: "resolved-since",
  };
  writeSeeds({
    comments: [seedComment(g1, 101), seedComment(g2, 102), seedComment(g4resolved, 104)],
    reviews: [{ user: botUser, state: "CHANGES_REQUESTED" }],
  });
  const r2res = await postReview({ pr: 42, sha: HEAD, findings: [g1, g2, g5], addressed: [], marker });
  const r2 = tally();
  T(r2.commentPost === 1, "R2: only the brand-new finding (g5) → exactly ONE POST");
  T(r2.commentPatch === 2, "R2: the two carried findings (g1,g2) → PATCHed in place, zero new POSTs");
  T(r2.commentDelete === 1, "R2: the resolved finding (g4) → its comment DELETEd");
  T(r2.reviewPost === 0, "R2: state unchanged (still REQUEST_CHANGES) → ZERO new reviews");
  T(r2res.submitted === false, "R2: result reports submitted=false");

  // ---- ROUND 3 (flip): last P0/P1 cleared, prior was REQUEST_CHANGES ----------
  writeSeeds({
    comments: [seedComment(g1, 201)],
    reviews: [{ user: botUser, state: "CHANGES_REQUESTED" }],
  });
  const r3res = await postReview({ pr: 42, sha: HEAD, findings: [], addressed: ["g1"], marker });
  const r3 = tally();
  T(r3.reviewPost === 1, "R3 flip: state flip (0 open P0/P1) → exactly ONE new review submitted");
  T(r3.review && r3.review.payload.event === "APPROVE", "R3 flip: review event APPROVE");
  T(r3.commentPost === 0 && r3.commentPatch === 0, "R3 flip: no new/patched inline comments");
  T(r3.commentDelete === 1, "R3 flip: the cleared finding's comment DELETEd");
  T(r3res.submitted === true, "R3 flip: result reports submitted=true");

  // ---- ROUND 4: cap + never-drop + sticky marker (regression pins) ------------
  process.env.MAX_INLINE = "2";
  writeSeeds({});
  const capFindings = [
    g1,
    g2,
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
  const capMarker = "<!-- ocr-state v1 last_reviewed_sha=headsha123456 open=g1,g2 dismissed= followups=g3 -->";
  const r4res = await postReview({ pr: 42, sha: HEAD, findings: capFindings, addressed: ["a1"], marker: capMarker });
  const r4 = tally();
  const stickyBody = r4.sticky ? r4.sticky.args.join(" ") : "";
  T(r4.commentPost === 2, "R4: inline POSTs capped at MAX_INLINE=2 (#158)");
  T(r4res.rolledUp >= 2, "R4: overflow + ungrounded rolled into summary, not dropped (#80)");
  T(/ocr-stash/u.test(stickyBody), "R4: sticky carries the P2/P3 stash for file-followups");
  T(/ocr-state v2/u.test(stickyBody), "R4: sticky carries the v2 ocr-state marker");
  T(/open=g1:a\.ts:10-12/u.test(stickyBody), "R4: open marker entry carries finding location (#247)");
  T(/never dropped/u.test(stickyBody), "R4: ungrounded/overflow 'never dropped' section present");

  // ---- ROUND 5: dry-run makes ZERO gh calls -----------------------------------
  process.env.MAX_INLINE = "25";
  writeSeeds({});
  const r5res = await postReview({ pr: 42, sha: HEAD, findings: [g1, g2], addressed: [], marker, dryRun: true });
  const r5raw = fs.readFileSync(cap, "utf8").trim();
  T(r5raw === "", "R5 dry-run: ZERO gh calls (no read, no write)");
  T(
    r5res.dryRun === true && r5res.inlinePlan.post === 2 && r5res.submitted === true,
    "R5 dry-run: intended plan computed (2 POST, submit)",
  );

  let ok = true;
  for (const [pass, name] of checks) {
    console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
    if (!pass) ok = false;
  }
  console.log(ok ? "\npost-review selftest PASSED" : "\npost-review selftest FAILED");
  return ok;
}
