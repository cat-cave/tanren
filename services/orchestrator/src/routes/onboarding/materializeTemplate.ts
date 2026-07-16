// LIVE compose+materialize wiring (docs/roadmap/templating-system.md).
//
// Builds the `materializeTemplate` seam the route layer threads into the derive.
// On every greenfield derive the seam:
//   1. Resolves an org-scoped GitHub credential (App installation token, else the
//      org-default static PAT — the SAME resolver greenfield repo-create uses).
//   2. PUTs every composed VFS file to the JUST-CREATED PROJECT repo's default
//      branch via the GitHub contents API (the same shape
//      `FetchConfigInjectionGitHub.commitFile` uses for the brownfield config
//      injector). The push is idempotent on a re-attach (it reads the existing
//      blob SHA and updates).
//   3. Returns a `SeededTemplate` the rest of derive persists onto the project
//      config for observability.
//
// PR-G (task #77) — the per-stack `tanren-tmpl-<slug>` template seed repo is GONE.
// The composed VFS lands directly in the project repo as its initial content;
// the run path's separate seed-repo clone step is gone too. The only forge op
// in this module is the per-file contents-API PUT against the project repo.
//
// NO new transport: the GitHub HTTP client + the standalone token resolver are
// reused as-is — this module only assembles them onto the typed materializer seam
// `buildMaterializeTemplate` exposes.

import type pg from "pg";
import { buildMaterializeTemplate, type MaterializeTemplate } from "../../engine/templates/index.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import { resolveVcsToken } from "../../engine/credentials/vcsCredentials.js";
import {
  loadOrgDefaultGithubCredentialRef,
  loadOrgGithubAppInstallation,
} from "../../engine/credentials/orgGithubApp.js";
import { parseGitHubRepository, type GitHubHttpClient, type GitHubRepository } from "../../engine/providers/github.js";
import type { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import { GithubCredentialMissingError } from "../projects/greenfieldRepoCreate.js";

export interface MaterializeTemplateFlowDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
}

/**
 * Build the LIVE compose+materialize seam for ONE (orgId, actor) context.
 */
export function buildLiveMaterializeTemplate(
  deps: MaterializeTemplateFlowDeps,
  ctx: { orgId: string },
): MaterializeTemplate {
  const { pool, secrets, githubHttp, githubAppMinter } = deps;
  const { orgId } = ctx;

  return buildMaterializeTemplate({
    async pushFile(input) {
      const installation = await loadOrgGithubAppInstallation(pool, orgId);
      const staticRef = await loadOrgDefaultGithubCredentialRef(pool, orgId);
      if (installation === undefined && staticRef === undefined) {
        throw new GithubCredentialMissingError();
      }
      const creds = {
        secrets,
        ...(installation !== undefined && { installation }),
        ...(staticRef !== undefined && { staticRef }),
        ...(githubAppMinter === undefined ? {} : { minter: githubAppMinter }),
      };
      const resolved = await resolveVcsToken(githubHttp, creds);
      return reconcileMaterializedFile(githubHttp, resolved, input);
    },
  });
}

/**
 * Reconcile one composed file by exact content. A retry after the provider
 * accepted the PUT but before Tanren stored the template receipt observes the
 * same bytes and performs no second commit.
 */
export async function reconcileMaterializedFile(
  githubHttp: GitHubHttpClient,
  token: { token: string; refresh?: () => Promise<string> },
  input: { repoUrl: string; defaultBranch: string; path: string; content: string; message: string },
): Promise<{ commitSha: string }> {
  const repo = parseGitHubRepository(input.repoUrl);
  const existing = await githubHttp.request({
    method: "GET",
    path: contentsPath(repo, input.path, input.defaultBranch),
    token: token.token,
    refreshToken: token.refresh,
  });
  const file = existing.status === 200 ? readExistingFile(existing.body) : undefined;
  if (file?.sha !== undefined && file.content === input.content) {
    return { commitSha: file.sha };
  }
  const put = await githubHttp.request({
    method: "PUT",
    path: contentsPath(repo, input.path),
    token: token.token,
    refreshToken: token.refresh,
    body: {
      message: input.message,
      branch: input.defaultBranch,
      content: Buffer.from(input.content, "utf8").toString("base64"),
      ...(file?.sha === undefined ? {} : { sha: file.sha }),
    },
  });
  if (put.status !== 200 && put.status !== 201) {
    throw new Error(`materialize push for ${input.path} failed: HTTP ${put.status}`);
  }
  return { commitSha: readCommitSha(put.body) };
}

function repoApi(repo: GitHubRepository, suffix: string): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${suffix}`;
}

function encodeRepoPath(path: string): string {
  return path
    .split("/")
    .map((piece) => encodeURIComponent(piece))
    .join("/");
}

function contentsPath(repo: GitHubRepository, path: string, ref?: string): string {
  const base = repoApi(repo, `/contents/${encodeRepoPath(path)}`);
  return ref === undefined ? base : `${base}?ref=${encodeURIComponent(ref)}`;
}

function readExistingFile(body: unknown): { sha?: string; content?: string } {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    const sha = typeof record["sha"] === "string" && record["sha"] !== "" ? record["sha"] : undefined;
    const content =
      record["encoding"] === "base64" && typeof record["content"] === "string"
        ? Buffer.from(record["content"].replaceAll(/\s/gu, ""), "base64").toString("utf8")
        : undefined;
    return { ...(sha === undefined ? {} : { sha }), ...(content === undefined ? {} : { content }) };
  }
  return {};
}

function readCommitSha(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const commit = (body as Record<string, unknown>)["commit"];
    if (typeof commit === "object" && commit !== null) {
      const sha = (commit as Record<string, unknown>)["sha"];
      if (typeof sha === "string" && sha !== "") return sha;
    }
  }
  return "";
}
