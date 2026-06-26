// LIVE matrix-hit MATERIALIZER wiring (PR-C; templating-system.md §FRAGMENTS).
//
// Builds the `materializeCuratedTemplate` seam the route layer threads into the
// derive. On a `compose-from-fragments` decision, the derive calls into this
// materializer, which:
//   1. Resolves an org-scoped GitHub credential (App installation token, else the
//      org-default static PAT — the SAME resolver greenfield repo-create uses).
//   2. Creates a fresh TEMPLATE repo via the minimal `CodeHost.createRepo` seam
//      (under a deterministic `tanren-tmpl-<curated-id>` name).
//   3. PUTs every composed VFS file to the new repo's default branch via the
//      GitHub contents API (the same shape `FetchConfigInjectionGitHub.commitFile`
//      uses for the brownfield config injector).
//   4. Returns a `SelectedTemplate` the rest of derive seeds from.
//
// NO new transport: the GitHub HTTP client + the standalone token resolver are
// reused as-is — this module only assembles them onto the typed materializer seam
// `buildMaterializeCuratedTemplate` exposes.

import type pg from "pg";
import { buildMaterializeCuratedTemplate, type MaterializeCuratedTemplate } from "../../engine/templates/index.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import { resolveVcsToken } from "../../engine/credentials/vcsCredentials.js";
import {
  loadOrgDefaultGithubCredentialRef,
  loadOrgGithubAppInstallation,
} from "../../engine/credentials/orgGithubApp.js";
import { parseGitHubRepository, type GitHubHttpClient, type GitHubRepository } from "../../engine/providers/github.js";
import type { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import { buildProjectHostSeams } from "../../engine/providers/hostFactory.js";
import { GithubCredentialMissingError } from "../projects/greenfieldRepoCreate.js";

export interface MaterializeFlowDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
}

/**
 * Build the LIVE matrix-hit materializer for ONE (orgId, actor) context — the same
 * per-request shape `buildCreateForNoMatch` uses for the agent-template-build seam.
 */
export function buildLiveMaterializeCuratedTemplate(
  deps: MaterializeFlowDeps,
  ctx: { orgId: string },
): MaterializeCuratedTemplate {
  const { pool, secrets, githubHttp, githubAppMinter } = deps;
  const { orgId } = ctx;

  return buildMaterializeCuratedTemplate({
    async createTemplateRepo(input) {
      // Resolve credentials the SAME way createGreenfieldRepository does (App
      // installation token, else the org-default static PAT) — repo-create works
      // for both paths and we MUST surface a LOUD config gap when neither is
      // present (matching the greenfield route's `github_credential_missing`).
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
      const { codeHost } = buildProjectHostSeams(githubHttp, () => resolveVcsToken(githubHttp, creds));
      const created = await codeHost.createRepo({
        owner: input.owner,
        name: input.name,
        private: input.private,
        autoInit: true,
        description: input.description,
      });
      return {
        fullName: `${created.repo.owner}/${created.repo.name}`,
        repoUrl: created.repoUrl,
        defaultBranch: created.defaultBranch,
      };
    },
    async pushFile(input) {
      // Resolve a token PER push (the credential surface is the same as repo-create).
      // We could batch a token per materialize call, but the per-file resolve is
      // cheap (the resolver memoizes/mints once per request through the cache the
      // shared HTTP client carries), and per-push keeps this module simple.
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
      const repo = parseGitHubRepository(input.repoUrl);
      // GET the existing blob SHA (if any) so an idempotent overwrite carries the
      // expected `sha` (GitHub's contents API requires it to update a file). For a
      // fresh template push this is almost always 404 — except for the README the
      // `auto_init: true` repo seeded, which we overwrite when the composer emits
      // its own README.md.
      const existing = await githubHttp.request({
        method: "GET",
        path: contentsPath(repo, input.path, input.defaultBranch),
        token: resolved.token,
        refreshToken: resolved.refresh,
      });
      const sha = existing.status === 200 ? readContentSha(existing.body) : undefined;
      const put = await githubHttp.request({
        method: "PUT",
        path: contentsPath(repo, input.path),
        token: resolved.token,
        refreshToken: resolved.refresh,
        body: {
          message: input.message,
          branch: input.defaultBranch,
          content: Buffer.from(input.content, "utf8").toString("base64"),
          ...(sha === undefined ? {} : { sha }),
        },
      });
      if (put.status !== 200 && put.status !== 201) {
        throw new Error(`matrix-hit push for ${input.path} failed: HTTP ${put.status}`);
      }
      return { commitSha: readCommitSha(put.body) };
    },
  });
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

function readContentSha(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null) {
    const sha = (body as Record<string, unknown>)["sha"];
    if (typeof sha === "string" && sha !== "") return sha;
  }
  return undefined;
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
