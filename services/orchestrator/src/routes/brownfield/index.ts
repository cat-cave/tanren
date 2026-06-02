// P2A-0013: brownfield link endpoint. Verifies the configured GitHub App can
// reach the target repo, reads `.github/workflows/` and `CODEOWNERS` (no
// writes), and persists the linkage on the project row.
//
// Phase 2 contract: this endpoint NEVER writes to the target repository. It
// is observation-only; the operator opts in to writes via a separate
// installation flow that ships in a later spec.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import {
  MissingGithubCredentialRefError,
  NoGithubCredentialConfiguredError,
  resolveGithubToken,
  type ResolvedGithubToken,
} from "../../engine/credentials/githubTokenResolver.js";
import type { GitHubHttpClient } from "../../engine/providers/github.js";
import { parseGitHubRepository } from "../../engine/providers/github.js";
import type { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import {
  loadOrgDefaultGithubCredentialRef,
  loadOrgGithubAppInstallation,
} from "../../engine/credentials/orgGithubApp.js";
import { ProjectStore } from "../../engine/repositories/index.js";
import { systemActor } from "../../engine/state/actor.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

interface BrownfieldRoutesOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  /** P3-0003: shared installation-token minter (cache lives here). */
  githubAppMinter?: GithubAppTokenMinter;
}

const BrownfieldLinkSchema = z.object({
  repoUrl: z.string().min(1),
  githubCredentialRef: z.string().min(1).optional(),
});

const DETECTED_FILES = [
  ".github/workflows/tanren-ci.yml",
  ".github/workflows/ci.yml",
  "CODEOWNERS",
  ".github/CODEOWNERS",
] as const;

export interface BrownfieldDetectedFile {
  path: string;
  present: boolean;
  size?: number;
  /** Decoded UTF-8 preview, truncated to 8 KiB for UI display. */
  preview?: string;
}

export function createBrownfieldRoutes(options: BrownfieldRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.post("/:orgId/projects/:projectId/link", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = BrownfieldLinkSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_brownfield_link", issues: parsed.error.issues }, 400);
    }

    const projectOrgId = await ProjectStore.getOrgId(options.pool, projectId, systemActor);
    if (projectOrgId === undefined) {
      return c.json({ error: "project_not_found" }, 404);
    }
    if (projectOrgId !== null && projectOrgId !== orgId) {
      return c.json({ error: "project_access_denied" }, 403);
    }

    const repo = parseGitHubRepository(parsed.data.repoUrl);
    let resolved: ResolvedGithubToken;
    try {
      const installation = await loadOrgGithubAppInstallation(options.pool, orgId);
      // Static ref: the request body's explicit ref wins; otherwise fall back to
      // the org's default GitHub credential ref. No hardcoded default — when
      // neither is set and no App is installed, the resolver throws and we map
      // it to `github_credential_missing`.
      const staticRef =
        parsed.data.githubCredentialRef ?? (await loadOrgDefaultGithubCredentialRef(options.pool, orgId));
      resolved = await resolveGithubToken({
        secrets: options.secrets,
        installation,
        ...(staticRef === undefined ? {} : { staticRef }),
        minter: options.githubAppMinter,
      });
    } catch (error) {
      // ONLY the typed "operator hasn't configured a credential" errors are a
      // user 400. A DB/RLS read failure, a secret-store error, or a minter
      // failure must NOT be disguised as a missing credential — those propagate
      // as a 5xx so the real fault is visible (no silent fallback).
      if (error instanceof NoGithubCredentialConfiguredError || error instanceof MissingGithubCredentialRefError) {
        return c.json({ error: "github_credential_missing" }, 400);
      }
      return c.json({ error: "github_credential_unreadable", message: messageOf(error) }, 502);
    }

    const repoCheck = await options.githubHttp.request({
      method: "GET",
      path: `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
      token: resolved.token,
      refreshToken: resolved.refresh,
    });
    if (repoCheck.status === 404) {
      return c.json({ error: "repo_not_reachable", message: "GitHub App cannot see this repository" }, 404);
    }
    if (repoCheck.status !== 200) {
      return c.json(
        {
          error: "repo_check_failed",
          message: `GitHub returned HTTP ${repoCheck.status} when verifying repo access`,
        },
        502,
      );
    }

    const detected: BrownfieldDetectedFile[] = [];
    for (const path of DETECTED_FILES) {
      detected.push(await readRepoFile(options.githubHttp, repo, path, resolved));
    }

    await ProjectStore.updateRepoUrl(options.pool, projectId, parsed.data.repoUrl, systemActor);

    return c.json({
      projectId,
      repoUrl: parsed.data.repoUrl,
      orgId,
      detectedFiles: detected,
      writesPerformed: 0,
    });
  });

  return app;
}

async function readRepoFile(
  http: GitHubHttpClient,
  repo: { owner: string; name: string },
  path: string,
  resolved: ResolvedGithubToken,
): Promise<BrownfieldDetectedFile> {
  const response = await http.request({
    method: "GET",
    path: `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/${encodeRepoPath(path)}`,
    token: resolved.token,
    refreshToken: resolved.refresh,
  });
  if (response.status === 404) {
    return { path, present: false };
  }
  if (response.status !== 200) {
    return { path, present: false, preview: `repo lookup failed: HTTP ${response.status}` };
  }
  const body = response.body as RepoContent | undefined;
  if (body === undefined || typeof body !== "object") {
    return { path, present: false };
  }
  const content = decodeContent(body);
  return {
    path,
    present: true,
    size: typeof body.size === "number" ? body.size : content.length,
    preview: content.slice(0, 8 * 1024),
  };
}

function encodeRepoPath(path: string): string {
  return path
    .split("/")
    .map((piece) => encodeURIComponent(piece))
    .join("/");
}

function decodeContent(body: RepoContent): string {
  if (typeof body.content !== "string") {
    return "";
  }
  const encoding = body.encoding === "base64" ? "base64" : undefined;
  if (encoding === "base64") {
    try {
      return Buffer.from(body.content.replaceAll("\n", ""), "base64").toString("utf8");
    } catch {
      return "";
    }
  }
  return body.content;
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface RepoContent {
  content?: string;
  encoding?: string;
  size?: number;
}
