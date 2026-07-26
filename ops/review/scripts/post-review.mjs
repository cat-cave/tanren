#!/usr/bin/env node
// =============================================================================
// post-review.mjs — reconcile inline review comments + submit the review only
// on a state change (issues #80 / #158) — NO conversation clog on re-review.
// -----------------------------------------------------------------------------
// Re-reviewing a PR EDITS its prior review artifacts in place instead of piling
// on new ones every push. Three moving parts:
//   * INLINE COMMENTS — reconciled in place, keyed by finding FINGERPRINT (a hidden
//     `<!-- ocr-finding:<fp> -->` marker), read from the bot's existing comments
//     (…/pulls/{pr}/comments --paginate) into an fp map: fp present ⇒ PATCH (DELETE +
//     re-POST on an anchor-line shift — the API can't move a line); new fp ⇒ POST; a
//     bot fp not raised ⇒ DELETE. Line 0/0/ungrounded ⇒ summary, never dropped (#80);
//     MAX_INLINE overflow ⇒ summary; throttle + backoff on every write (#158).
//   * THE REVIEW DECISION — submitted only on a STATE CHANGE. Desired event =
//     REQUEST_CHANGES iff any OPEN P0/P1 finding, else APPROVE. We read the bot's
//     LAST review state and submit a NEW review (POST /reviews — event + short
//     body, NO inline comments[]) ONLY when it differs (or there is no prior review).
//     A dedicated reviewer App can APPROVE; github-actions[bot] cannot → APPROVE
//     downgrades to a COMMENT review whose body matches the event. Head sha (#16).
//   * The sticky SUMMARY comment is upserted (PATCH/POST) — unchanged.
//
// Input JSON (--in <file> | stdin): the reconcile.mjs output —
//   { findings:[…tagged…], addressed:[fp…], marker:"<!-- ocr-state … -->" }
// Also: --pr <N> (required)  --sha <headSha> (default: PR headRefOid)
// Deps: node built-ins + `gh` (via GH=). --selftest runs offline against a mock.
// =============================================================================

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { parseMarker } from "./lib.mjs";
// Pure text/payload composition (extracted to stay under the 500-line cap).
import {
  anchorLine,
  commentPayload,
  inlineBody,
  isGate,
  partitionFindings,
  relocateMarker,
  reviewBody,
  STICKY_HEADER,
  summaryBody,
} from "./review-bodies.mjs";

const ghBin = () => process.env.GH || "gh";
const MAX_INLINE = Number(process.env.MAX_INLINE || 25);
const BACKOFF_MS = Number(process.env.REVIEW_BACKOFF_MS || 2000);
const BACKOFF_TRIES = Number(process.env.REVIEW_BACKOFF_TRIES || 6);
const THROTTLE_MS = Number(process.env.REVIEW_THROTTLE_MS || 0);
// The reviewer identity the trusted lane posts as (a dedicated App login, else
// github-actions[bot]) — scopes existing comments + prior review state to it.
const BOT_LOGIN = process.env.REVIEW_BOT_LOGIN || "github-actions[bot]";

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

// Every inline comment body embeds a hidden `<!-- ocr-finding:<fp> -->` marker —
// the reconciliation KEY (distinct from the sticky ocr-state marker). The
// `ocr-finding:` shape is matched by FINDING_FP_RE here and by assemble-context's
// `ocr-finding[^>]*` title regex. (The body builders that WRITE this marker live
// in review-bodies.mjs; this reader-side regex stays with fetchExisting below.)
const FINDING_FP_RE = /ocr-finding:([^\s>]+)/u;

// ---- existing-state fetch (bot review comments + last bot review) -----------
// Read the bot's existing ocr-finding review comments (paginated, #158) into an
// fp -> {id,path,line} map, and the bot's LAST submitted review state. Scoped to
// BOT_LOGIN so we never touch a human's comments/reviews.
async function fetchExisting({ owner, repo, pr }) {
  const comments = await gh(["api", `repos/${owner}/${repo}/pulls/${pr}/comments`, "--paginate"], { json: true });
  const commentMap = new Map();
  for (const c of comments || []) {
    const body = c.body || "";
    const m = body.match(FINDING_FP_RE);
    if (!m) continue;
    if (BOT_LOGIN && c.user && c.user.login && c.user.login !== BOT_LOGIN) continue;
    // Keep the newest per fp (later page/id wins) so a dup can still be cleaned.
    commentMap.set(m[1], { id: c.id, path: c.path, line: c.line ?? c.original_line ?? null });
  }

  const reviews = await gh(["api", `repos/${owner}/${repo}/pulls/${pr}/reviews`, "--paginate"], { json: true });
  const botReviews = (reviews || []).filter((r) => !BOT_LOGIN || (r.user && r.user.login === BOT_LOGIN));
  const last = botReviews.length > 0 ? botReviews.at(-1) : null;
  return { commentMap, lastReviewState: last ? last.state : null };
}

// Does the bot's last review state already satisfy the desired event? A prior
// APPROVE that repo config downgraded to COMMENT still counts as approved, so an
// APPROVE decision does not re-fire every push (REQUEST_CHANGES never downgrades).
function stateSatisfied(lastState, desiredEvent) {
  if (desiredEvent === "REQUEST_CHANGES") return lastState === "CHANGES_REQUESTED";
  return lastState === "APPROVED" || lastState === "COMMENTED";
}

// Reconcile inline comments in place against existing bot comments. Returns the
// executed (or, in dryRun, intended) plan: per-op tallies + a step list. API limit:
// a comment's line CANNOT be moved by PATCH — on an anchor-line shift we DELETE the
// stale comment and POST a fresh one at the new line.
async function reconcileInline({ owner, repo, pr, headSha, inline, commentMap, dismissed = new Set(), dryRun }) {
  const plan = { post: 0, patch: 0, delete: 0, steps: [] };
  const desired = new Set(inline.map((f) => f.fingerprint));

  const postNew = async (f) => {
    plan.post++;
    plan.steps.push({ op: "POST", fp: f.fingerprint, path: f.path, line: anchorLine(f) });
    if (!dryRun)
      await gh(["api", "-X", "POST", `repos/${owner}/${repo}/pulls/${pr}/comments`, "--input", "-"], {
        input: JSON.stringify(commentPayload(f, headSha)),
      });
  };
  const del = async (id, fp) => {
    plan.delete++;
    plan.steps.push({ op: "DELETE", fp, id });
    if (!dryRun) await gh(["api", "-X", "DELETE", `repos/${owner}/${repo}/pulls/comments/${id}`], { json: false });
  };

  for (const f of inline) {
    const ex = commentMap.get(f.fingerprint);
    if (!ex) {
      await postNew(f);
    } else if (ex.line === anchorLine(f) && ex.path === f.path) {
      plan.patch++;
      plan.steps.push({ op: "PATCH", fp: f.fingerprint, id: ex.id });
      if (!dryRun)
        await gh(["api", "-X", "PATCH", `repos/${owner}/${repo}/pulls/comments/${ex.id}`, "--input", "-"], {
          input: JSON.stringify({ body: inlineBody(f) }),
          json: false,
        });
    } else {
      // Line moved — the API cannot relocate a comment; delete + re-post.
      await del(ex.id, f.fingerprint);
      await postNew(f);
    }
  }

  // Any existing bot ocr-finding comment not raised this round is resolved → delete,
  // UNLESS the fp was maintainer-dismissed (resolved thread / 👎): leave that comment
  // standing as the human record so it is never re-posted (#59/#369).
  for (const [fp, ex] of commentMap) {
    if (!desired.has(fp) && !dismissed.has(fp)) await del(ex.id, fp);
  }
  return plan;
}

// ---- native review + sticky upsert ------------------------------------------
async function postReview({ pr, sha, findings, addressed, marker, reviewComplete = true, dryRun = false }) {
  const maxInline = Number(process.env.MAX_INLINE || MAX_INLINE);

  const { open, inline, overflow, ungrounded } = partitionFindings(findings, maxInline);
  const gateFindings = open.filter((f) => isGate(f.priority));
  const gateOpen = gateFindings.length > 0;
  // FAIL-CLOSED: never APPROVE a review that did not certify. An uncertified run
  // (missing key / crash / partial) requests changes, so the advisory review
  // surface agrees with the fail-closed `review/verdict` gate.
  const certified = reviewComplete === true;
  const event = !certified || gateOpen ? "REQUEST_CHANGES" : "APPROVE";
  const incomplete = !certified;
  const stash = open.filter((f) => f.priority === "P2" || f.priority === "P3");
  const stashB64 = Buffer.from(JSON.stringify(stash), "utf8").toString("base64");
  const outMarker = relocateMarker(marker, findings);

  // --dry-run: compute + print the intended inline plan + review decision + sticky body, ZERO gh calls (no read ⇒ empty state).
  if (dryRun) {
    if (!sha) throw new Error("--dry-run requires --sha/--head (no gh read to derive headRefOid)");
    const body = summaryBody({
      pr,
      sha,
      open,
      overflow,
      ungrounded,
      addressed,
      marker: outMarker,
      stashB64,
      reviewComplete: certified,
    });
    const inlinePlan = await reconcileInline({
      owner: "?",
      repo: "?",
      pr,
      headSha: sha,
      inline,
      commentMap: new Map(),
      dryRun: true,
    });
    const reviewPayload = {
      commit_id: sha,
      event,
      body: reviewBody(event, gateFindings.length, stash.length, { incomplete }),
    };
    process.stdout.write(
      JSON.stringify(
        {
          dryRun: true,
          note: "no gh read in dry-run: existing comments/reviews assumed empty (POST-all, submit-review)",
          reviewDecision: { event, submit: true, reason: "no prior bot review visible in dry-run" },
          inlinePlan,
          reviewPayload,
          summaryBody: body,
        },
        null,
        2,
      ) + "\n",
    );
    return {
      event,
      submitted: true,
      inlineCount: inline.length,
      inlinePlan: { post: inlinePlan.post, patch: inlinePlan.patch, delete: inlinePlan.delete },
      rolledUp: overflow.length + ungrounded.length,
      headSha: sha,
      dryRun: true,
    };
  }

  const slug = repoSlug();
  const [owner, repo] = slug.split("/");

  // --repo <slug>: CI runs from a non-repo dir; resolve the repo explicitly.
  const view = await gh(["pr", "view", String(pr), "--repo", slug, "--json", "headRefOid"], { json: true });
  const headSha = sha || view.headRefOid;

  // Fetch existing bot review comments (fp map) + the bot's last review state.
  const { commentMap, lastReviewState } = await fetchExisting({ owner, repo, pr });

  // Reconcile inline comments IN PLACE (PATCH / POST / DELETE), keyed by fp; a
  // maintainer-dismissed fp's comment is NEVER deleted (left as the human record).
  const dismissed = new Set(parseMarker(marker).dismissed);
  const inlinePlan = await reconcileInline({ owner, repo, pr, headSha, inline, commentMap, dismissed, dryRun: false });

  // Submit a NEW review only on a STATE CHANGE (or when there is no prior bot review).
  const submit = !stateSatisfied(lastReviewState, event);
  if (submit) {
    const reviewPayload = {
      commit_id: headSha,
      event,
      body: reviewBody(event, gateFindings.length, stash.length, { incomplete }),
    };
    try {
      await gh(["api", "-X", "POST", `repos/${owner}/${repo}/pulls/${pr}/reviews`, "--input", "-"], {
        input: JSON.stringify(reviewPayload),
      });
    } catch (e) {
      // The identity may lack the rights for the desired event (github-actions[bot]
      // cannot APPROVE or REQUEST_CHANGES). Downgrade to a COMMENT review whose body
      // matches the situation — for APPROVE (no findings) and for the fail-closed
      // "review did not complete" case. A genuine REQUEST_CHANGES on real findings
      // still surfaces the error (the reviewer App is expected to have the rights).
      if (reviewPayload.event === "APPROVE" || incomplete) {
        reviewPayload.event = "COMMENT";
        reviewPayload.body = reviewBody("COMMENT", gateFindings.length, stash.length, { incomplete });
        await gh(["api", "-X", "POST", `repos/${owner}/${repo}/pulls/${pr}/reviews`, "--input", "-"], {
          input: JSON.stringify(reviewPayload),
        });
      } else {
        throw e;
      }
    }
  }

  // Upsert the sticky summary — always. Read comments via REST (NUMERIC ids); NOT `gh pr
  // view --json comments` (GraphQL node IDs IC_… a REST PATCH 404s on), as inline does.
  const body = summaryBody({
    pr,
    sha: headSha,
    open,
    overflow,
    ungrounded,
    addressed,
    marker: outMarker,
    stashB64,
    reviewComplete: certified,
  });
  const ic = await gh(["api", `repos/${owner}/${repo}/issues/${pr}/comments`, "--paginate"], { json: true });
  const existing = (ic || []).find(
    (c) => (c.body || "").includes("<!-- ocr-state") && (c.body || "").includes(STICKY_HEADER),
  );
  if (existing) {
    await gh(["api", "-X", "PATCH", `repos/${owner}/${repo}/issues/comments/${existing.id}`, "-f", `body=${body}`]);
  } else {
    await gh(["api", "-X", "POST", `repos/${owner}/${repo}/issues/${pr}/comments`, "-f", `body=${body}`]);
  }

  return {
    event,
    submitted: submit,
    inlineCount: inline.length,
    inlinePlan: { post: inlinePlan.post, patch: inlinePlan.patch, delete: inlinePlan.delete },
    rolledUp: overflow.length + ungrounded.length,
    headSha,
  };
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

// ---- selftest (extracted to post-review.selftest.mjs to stay under the line cap) --
async function selftest() {
  const { runSelftest } = await import("./post-review.selftest.mjs");
  const ok = await runSelftest(postReview);
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
    `post-review.mjs — reconcile inline comments in place + submit the review only on a state change\n\n` +
      `  --pr <N>     PR number (required)\n` +
      `  --sha <sha>  head sha to bind the review to (default: PR headRefOid)\n` +
      `  --in <file>  reconcile JSON {findings,addressed,marker} (else stdin)\n` +
      `  --dry-run    compute + print the intended PATCH/POST/DELETE plan + review decision, ZERO gh calls\n` +
      `  --selftest   run offline fixture test\n` +
      `  --help       this text\n\n` +
      `env: MAX_INLINE (25) REVIEW_BOT_LOGIN (github-actions[bot]) REVIEW_BACKOFF_MS (2000) REVIEW_BACKOFF_TRIES (6) REVIEW_THROTTLE_MS (0)\n` +
      `Inline comments are reconciled (PATCH/POST/DELETE by finding fingerprint); a REAL native review\n` +
      `(Approve / Request-changes) is (re-)submitted only when the decision changes. review/verdict is the gate.\n`,
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
    // Fail-closed: an artifact without review_complete is treated as NOT certified.
    reviewComplete: input.review_complete === true,
    dryRun: args.dryRun,
  });
  const p = res.inlinePlan || { post: 0, patch: 0, delete: 0 };
  const decision = res.submitted ? `SUBMITTED ${res.event}` : `unchanged (${res.event} already standing)`;
  console.error(
    `review ${decision} @ ${res.headSha}; inline: ${p.post} posted / ${p.patch} patched / ${p.delete} deleted, ${res.rolledUp} rolled into summary`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (e) {
    console.error(e.stack || String(e));
    process.exit(1);
  }
}
