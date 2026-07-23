import { readFile } from "node:fs/promises";

// Keep API-filed issues in the same contribution-loop shape as the GitHub forms.
// This uses only Node's built-in fetch so the workflow has no install step.
const TRIAGE_LABEL = "needs-triage";
const GUIDANCE_MARKER = "<!-- tanren-issue-triage-guidance -->";
const TYPE_LABELS = new Set(["bug", "enhancement"]);
const BUG_FIELDS = [
  "Symptom + where",
  "Expected general behavior + fix direction",
  "Negative control the fix must add",
  "Severity",
];

function normalizeHeading(value) {
  return value
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replaceAll(/\s+#+$/gu, "");
}

export function headingsIn(body) {
  return new Set([...body.matchAll(/^#{2,6}\s+(.+?)\s*$/gmu)].map((match) => normalizeHeading(match[1])));
}

export function validationProblems(issue) {
  const typeLabels = issue.labels.map((label) => label.name).filter((name) => TYPE_LABELS.has(name.toLowerCase()));
  const problems = [];

  if (typeLabels.length !== 1) {
    problems.push("choose exactly one type label: `bug` or `enhancement`");
    return problems;
  }

  const headings = headingsIn(issue.body ?? "");
  const requiredHeadings = typeLabels[0].toLowerCase() === "enhancement" ? ["Summary", "Acceptance"] : BUG_FIELDS;
  const missing = requiredHeadings.filter((heading) => !headings.has(heading));
  if (missing.length > 0) {
    problems.push(
      `add the required section${missing.length === 1 ? "" : "s"}: ${missing.map((heading) => `\`${heading}\``).join(", ")}`,
    );
  }

  return problems;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`issue-triage: ${name} is required`);
  return value;
}

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
  if (!response.ok && response.status !== 404) {
    throw new Error(`issue-triage: GitHub API ${options.method ?? "GET"} ${path} failed (${response.status})`);
  }
  return response;
}

function guidance(problems) {
  return `${GUIDANCE_MARKER}\nThanks for filing this! This issue needs a small amount of triage before it is ready:\n\n${problems.map((problem) => `- Please ${problem}.`).join("\n")}\n\nSee [CONTRIBUTING.md](https://github.com/cat-cave/tanren/blob/main/CONTRIBUTING.md) and the [issue templates](https://github.com/cat-cave/tanren/tree/main/.github/ISSUE_TEMPLATE) for the expected format. A maintainer can help if you are unsure which type fits.`;
}

async function hasGuidanceComment(issuePath) {
  for (let page = 1; ; page += 1) {
    const comments = await (await github(`${issuePath}/comments?per_page=100&page=${page}`)).json();
    if (comments.some((comment) => comment.body?.includes(GUIDANCE_MARKER))) return true;
    if (comments.length < 100) return false;
  }
}

async function main() {
  const event = JSON.parse(await readFile(requiredEnvironment("GITHUB_EVENT_PATH"), "utf8"));
  const issue = event.issue;
  if (!issue) throw new Error("issue-triage: event does not contain an issue");

  const [owner, repo] = requiredEnvironment("GITHUB_REPOSITORY").split("/");
  if (!owner || !repo) throw new Error("issue-triage: GITHUB_REPOSITORY must be owner/repo");
  const issuePath = `/repos/${owner}/${repo}/issues/${issue.number}`;
  const problems = validationProblems(issue);

  if (problems.length === 0) {
    const response = await github(`${issuePath}/labels/${encodeURIComponent(TRIAGE_LABEL)}`, { method: "DELETE" });
    console.log(
      response.status === 404
        ? "issue-triage: issue is clean; needs-triage was absent"
        : "issue-triage: issue is clean; removed needs-triage",
    );
    return;
  }

  await github(`${issuePath}/labels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ labels: [TRIAGE_LABEL] }),
  });
  if (await hasGuidanceComment(issuePath)) {
    console.log("issue-triage: issue needs triage; guidance comment already exists");
    return;
  }
  await github(`${issuePath}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: guidance(problems) }),
  });
  console.log("issue-triage: issue needs triage; added guidance comment and label");
}

if (process.env.NODE_ENV !== "test") {
  await main();
}
