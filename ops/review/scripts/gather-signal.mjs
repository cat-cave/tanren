#!/usr/bin/env node
// =============================================================================
// gather-signal.mjs — HUMAN-SIGNAL layer for the OCR review pipeline (#59/#369)
// -----------------------------------------------------------------------------
// A maintainer's action on a bot finding's inline review comment is the ground
// truth the advisory reviewer must obey. Two signals mean "false positive — never
// resurface this finding":
//   * RESOLVING the finding's review thread (GitHub "Resolve conversation"), and
//   * reacting 👎 (-1) on the finding comment (with >= the 👍 count).
// A 👍 (+1)-dominant reaction means "confirmed — a real defect" (recorded, not
// gate-changing here; the verdict still comes from priority).
//
// Each bot inline comment embeds `<!-- ocr-finding:<fp> -->`. We map fp->commentId
// from the bot's review comments, read each comment's reactions, and read the PR's
// review threads (GraphQL) for resolution — then emit the dismissed/confirmed fps.
// Downstream: the dismissed set is UNIONed into the sticky marker's `dismissed`
// list (dedup drops it, reconcile persists it) so the finding never resurfaces.
//
// Read-only: LISTs comments/reactions/reviewThreads with a read token (the GraphQL
// query works with `pull-requests: read`). Never writes. Runs in the UNTRUSTED lane
// BEFORE dedup; its `dismissed` output threads into dedup + reconcile.
//
// Usage:
//   node gather-signal.mjs --pr <N>            # repo via GH_REPO/GITHUB_REPOSITORY
//   node gather-signal.mjs --selftest
// Out: {dismissed:[fp…], confirmed:[fp…]} on stdout; `dismissed=<csv>` to
//      $GITHUB_OUTPUT (for the workflow to thread into dedup/reconcile).
// Env: REVIEW_BOT_LOGIN (default github-actions[bot]).
// Deps: node built-ins + `gh` (via GH=, injectable) only.
// =============================================================================

import fs from "node:fs";
import { defaultGh, repoSlug } from "./lib.mjs";

// The bot whose review comments + resolved threads carry human signal. Scope to
// it so a human's own comment/reaction is never misread as the bot's finding.
const BOT_LOGIN = process.env.REVIEW_BOT_LOGIN || "github-actions[bot]";

// The hidden marker every bot inline finding comment carries (post-review.mjs).
const FINDING_FP_RE = /ocr-finding:([^\s>]+)/u;

// GraphQL: the PR's review threads, each with its resolution flag + FIRST comment
// (the bot's finding comment, if the thread is one of ours). `$cursor:String`
// defaults to null when unprovided → first page.
const THREADS_QUERY = `query($owner:String!,$name:String!,$pr:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$pr){
      reviewThreads(first:100,after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{ isResolved comments(first:1){ nodes{ body author{login} } } }
      }
    }
  }
}`;

function ownerRepo(gh) {
  const slug = repoSlug();
  if (slug) return slug.split("/");
  const v = gh(["repo", "view", "--json", "nameWithOwner"], { json: true });
  const s = String((v && v.nameWithOwner) || "");
  if (!s.includes("/")) throw new Error("cannot resolve owner/repo (set GH_REPO or GITHUB_REPOSITORY)");
  return s.split("/");
}

// fp -> commentId for the bot's ocr-finding inline comments (later page/id wins).
function findingComments(gh, owner, repo, pr) {
  const comments = gh(["api", `repos/${owner}/${repo}/pulls/${pr}/comments`, "--paginate"], { json: true }) || [];
  const map = new Map();
  for (const c of comments) {
    const login = c.user && c.user.login;
    if (BOT_LOGIN && login !== BOT_LOGIN) continue;
    const m = String(c.body || "").match(FINDING_FP_RE);
    if (m) map.set(m[1], c.id);
  }
  return map;
}

// A 👎 (>= the 👍 count) ⇒ dismissed; else a 👍-dominant reaction ⇒ confirmed.
function classifyReactions(gh, owner, repo, id) {
  const reactions =
    gh(["api", `repos/${owner}/${repo}/pulls/comments/${id}/reactions`, "--paginate"], { json: true }) || [];
  let up = 0;
  let down = 0;
  for (const r of reactions) {
    if (r.content === "+1") up++;
    else if (r.content === "-1") down++;
  }
  if (down > 0 && down >= up) return "dismissed";
  if (up > 0) return "confirmed";
  return "none";
}

// fps of bot findings whose review thread the maintainer marked resolved.
function resolvedFindingFps(gh, owner, repo, pr) {
  const dismissed = new Set();
  let cursor = null;
  for (;;) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${THREADS_QUERY}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${repo}`,
      "-F",
      `pr=${pr}`,
    ];
    if (cursor) args.push("-F", `cursor=${cursor}`);
    const res = gh(args, { json: true });
    const threads =
      res && res.data && res.data.repository && res.data.repository.pullRequest
        ? res.data.repository.pullRequest.reviewThreads
        : null;
    if (!threads) break;
    for (const t of threads.nodes || []) {
      if (!t || t.isResolved !== true) continue;
      const first = t.comments && t.comments.nodes && t.comments.nodes[0];
      if (!first) continue;
      const login = first.author && first.author.login;
      if (BOT_LOGIN && login !== BOT_LOGIN) continue;
      const m = String(first.body || "").match(FINDING_FP_RE);
      if (m) dismissed.add(m[1]);
    }
    if (!threads.pageInfo || !threads.pageInfo.hasNextPage) break;
    cursor = threads.pageInfo.endCursor;
  }
  return dismissed;
}

// ---- pure core (gh injected) ------------------------------------------------
export function gatherSignal({ pr, gh = defaultGh } = {}) {
  const [owner, repo] = ownerRepo(gh);
  const fpToComment = findingComments(gh, owner, repo, pr);

  const dismissed = new Set();
  const confirmed = new Set();
  for (const [fp, id] of fpToComment) {
    const verdict = classifyReactions(gh, owner, repo, id);
    if (verdict === "dismissed") dismissed.add(fp);
    else if (verdict === "confirmed") confirmed.add(fp);
  }

  for (const fp of resolvedFindingFps(gh, owner, repo, pr)) dismissed.add(fp);

  // Dismissal wins over a stale 👍 — a resolved/👎 finding is never "confirmed".
  return { dismissed: [...dismissed], confirmed: [...confirmed].filter((fp) => !dismissed.has(fp)) };
}

// ---- cli --------------------------------------------------------------------
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--selftest") a.selftest = true;
    else if (t === "--pr") a.pr = argv[++i];
  }
  return a;
}

const HELP = `gather-signal.mjs — resolved threads + 👎 reactions ⇒ dismissed (human signal)

  node gather-signal.mjs --pr <N>
  node gather-signal.mjs --selftest

Reads the bot's ocr-finding inline comments + their reactions + the PR's review
threads (read-only gh). Emits {dismissed:[fp…],confirmed:[fp…]} on stdout and
appends dismissed=<csv> to $GITHUB_OUTPUT.`;

function emit(result) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `dismissed=${result.dismissed.join(",")}\n`);
  }
}

// ---- selftest (offline; mock gh serves REST comments+reactions + graphql) ----
const BOT = { login: "github-actions[bot]" };
const HUMAN = { login: "maintainer" };
const mkFp = (s) => s.repeat(40).slice(0, 40);
const mkComment = (id, fpv, user) => ({ id, user, body: `[P1] **x**\n\ny\n\n<!-- ocr-finding:${fpv} -->` });

function selftest() {
  process.env.GH_REPO = "cat-cave/tanren";
  // FP_DOWN: 👎 → dismissed. FP_UP: 👍-only → confirmed, not dismissed.
  // FP_RESOLVED: resolved thread → dismissed. FP_HUMAN: non-bot comment → ignored.
  const FP_DOWN = mkFp("a");
  const FP_UP = mkFp("b");
  const FP_RESOLVED = mkFp("c");
  const FP_HUMAN = mkFp("d");

  const restComments = [
    mkComment(1, FP_DOWN, BOT),
    mkComment(2, FP_UP, BOT),
    mkComment(3, FP_RESOLVED, BOT),
    // non-bot author → skipped
    mkComment(4, FP_HUMAN, HUMAN),
  ];
  const reactionsById = {
    // down >= up → dismissed
    1: [{ content: "-1" }, { content: "+1" }],
    // up-only → confirmed
    2: [{ content: "+1" }, { content: "+1" }],
    // no reaction; resolved via the thread below
    3: [],
  };
  const graphqlResp = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              // resolved bot thread → FP_RESOLVED dismissed
              { isResolved: true, comments: { nodes: [{ body: `<!-- ocr-finding:${FP_RESOLVED} -->`, author: BOT }] } },
              // resolved but NOT the bot → ignored
              { isResolved: true, comments: { nodes: [{ body: `<!-- ocr-finding:${FP_UP} -->`, author: HUMAN }] } },
              // bot thread but NOT resolved → ignored (FP_DOWN must come from 👎)
              { isResolved: false, comments: { nodes: [{ body: `<!-- ocr-finding:${FP_DOWN} -->`, author: BOT }] } },
            ],
          },
        },
      },
    },
  };

  const mockGh = (args) => {
    if (args[0] === "api" && args[1] === "graphql") return graphqlResp;
    const ep = args.find((t) => typeof t === "string" && t.startsWith("repos/")) || "";
    if (/\/pulls\/\d+\/comments$/u.test(ep)) return restComments;
    const rm = ep.match(/\/pulls\/comments\/(\d+)\/reactions$/u);
    if (rm) return reactionsById[rm[1]] || [];
    return null;
  };

  const r = gatherSignal({ pr: 7, gh: mockGh });
  const checks = [
    [r.dismissed.includes(FP_DOWN), "👎 finding lands in dismissed"],
    [r.dismissed.includes(FP_RESOLVED), "resolved-thread finding lands in dismissed"],
    [!r.dismissed.includes(FP_UP), "👍-only finding is NOT dismissed"],
    [r.confirmed.includes(FP_UP), "👍-only finding is recorded confirmed"],
    [!r.dismissed.includes(FP_HUMAN) && !r.confirmed.includes(FP_HUMAN), "non-bot comment's fp is ignored"],
  ];
  let ok = true;
  for (const [pass, name] of checks) {
    console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
    if (!pass) ok = false;
  }
  console.log(ok ? "\ngather-signal selftest PASSED" : "\ngather-signal selftest FAILED");
  if (!ok) process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  if (args.selftest) return selftest();
  if (!args.pr) {
    console.log(HELP);
    process.exit(2);
  }
  emit(gatherSignal({ pr: Number(args.pr) }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    console.error(e.stack || String(e));
    process.exit(1);
  }
}
