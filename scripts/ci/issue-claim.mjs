import { readFile } from "node:fs/promises";

// Self-serve /claim and /unclaim for GitHub issues.
// Uses only Node's built-in fetch so the workflow has no install step.
// Coordinates with CRA abandonment (CRA-09), which unassigns stale claims.

const LOG = "issue-claim";

/** @param {string | null | undefined} body */
export function parseCommand(body) {
  const firstLine = (body ?? "").split(/\r?\n/u, 1)[0]?.trim().toLowerCase();
  if (firstLine === "/claim") return "claim";
  if (firstLine === "/unclaim") return "unclaim";
  return null;
}

/**
 * @param {Array<{ login?: string } | null | undefined> | null | undefined} assignees
 * @param {string} login
 */
export function isAssignee(assignees, login) {
  const target = login.toLowerCase();
  return (assignees ?? []).some((a) => (a?.login ?? "").toLowerCase() === target);
}

/**
 * @param {Array<{ login?: string } | null | undefined> | null | undefined} assignees
 */
export function assigneeLogins(assignees) {
  return (assignees ?? []).map((a) => a?.login).filter((login) => typeof login === "string" && login.length > 0);
}

/**
 * Open blockers only — closed blocked_by edges do not block a claim.
 * @param {Array<{ number: number, state?: string }>} blockers
 */
export function openBlockers(blockers) {
  return blockers.filter((b) => (b.state ?? "open") === "open");
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${LOG}: ${name} is required`);
  return value;
}

/**
 * @param {string} path
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [options]
 */
async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${requiredEnvironment("GITHUB_TOKEN")}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `${LOG}: GitHub API ${options.method ?? "GET"} ${path} failed (${response.status})${detail ? `: ${detail.slice(0, 400)}` : ""}`,
    );
  }
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  return JSON.parse(text);
}

/**
 * @param {string} issuePath
 * @param {string} body
 */
async function postComment(issuePath, body) {
  await github(`${issuePath}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
}

/**
 * Paginate GET .../dependencies/blocked_by.
 * @param {string} issuePath
 * @returns {Promise<Array<{ number: number, state?: string }>>}
 */
async function listBlockedBy(issuePath) {
  /** @type {Array<{ number: number, state?: string }>} */
  const all = [];
  for (let page = 1; ; page += 1) {
    const batch = await github(`${issuePath}/dependencies/blocked_by?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) {
      throw new TypeError(`${LOG}: unexpected blocked_by response (not an array)`);
    }
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/**
 * @param {string} issuePath
 * @param {string} login
 */
async function addAssignee(issuePath, login) {
  await github(`${issuePath}/assignees`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assignees: [login] }),
  });
}

/**
 * @param {string} issuePath
 * @param {string} login
 */
async function removeAssignee(issuePath, login) {
  await github(`${issuePath}/assignees`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assignees: [login] }),
  });
}

/**
 * @param {{
 *   issue: { number: number, state: string, assignees?: Array<{ login?: string } | null>, pull_request?: unknown },
 *   comment: { body?: string | null, user?: { login?: string } | null },
 *   owner: string,
 *   repo: string,
 * }} ctx
 * @param {{
 *   listBlockedBy: (issuePath: string) => Promise<Array<{ number: number, state?: string }>>,
 *   addAssignee: (issuePath: string, login: string) => Promise<void>,
 *   removeAssignee: (issuePath: string, login: string) => Promise<void>,
 *   postComment: (issuePath: string, body: string) => Promise<void>,
 *   log?: (msg: string) => void,
 * }} [deps]
 */
export async function handleClaimEvent(ctx, deps) {
  const api = {
    listBlockedBy,
    addAssignee,
    removeAssignee,
    postComment,
    log: (msg) => console.log(msg),
    ...deps,
  };
  const issue = ctx.issue;
  const comment = ctx.comment;
  const command = parseCommand(comment.body);
  if (!command) {
    api.log(`${LOG}: no /claim or /unclaim command; no-op`);
    return { action: "ignored" };
  }

  // PR conversation comments share the issue_comment event; refuse quietly.
  if (issue.pull_request) {
    api.log(`${LOG}: comment is on a pull request; no-op`);
    return { action: "ignored_pr" };
  }

  const login = comment.user?.login;
  if (!login) throw new Error(`${LOG}: comment has no user login`);

  const issuePath = `/repos/${ctx.owner}/${ctx.repo}/issues/${issue.number}`;

  // Closed issues: no-op (no comment spam).
  if (issue.state !== "open") {
    api.log(`${LOG}: issue #${issue.number} is ${issue.state}; no-op`);
    return { action: "noop_closed" };
  }

  if (command === "claim") {
    const holders = assigneeLogins(issue.assignees);
    if (holders.length > 0) {
      if (isAssignee(issue.assignees, login)) {
        // Idempotent: already claimed by the commenter.
        api.log(`${LOG}: @${login} already holds #${issue.number}; idempotent claim`);
        await api.postComment(issuePath, `Already claimed by you (@${login}).`);
        return { action: "claim_idempotent" };
      }
      const heldBy = holders.map((h) => `@${h}`).join(", ");
      await api.postComment(
        issuePath,
        `Cannot claim: this issue is already assigned to ${heldBy}. Ask them to \`/unclaim\` first, or wait for CRA abandonment to release a stale claim.`,
      );
      api.log(`${LOG}: refused claim on #${issue.number}; already assigned to ${holders.join(", ")}`);
      return { action: "refused_claimed" };
    }

    const blockers = openBlockers(await api.listBlockedBy(issuePath));
    if (blockers.length > 0) {
      const list = blockers.map((b) => `#${b.number}`).join(", ");
      await api.postComment(
        issuePath,
        `Cannot claim: this issue is blocked by open issue${blockers.length === 1 ? "" : "s"} ${list}. Wait until ${blockers.length === 1 ? "it lands" : "they land"} first (see the Dependencies panel).`,
      );
      api.log(`${LOG}: refused claim on #${issue.number}; open blockers ${list}`);
      return { action: "refused_blocked" };
    }

    await api.addAssignee(issuePath, login);
    await api.postComment(
      issuePath,
      `Claimed by @${login}. You are assigned — please hold one open claim at a time. Comment \`/unclaim\` to release.`,
    );
    api.log(`${LOG}: assigned @${login} to #${issue.number}`);
    return { action: "claimed" };
  }

  // /unclaim
  if (!isAssignee(issue.assignees, login)) {
    // Idempotent: commenter is not assigned (already free for them).
    api.log(`${LOG}: @${login} is not assigned to #${issue.number}; idempotent unclaim`);
    await api.postComment(issuePath, `You are not assigned to this issue (@${login}); nothing to unclaim.`);
    return { action: "unclaim_idempotent" };
  }

  await api.removeAssignee(issuePath, login);
  await api.postComment(issuePath, `Released by @${login}. This issue is claimable again (\`/claim\`).`);
  api.log(`${LOG}: unassigned @${login} from #${issue.number}`);
  return { action: "unclaimed" };
}

async function main() {
  const event = JSON.parse(await readFile(requiredEnvironment("GITHUB_EVENT_PATH"), "utf8"));
  const issue = event.issue;
  const comment = event.comment;
  if (!issue) throw new Error(`${LOG}: event does not contain an issue`);
  if (!comment) throw new Error(`${LOG}: event does not contain a comment`);

  const [owner, repo] = requiredEnvironment("GITHUB_REPOSITORY").split("/");
  if (!owner || !repo) throw new Error(`${LOG}: GITHUB_REPOSITORY must be owner/repo`);

  await handleClaimEvent({ issue, comment, owner, repo });
}

if (process.env.NODE_ENV !== "test") {
  await main();
}
