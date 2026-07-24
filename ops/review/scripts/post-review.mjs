#!/usr/bin/env node
// =============================================================================
// post-review.mjs — reconcile inline review comments + submit the review only
// on a state change (issues #80 / #158) — NO conversation clog on re-review.
// -----------------------------------------------------------------------------
// Re-reviewing a PR EDITS its prior review artifacts in place instead of piling
// on new ones every push. Three moving parts:
//   * INLINE COMMENTS — reconciled in place, keyed by finding FINGERPRINT (a
//     hidden `<!-- ocr-finding:<fp> -->` marker in each body). Each run reads the
//     bot's existing ocr-finding comments (…/pulls/{pr}/comments --paginate, #158)
//     into an fp -> {id,path,line} map, then per GROUNDED finding: fp present ⇒
//     PATCH the body (or, since the API cannot move a comment's line, DELETE +
//     re-POST when the anchor line shifted); new fp ⇒ POST a standalone review
//     comment; any existing bot fp NOT raised this round ⇒ DELETE (resolved).
//     Line 0/0 / ungrounded ⇒ summary, never dropped (#80); MAX_INLINE cap ⇒
//     overflow to summary (#158); throttle + backoff around every write (#158).
//   * THE REVIEW DECISION — submitted only on a STATE CHANGE. Desired event =
//     REQUEST_CHANGES iff any OPEN P0/P1 finding, else APPROVE. We read the bot's
//     LAST review state and submit a NEW review (POST /reviews — event + short
//     body, NO inline comments[]) ONLY when it differs (or there is no prior bot
//     review). Reviewer github-actions[bot] so APPROVE is allowed (COMMENT
//     fallback if config blocks a bot approve), bound to head sha (#16).
//   * The sticky SUMMARY comment is upserted (PATCH/POST) — unchanged.
//
// Input JSON (--in <file> | stdin): the reconcile.mjs output —
//   { findings:[…tagged…], addressed:[fp…], marker:"<!-- ocr-state … -->" }
// Also: --pr <N> (required)  --sha <headSha> (default: PR headRefOid)
// Deps: node built-ins + `gh` (via GH=). --selftest runs offline against a mock.
// =============================================================================

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { parseMarker, serializeMarker } from "./lib.mjs";

const ghBin = () => process.env.GH || "gh";
const MAX_INLINE = Number(process.env.MAX_INLINE || 25);
const BACKOFF_MS = Number(process.env.REVIEW_BACKOFF_MS || 2000);
const BACKOFF_TRIES = Number(process.env.REVIEW_BACKOFF_TRIES || 6);
const THROTTLE_MS = Number(process.env.REVIEW_THROTTLE_MS || 0);
// The bot the trusted workflow posts as (GITHUB_TOKEN ⇒ github-actions[bot]).
// Used to scope existing review comments + prior review state to OUR bot.
const BOT_LOGIN = process.env.REVIEW_BOT_LOGIN || "github-actions[bot]";

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

// Every inline comment body embeds a hidden `<!-- ocr-finding:<fp> -->` marker —
// the reconciliation KEY (distinct from the sticky ocr-state marker). The
// `ocr-finding:` shape is matched by FINDING_FP_RE here and by assemble-context's
// `ocr-finding[^>]*` title regex.
const FINDING_FP_RE = /ocr-finding:([^\s>]+)/u;

function inlineBody(f) {
  return `${prio(f)} ${bold(f.title)}\n\n${f.body || ""}\n\n<!-- ocr-finding:${f.fingerprint} -->`;
}

// The line a comment anchors to (the hunk end, or the single line). GitHub reports
// this back as the comment's `line`, so it is the value we diff to detect a move.
function anchorLine(f) {
  const start = Number(f.start_line);
  const end = Number(f.end_line) || start;
  return end > start ? end : start;
}

// A standalone review comment payload (POST /pulls/{pr}/comments): carries its own
// commit_id (a review-attached comment inherits the review's, a standalone one does
// not), path, line/range, side, and the fp-marked body.
function commentPayload(f, headSha) {
  const start = Number(f.start_line);
  const end = Number(f.end_line) || start;
  const c = { commit_id: headSha, path: f.path, body: inlineBody(f), side: "RIGHT" };
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

// Reconcile inline comments in place against the existing bot comments. Returns
// the executed (or, in dryRun, the intended) plan: per-op tallies + a step list.
// GitHub-API limitation worked around: a review comment's line CANNOT be moved by
// PATCH — when a finding's anchor line shifts we DELETE the stale comment and POST
// a fresh one at the new line.
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
      // Line moved — the API cannot relocate a comment; delete + repost.
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

// The short body a submitted review carries (NO inline comments[] — those are
// managed by reconcileInline; the review is only the decision).
function reviewBody(gateOpen, gateCount, stashCount) {
  return gateOpen
    ? `${STICKY_HEADER}: **Changes requested** — ${gateCount} open P0/P1 finding(s). See the inline comments and the pinned summary.`
    : `${STICKY_HEADER}: **Approved** — no open P0/P1 findings.${stashCount > 0 ? ` ${stashCount} P2/P3 filed as follow-ups.` : ""}`;
}

// ---- native review + sticky upsert ------------------------------------------
async function postReview({ pr, sha, findings, addressed, marker, dryRun = false }) {
  const maxInline = Number(process.env.MAX_INLINE || MAX_INLINE);

  const { open, inline, overflow, ungrounded } = partitionFindings(findings, maxInline);
  const gateFindings = open.filter((f) => isGate(f.priority));
  const gateOpen = gateFindings.length > 0;
  const event = gateOpen ? "REQUEST_CHANGES" : "APPROVE";
  const stash = open.filter((f) => f.priority === "P2" || f.priority === "P3");
  const stashB64 = Buffer.from(JSON.stringify(stash), "utf8").toString("base64");
  const outMarker = relocateMarker(marker, findings);

  // --dry-run: compute the intended inline PATCH/POST/DELETE plan + the review
  // decision + the sticky body from the inputs, print them, ZERO gh calls. With no
  // read possible, existing state is treated as empty (every inline ⇒ POST, no
  // prior review ⇒ submit), and the plan is annotated as such.
  if (dryRun) {
    if (!sha) throw new Error("--dry-run requires --sha/--head (no gh read to derive headRefOid)");
    const body = summaryBody({ pr, sha, open, overflow, ungrounded, addressed, marker: outMarker, stashB64 });
    const inlinePlan = await reconcileInline({
      owner: "?",
      repo: "?",
      pr,
      headSha: sha,
      inline,
      commentMap: new Map(),
      dryRun: true,
    });
    const reviewPayload = { commit_id: sha, event, body: reviewBody(gateOpen, gateFindings.length, stash.length) };
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
  const view = await gh(["pr", "view", String(pr), "--repo", slug, "--json", "headRefOid,comments"], { json: true });
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
    const reviewPayload = { commit_id: headSha, event, body: reviewBody(gateOpen, gateFindings.length, stash.length) };
    try {
      await gh(["api", "-X", "POST", `repos/${owner}/${repo}/pulls/${pr}/reviews`, "--input", "-"], {
        input: JSON.stringify(reviewPayload),
      });
    } catch (e) {
      // Fallback: if a bot APPROVE is blocked by repo config, post it as a COMMENT.
      if (reviewPayload.event === "APPROVE") {
        reviewPayload.event = "COMMENT";
        await gh(["api", "-X", "POST", `repos/${owner}/${repo}/pulls/${pr}/reviews`, "--input", "-"], {
          input: JSON.stringify(reviewPayload),
        });
      } else {
        throw e;
      }
    }
  }

  // Upsert the sticky summary comment (carries stash + marker) — always.
  const body = summaryBody({ pr, sha: headSha, open, overflow, ungrounded, addressed, marker: outMarker, stashB64 });
  const existing = (view.comments || []).find(
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
