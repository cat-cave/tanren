// B1 (webhook provisioning): make GitHub `issues` webhook intake API-DRIVABLE.
//
// Today wiring a repo's issues webhook into Tanren is manual GitHub-UI work: create
// the webhook, copy its callback URL, invent + paste an HMAC secret, then hand-create
// the matching inbox source. This operator endpoint does all of it over the API:
//
//   1. ensure the `issues` inbox source exists for the repo (reuses the L2 helper),
//   2. mint a fresh HMAC secret + store it in the secret store at a stable ref,
//   3. create the GitHub `issues` webhook on the repo via the org's App token,
//      pointing at `/github/webhooks/issues/:sourceId` with that secret,
//   4. persist the webhook secret ref in the internal source metadata column,
//      which flips the source to webhook-driven (the poller then skips it; push is
//      authoritative).
//
// The webhook is created via the org's GitHub App token (App-first, static fallback —
// the same policy brownfield/greenfield use). The reusable ref never enters source
// config or an HTTP response.

import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import type pg from "pg";
import { runWithOrgScope } from "@tanren/db";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import {
  MissingGithubCredentialRefError,
  NoGithubCredentialConfiguredError,
  resolveGithubToken,
} from "../../engine/credentials/githubTokenResolver.js";
import {
  loadOrgDefaultGithubCredentialRef,
  loadOrgGithubAppInstallation,
} from "../../engine/credentials/orgGithubApp.js";
import { ensureIssuesInboxSource } from "../../engine/forge/inbox/index.js";
import { pgRepositories } from "../../engine/contracts/repositories.js";
import { parseGitHubRepository, type GitHubHttpClient } from "../../engine/providers/github.js";
import type { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import type { ActorContextEnv } from "../../middleware/auth.js";

export interface WebhookProvisionDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
  // The public base URL Tanren is reachable at, so the webhook callback resolves to
  // `${publicBaseUrl}/github/webhooks/issues/:sourceId`. The request body may override.
  publicBaseUrl: string;
}

export const ProvisionWebhookBody = z
  .object({
    projectId: z.string().min(1),
    repoUrl: z.string().min(1),
    // Optional callback base URL override (else `deps.publicBaseUrl`).
    callbackBaseUrl: z.string().url().optional(),
  })
  .strict();

/**
 * Provision the GitHub `issues` webhook for a project's repo + wire the inbox source.
 * Returns the source id, the stored secret ref, and the created GitHub hook id.
 */
export async function handleProvisionWebhook(
  c: Context<ActorContextEnv>,
  deps: WebhookProvisionDeps,
  orgId: string,
  actor: ActorContext,
): Promise<Response> {
  const parsed = ProvisionWebhookBody.safeParse(await c.req.json().catch(() => {}));
  if (!parsed.success) return c.json({ error: "invalid_provision", issues: parsed.error.issues }, 400);
  const projectOrgId = await pgRepositories.projects.getOrgId(deps.pool, parsed.data.projectId, {
    kind: "operator",
    id: actor.userId,
  });
  if (projectOrgId !== orgId) return c.json({ error: "project_not_found" }, 404);

  const repo = parseGitHubRepository(parsed.data.repoUrl);

  // 1. Ensure the inbox source exists (idempotent; reuses the L2 helper).
  const { source } = await ensureIssuesInboxSource({
    pool: deps.pool,
    orgId,
    projectId: parsed.data.projectId,
    repoUrl: parsed.data.repoUrl,
  });

  // 2. Resolve the org's GitHub token (App-first, static fallback).
  let token;
  try {
    const installation = await loadOrgGithubAppInstallation(deps.pool, orgId);
    const staticRef = await loadOrgDefaultGithubCredentialRef(deps.pool, orgId);
    token = await resolveGithubToken({
      secrets: deps.secrets,
      ...(installation === undefined ? {} : { installation }),
      ...(staticRef === undefined ? {} : { staticRef, staticRefOrgId: orgId }),
      ...(deps.githubAppMinter === undefined ? {} : { minter: deps.githubAppMinter }),
    });
  } catch (error) {
    if (error instanceof NoGithubCredentialConfiguredError || error instanceof MissingGithubCredentialRefError) {
      return c.json({ error: "github_credential_missing" }, 400);
    }
    return c.json({ error: "github_credential_unreadable", message: messageOf(error) }, 502);
  }

  // §3.6 (hook-create BEFORE secret rotate): mint a candidate secret value but do
  // NOT store it yet. On a provision RETRY, rotating the STORED secret first and
  // THEN hitting a GitHub 422 (e.g. the hook already exists) would brick the source —
  // the live GitHub hook still signs with the OLD secret while the store now holds a
  // NEW one, so every delivery's signature fails. So we create/validate the hook on
  // GitHub FIRST and only persist the rotated secret AFTER GitHub confirms — a 422
  // leaves the previous working secret untouched.
  const secretRef = `webhook/issues/${source.id}`;
  const secretValue = randomBytes(32).toString("hex");

  // 3. Create the GitHub `issues` webhook pointing at this source's receiver, with
  // the candidate secret. The store is NOT yet rotated.
  const base = (parsed.data.callbackBaseUrl ?? deps.publicBaseUrl).replace(/\/+$/u, "");
  const callbackUrl = `${base}/github/webhooks/issues/${source.id}`;
  const hookResponse = await deps.githubHttp.request({
    method: "POST",
    path: `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/hooks`,
    token: token.token,
    refreshToken: token.refresh,
    body: {
      name: "web",
      active: true,
      events: ["issues"],
      config: { url: callbackUrl, content_type: "json", secret: secretValue, insecure_ssl: "0" },
    },
  });
  if (hookResponse.status !== 201 && hookResponse.status !== 200) {
    // The hook was NOT created — leave the stored secret + the source config exactly
    // as they were (no rotation), so a previously-working source keeps working.
    return c.json({ error: "webhook_create_failed", message: `GitHub returned HTTP ${hookResponse.status}` }, 502);
  }
  const hookId = (hookResponse.body as { id?: unknown } | undefined)?.id ?? null;

  // 4. GitHub confirmed the hook with the new secret — NOW it is safe to rotate the
  // stored secret to match. The live hook + the store agree on the new value.
  await deps.secrets.put({ ref: secretRef, value: secretValue });

  // 5. Persist the ref through the internal-only metadata seam. This flips the
  // source webhook-driven without exposing a credential coordinate in config.
  await persistWebhookSecretRef(deps.pool, orgId, source.id, secretRef);

  return c.json(
    {
      sourceId: source.id,
      callbackUrl,
      hookId,
    },
    201,
  );
}

/** Store the secret coordinate without returning or merging it into provider config. */
async function persistWebhookSecretRef(
  pool: pg.Pool,
  orgId: string,
  sourceId: string,
  webhookSecretRef: string,
): Promise<void> {
  await runWithOrgScope(pool, orgId, async (client) => {
    const updated = await pgRepositories.inbox.setWebhookSecretRef(client, sourceId, orgId, webhookSecretRef);
    if (!updated) throw new Error("inbox source changed before webhook metadata could be committed");
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
