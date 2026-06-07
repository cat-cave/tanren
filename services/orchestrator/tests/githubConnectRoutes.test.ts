// Route tests for the Wave-2 "Connect GitHub" + onboarding-status operator API.
// Drives the REAL route handlers against the in-memory RoutesPool + an injected
// fetch, proving the user experience without a raw config PATCH:
//   - connect via App install → GET reflects mode:"app" + a SERVER-stamped
//     installedAt + a real capability check (administration:write → canCreateRepos);
//   - connect via token → the PAT is stored + set as the org default, and the
//     capability reflects the token's actual X-OAuth-Scopes;
//   - onboarding-status aggregates AI provider + GitHub + budget into ready/nextSteps;
//   - a non-admin POST is a 403.

import { generateKeyPairSync } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { migrateOrgConfig } from "../src/engine/config/orgConfig.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { storeGithubAppCredential } from "../src/engine/credentials/githubApp.js";
import type { AppendEventInput, EventStore } from "../src/engine/eventStore.js";
import { GithubAppTokenMinter } from "../src/engine/providers/githubAppTokenMinter.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createGithubConnectRoutes } from "../src/routes/orgs/github.js";
import { RoutesPool } from "./helpers/routesPool.js";

const APP_CREDENTIAL_REF = "credential/github_app/org/org_acme/default";

class RecordingEventStore implements EventStore {
  readonly appended: AppendEventInput[] = [];

  async append(input: AppendEventInput): Promise<void> {
    this.appended.push(input);
  }
}

function pem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

const admin: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

const member: ActorContext = {
  userId: "user_bob",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

interface CapabilityFetchOptions {
  /** The GitHub App installation's granted `administration` permission. */
  administration?: string;
  /** The classic OAuth scopes the static token reports via X-OAuth-Scopes. */
  tokenScopes?: string;
}

/**
 * A URL-routing fake fetch covering the three endpoints the routes hit:
 *   - POST /app/installations/{id}/access_tokens (minter)  → installation token
 *   - GET  /app/installations/{id}              (App probe) → permissions+account
 *   - GET  /user                                (token probe) → login + X-OAuth-Scopes
 */
function buildFetch(opts: CapabilityFetchOptions = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/access_tokens") && method === "POST") {
      return new Response(
        JSON.stringify({ token: "ghs_app", expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
        { status: 201 },
      );
    }
    if (/\/app\/installations\/[^/]+$/u.test(url) && method === "GET") {
      return new Response(
        JSON.stringify({
          account: { login: "acme-org" },
          permissions: { administration: opts.administration ?? "read", contents: "write" },
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/user") && method === "GET") {
      return new Response(JSON.stringify({ login: "acme-bot" }), {
        status: 200,
        headers: { "X-OAuth-Scopes": opts.tokenScopes ?? "" },
      });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
}

async function buildHarness(opts: CapabilityFetchOptions = {}, actor: ActorContext = admin) {
  const pool = new RoutesPool();
  pool.seedOrg({ id: "org_acme", login: "acme", config: { version: 1 } });
  pool.seedProject({ project_id: "project_acme", org_id: "org_acme" });
  const secrets = new InMemorySecretStore();
  await storeGithubAppCredential(secrets, { ref: APP_CREDENTIAL_REF, appId: "123456", privateKeyPem: pem() });
  const fetchImpl = buildFetch(opts);
  const minter = new GithubAppTokenMinter({ secrets, fetchImpl });
  const events = new RecordingEventStore();

  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: { async resolveActorContext() {} } as never,
      localDevActor: actor,
    }),
  );
  app.route(
    "/orgs",
    createGithubConnectRoutes({
      pool: pool.asPgPool(),
      secrets,
      minter,
      appCredentialRef: APP_CREDENTIAL_REF,
      fetchImpl,
      events,
    }),
  );
  return { app, pool, secrets, events };
}

async function reqJson(
  app: Hono<ActorContextEnv>,
  method: string,
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await app.request(path, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("connect GitHub — App install mode", () => {
  it("connects via App install and GET reflects mode app + a server-stamped installedAt + capability", async () => {
    const { app, pool } = await buildHarness({ administration: "write" });
    const before = Date.now();
    const post = await reqJson(app, "POST", "/orgs/org_acme/github", {
      installationId: "987",
      appId: "123456",
    });
    expect(post.status).toBe(201);
    expect(post.body.mode).toBe("app");
    expect(post.body.installation.installationId).toBe("987");
    // SERVER-STAMPED: the caller supplied no timestamp; the route set a real one.
    const stamped = Date.parse(post.body.installation.installedAt);
    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before);

    // The persisted org config carries the github_app block with that timestamp.
    const persisted = migrateOrgConfig(pool.orgs.get("org_acme")?.config).github_app;
    expect(persisted?.installationId).toBe("987");
    expect(persisted?.installedAt).toBe(post.body.installation.installedAt);

    const get = await reqJson(app, "GET", "/orgs/org_acme/github");
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({
      connected: true,
      mode: "app",
      login: "acme-org",
      canCreateRepos: true,
      missingPermissions: [],
    });
  });

  it("reports the administration:write gap when the App lacks it", async () => {
    const { app } = await buildHarness({ administration: "read" });
    await reqJson(app, "POST", "/orgs/org_acme/github", { installationId: "987", appId: "123456" });
    const get = await reqJson(app, "GET", "/orgs/org_acme/github");
    expect(get.body.canCreateRepos).toBe(false);
    expect(get.body.missingPermissions).toEqual(["administration:write"]);
  });

  it("rejects an appId that does not match the credential", async () => {
    const { app } = await buildHarness();
    const post = await reqJson(app, "POST", "/orgs/org_acme/github", { installationId: "987", appId: "999999" });
    expect(post.status).toBe(400);
    expect(post.body.error).toBe("github_app_id_mismatch");
  });
});

describe("connect GitHub — token mode", () => {
  it("stores the token as the org default and the capability reflects its scope", async () => {
    const { app, secrets, events } = await buildHarness({ tokenScopes: "repo, workflow" });
    const post = await reqJson(app, "POST", "/orgs/org_acme/github", { token: "dummy_github_token" });
    expect(post.status).toBe(201);
    expect(post.body.mode).toBe("token");
    // The response carries only the redacted ref — never the secret.
    expect(post.body.credentialRef).toBe("credential/github/org/org_acme/default");
    expect(JSON.stringify(post.body)).not.toContain("dummy_github_token");
    // The token IS stored under that ref.
    expect((await secrets.get(post.body.credentialRef))?.value).toBe("dummy_github_token");
    expect(events.appended).toContainEqual(
      expect.objectContaining({
        projectId: "project_acme",
        eventType: "credential.github.configured",
        payload: {
          mode: "token",
          credentialKind: "github_token",
          ref: "credential/github/org/org_acme/default",
          redacted: true,
        },
      }),
    );

    const get = await reqJson(app, "GET", "/orgs/org_acme/github");
    expect(get.body).toMatchObject({ connected: true, mode: "token", login: "acme-bot", canCreateRepos: true });
    expect(get.body.missingPermissions).toEqual([]);
  });

  it("reports the missing repo scope for a token that lacks it", async () => {
    const { app } = await buildHarness({ tokenScopes: "read:org" });
    await reqJson(app, "POST", "/orgs/org_acme/github", { token: "ghp_no_repo_scope" });
    const get = await reqJson(app, "GET", "/orgs/org_acme/github");
    expect(get.body.canCreateRepos).toBe(false);
    expect(get.body.missingPermissions).toEqual(["repo"]);
  });
});

describe("GET github — not connected", () => {
  it("reports connected:false when no GitHub identity is configured", async () => {
    const { app } = await buildHarness();
    const get = await reqJson(app, "GET", "/orgs/org_acme/github");
    expect(get.status).toBe(200);
    expect(get.body).toEqual({
      connected: false,
      mode: null,
      login: null,
      canCreateRepos: false,
      missingPermissions: [],
    });
  });
});

describe("onboarding-status", () => {
  it("aggregates AI provider + GitHub + budget into ready + nextSteps", async () => {
    const { app } = await buildHarness();
    // Nothing configured yet → not ready, every step listed.
    const empty = await reqJson(app, "GET", "/orgs/org_acme/onboarding-status");
    expect(empty.status).toBe(200);
    expect(empty.body.ready).toBe(false);
    expect(empty.body.aiProvider).toEqual({ connected: false });
    expect(empty.body.github).toEqual({ connected: false, canCreateRepos: false });
    expect(empty.body.budget).toEqual({ ceilingUsd: null });
    expect(empty.body.nextSteps.length).toBe(3);

    // Configure AI (codex default), a budget, and connect a repo-scoped token.
    const { app: app2, pool } = await buildHarness({ tokenScopes: "repo" });
    pool.orgs.get("org_acme")!.config = {
      version: 1,
      defaultCredentials: {
        defaultLlm: { cli: "codex", model: "default", authRef: "credential/codex/org/org_acme/default" },
      },
      defaultBudget: { ceilingUsd: 50, period: "monthly" },
    };
    await reqJson(app2, "POST", "/orgs/org_acme/github", { token: "ghp_repo" });

    const ready = await reqJson(app2, "GET", "/orgs/org_acme/onboarding-status");
    expect(ready.body.ready).toBe(true);
    expect(ready.body.aiProvider).toEqual({ connected: true, classifiedAs: "codex" });
    expect(ready.body.github).toEqual({ connected: true, canCreateRepos: true });
    expect(ready.body.budget).toEqual({ ceilingUsd: 50 });
    expect(ready.body.nextSteps).toEqual([]);
  });

  it("classifies a managed provider as connected without a codex credential", async () => {
    const { app, pool } = await buildHarness();
    pool.orgs.get("org_acme")!.config = { version: 1, providerMode: "managed" };
    const status = await reqJson(app, "GET", "/orgs/org_acme/onboarding-status");
    expect(status.body.aiProvider).toEqual({ connected: true, classifiedAs: "managed" });
  });

  it("surfaces the repo-creation gap as a next step when GitHub lacks it", async () => {
    const { app, pool } = await buildHarness({ tokenScopes: "read:org" });
    pool.orgs.get("org_acme")!.config = {
      version: 1,
      providerMode: "managed",
      defaultBudget: { ceilingUsd: 50, period: "monthly" },
    };
    await reqJson(app, "POST", "/orgs/org_acme/github", { token: "ghp_no_repo_scope" });
    const status = await reqJson(app, "GET", "/orgs/org_acme/onboarding-status");
    expect(status.body.ready).toBe(false);
    expect(status.body.github).toEqual({ connected: true, canCreateRepos: false });
    expect(status.body.nextSteps.some((s: string) => s.includes("repo"))).toBe(true);
  });

  it("keeps ready false while the budget step is missing", async () => {
    const { app, pool } = await buildHarness({ tokenScopes: "repo" });
    pool.orgs.get("org_acme")!.config = { version: 1, providerMode: "managed" };
    await reqJson(app, "POST", "/orgs/org_acme/github", { token: "ghp_repo" });

    const status = await reqJson(app, "GET", "/orgs/org_acme/onboarding-status");
    expect(status.body.ready).toBe(false);
    expect(status.body.aiProvider).toEqual({ connected: true, classifiedAs: "managed" });
    expect(status.body.github).toEqual({ connected: true, canCreateRepos: true });
    expect(status.body.budget).toEqual({ ceilingUsd: null });
    expect(status.body.nextSteps).toEqual([
      "Set a default budget ceiling: PUT /orgs/:orgId/budget so runs have a spend cap.",
    ]);
  });
});

describe("authorization", () => {
  it("a non-admin POST is a 403", async () => {
    const { app } = await buildHarness({}, member);
    const post = await reqJson(app, "POST", "/orgs/org_acme/github", { token: "ghp_x" });
    expect(post.status).toBe(403);
    expect(post.body.error).toBe("org_admin_required");
  });

  it("a non-member is denied the GET read", async () => {
    const stranger: ActorContext = { ...member, orgId: "org_other" };
    const { app } = await buildHarness({}, stranger);
    const get = await reqJson(app, "GET", "/orgs/org_acme/github");
    expect(get.status).toBe(403);
    expect(get.body.error).toBe("org_access_denied");
  });
});
