// GitHub-repo tools (`repo.read_file`, `repo.grep`,
// `repo.read_issue`). v0 reuses the existing FetchGitHubHttpClient and
// pulls the GitHub App token from the project's `githubCredentialRef`
// config field (same wiring as brownfield link).

import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import type { SecretStore } from "../../contracts/secretStore.js";
import { resolveQueryClient } from "../../data/orgScopedDb.js";
import type { GitHubHttpClient } from "../../providers/github.js";
import { parseGitHubRepository } from "../../providers/github.js";
import { ForgeToolsStore } from "../../repositories/forgeTools.js";
import { systemActor } from "../../state/actor.js";
import { assertProjectAccess, ToolAccessDeniedError } from "./authz.js";

interface RepoToolDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
}

async function loadProjectRepo(
  pool: pg.Pool,
  secrets: SecretStore,
  projectId: string,
  actor: ActorContext,
): Promise<{ repo: { owner: string; name: string }; token: string }> {
  // RLS R3a: the projects read carries org context when the forge-tool dispatch
  // has an ambient scope open; falls back to the pool otherwise (inert in R1).
  const db = resolveQueryClient(pool);
  await assertProjectAccess(db, projectId, actor);
  const row = await ForgeToolsStore.getProjectRepoAndConfig(db, projectId, systemActor);
  if (row === undefined) {
    throw new ToolAccessDeniedError(`project not found: ${projectId}`);
  }
  const repo = parseGitHubRepository(row.repoUrl);
  const credentialRef =
    typeof row.config === "object" && row.config !== null && typeof row.config["githubCredentialRef"] === "string"
      ? row.config["githubCredentialRef"]
      : undefined;
  if (credentialRef === undefined || credentialRef === "") {
    throw new ToolAccessDeniedError(`project ${projectId} has no GitHub credential ref`);
  }
  const value = await secrets.get(credentialRef);
  if (value === undefined || value.value === "") {
    throw new ToolAccessDeniedError(`project ${projectId} GitHub credential is missing`);
  }
  return { repo, token: value.value };
}

function encodeRepoPath(path: string): string {
  return path
    .split("/")
    .map((piece) => encodeURIComponent(piece))
    .join("/");
}

export interface RepoReadFileResult {
  path: string;
  present: boolean;
  size?: number;
  preview?: string;
}

export async function repoReadFile(
  deps: RepoToolDeps,
  args: { projectId: string; path: string },
  actor: ActorContext,
): Promise<RepoReadFileResult> {
  const { repo, token } = await loadProjectRepo(deps.pool, deps.secrets, args.projectId, actor);
  const response = await deps.githubHttp.request({
    method: "GET",
    path: `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/${encodeRepoPath(args.path)}`,
    token,
  });
  if (response.status === 404) {
    return { path: args.path, present: false };
  }
  if (response.status !== 200) {
    return {
      path: args.path,
      present: false,
      preview: `repo lookup failed: HTTP ${response.status}`,
    };
  }
  const body = response.body as { content?: string; encoding?: string; size?: number } | undefined;
  if (body === undefined || typeof body !== "object") {
    return { path: args.path, present: false };
  }
  let content = "";
  if (typeof body.content === "string") {
    if (body.encoding === "base64") {
      try {
        content = Buffer.from(body.content.replaceAll("\n", ""), "base64").toString("utf8");
      } catch {
        content = "";
      }
    } else {
      content = body.content;
    }
  }
  return {
    path: args.path,
    present: true,
    size: typeof body.size === "number" ? body.size : content.length,
    preview: content.slice(0, 8 * 1024),
  };
}

export interface RepoGrepResult {
  matches: ReadonlyArray<{ path: string; line?: number; snippet?: string }>;
}

export async function repoGrep(
  deps: RepoToolDeps,
  args: { projectId: string; pattern: string },
  actor: ActorContext,
): Promise<RepoGrepResult> {
  const { repo, token } = await loadProjectRepo(deps.pool, deps.secrets, args.projectId, actor);
  // GitHub Code Search returns at most 100 results per request and only
  // works for repos the App has access to.
  const query = `${args.pattern} repo:${repo.owner}/${repo.name}`;
  const response = await deps.githubHttp.request({
    method: "GET",
    path: `/search/code?q=${encodeURIComponent(query)}`,
    token,
  });
  if (response.status !== 200) {
    return { matches: [] };
  }
  const body = response.body as
    | { items?: Array<{ path?: unknown; text_matches?: Array<{ fragment?: unknown }> }> }
    | undefined;
  const items = body?.items ?? [];
  const matches = items.map((item) => {
    const path = typeof item.path === "string" ? item.path : "";
    const fragment =
      Array.isArray(item.text_matches) && typeof item.text_matches[0]?.fragment === "string"
        ? item.text_matches[0].fragment
        : undefined;
    return { path, snippet: fragment };
  });
  return { matches };
}

export interface RepoIssueResult {
  number: number;
  title: string;
  state: string;
  body: string | null;
  url: string;
}

export async function repoReadIssue(
  deps: RepoToolDeps,
  args: { projectId: string; number: number },
  actor: ActorContext,
): Promise<RepoIssueResult> {
  const { repo, token } = await loadProjectRepo(deps.pool, deps.secrets, args.projectId, actor);
  const response = await deps.githubHttp.request({
    method: "GET",
    path: `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/issues/${args.number}`,
    token,
  });
  if (response.status !== 200) {
    throw new ToolAccessDeniedError(`issue lookup failed: HTTP ${response.status}`);
  }
  const body = response.body as
    | { number?: number; title?: unknown; state?: unknown; body?: unknown; html_url?: unknown }
    | undefined;
  return {
    number: body?.number ?? args.number,
    title: typeof body?.title === "string" ? body.title : "",
    state: typeof body?.state === "string" ? body.state : "unknown",
    body: typeof body?.body === "string" ? body.body : null,
    url: typeof body?.html_url === "string" ? body.html_url : "",
  };
}
