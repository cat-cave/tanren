// §3.6 fix 5 — the webhook-provision endpoint creates/validates the GitHub hook
// BEFORE it rotates the stored HMAC secret. On a provision RETRY that 422s (e.g. the
// hook already exists), rotating the stored secret FIRST would brick the source: the
// live GitHub hook still signs with the OLD secret while the store now holds a NEW
// one, so every delivery's signature fails. This test drives the route with a
// GitHub stub that 422s the hook create and asserts the stored secret was NOT
// rotated and the source config was NOT stamped.

import type pg from "pg";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { GithubAppTokenMinter } from "../src/engine/providers/githubAppTokenMinter.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { createInboxRoutes } from "../src/routes/inbox/index.js";

const ACTOR: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

// A compact stub pool: org-config read (for credential resolution), source
// create/lookup, and config update (the rotation we assert never happens on 422).
function stubPool(orgConfig: unknown): {
  pool: pg.Pool;
  webhookWrites: Array<{ id: string; ref: string }>;
} {
  const webhookWrites: Array<{ id: string; ref: string }> = [];
  const sources = new Map<string, Record<string, unknown>>();
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT org_id FROM projects")) return { rows: [{ org_id: "org_a" }], rowCount: 1 };
    if (sql.startsWith("SELECT config FROM organizations")) return { rows: [{ config: orgConfig }], rowCount: 1 };
    if (sql.includes("FROM inbox_sources WHERE org_id = $1")) {
      return { rows: [...sources.values()].filter((s) => s["org_id"] === params[0]), rowCount: sources.size };
    }
    if (sql.includes("FROM inbox_sources WHERE id = $1")) {
      const s = sources.get(String(params[0]));
      return s === undefined ? { rows: [], rowCount: 0 } : { rows: [s], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO inbox_sources")) {
      const [id, orgId, projectId, kind, name, detail, config] = params as string[];
      const row = {
        id,
        org_id: orgId,
        project_id: projectId,
        kind,
        name,
        detail,
        config: JSON.parse(config),
        enabled: "true",
        auto_route: "false",
        state: "active",
        attention_code: null,
        attention_message: null,
        attention_observed_at: null,
        webhook_configured: false,
        retry_not_before: null,
      };
      sources.set(id, row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE inbox_sources SET webhook_secret_ref")) {
      const [id, _orgId, ref] = params as string[];
      webhookWrites.push({ id, ref });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  return { pool: pool as unknown as pg.Pool, webhookWrites };
}

function fakeGithub(handler: (req: GitHubHttpRequest) => GitHubHttpResponse): {
  http: GitHubHttpClient;
  requests: GitHubHttpRequest[];
} {
  const requests: GitHubHttpRequest[] = [];
  return {
    requests,
    http: {
      async request(req: GitHubHttpRequest): Promise<GitHubHttpResponse> {
        requests.push(req);
        return handler(req);
      },
    },
  };
}

const triageStub = { triage: async () => ({}) } as never;

function withActor(secrets: FakeSecretStore, gh: GitHubHttpClient, pool: pg.Pool): Hono<ActorContextEnv> {
  const inbox = createInboxRoutes({
    pool,
    secrets,
    githubHttp: gh,
    answererFactory: () => triageStub,
    githubAppMinter: new GithubAppTokenMinter({ secrets }),
    publicBaseUrl: "https://tanren.example",
  });
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", ACTOR);
    await next();
  });
  app.route("/orgs", inbox);
  return app;
}

describe("§3.6 fix 5 — provision retry doesn't brick the secret", () => {
  it("a hook-create 422 does NOT rotate the stored secret nor stamp the source config", async () => {
    const credentialRef = "credential/github/org/org_a/default";
    const orgConfig = { version: 1, defaultCredentials: { github_token: credentialRef } };
    const { pool, webhookWrites } = stubPool(orgConfig);
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: credentialRef, value: "pat" });
    const gh = fakeGithub((req) => {
      if (req.method === "POST" && req.path.endsWith("/hooks")) return { status: 422, body: { message: "exists" } };
      return { status: 200, body: {} };
    });
    const app = withActor(secrets, gh.http, pool);

    const res = await app.request(`/orgs/org_a/inbox/webhooks/provision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "project_a", repoUrl: "https://github.com/cat-cave/app" }),
    });

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("webhook_create_failed");
    // The hook create WAS attempted (with the candidate secret)…
    expect(gh.requests.find((r) => r.path.endsWith("/hooks"))).toBeDefined();
    // …but because GitHub rejected it, the stored secret was NOT rotated (the only
    // secret in the store is the pre-existing PAT — no `webhook/issues/*` ref landed).
    expect(await secrets.get(credentialRef)).toBeDefined();
    const secretCall = gh.requests.find((r) => r.path.endsWith("/hooks"));
    const candidateSecret = (secretCall!.body as { config: { secret: string } }).config.secret;
    expect(await secrets.get(`webhook/issues/`)).toBeUndefined();
    expect(candidateSecret).toBeTruthy();
    // And the source metadata was NOT stamped webhook-driven (not bricked).
    expect(webhookWrites).toHaveLength(0);
  });

  it("a successful hook create DOES rotate the secret + stamp the config", async () => {
    const credentialRef = "credential/github/org/org_a/default";
    const orgConfig = { version: 1, defaultCredentials: { github_token: credentialRef } };
    const { pool, webhookWrites } = stubPool(orgConfig);
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: credentialRef, value: "pat" });
    const gh = fakeGithub((req) => {
      if (req.method === "POST" && req.path.endsWith("/hooks")) return { status: 201, body: { id: 9001 } };
      return { status: 200, body: {} };
    });
    const app = withActor(secrets, gh.http, pool);

    const res = await app.request(`/orgs/org_a/inbox/webhooks/provision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "project_a", repoUrl: "https://github.com/cat-cave/app" }),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as { sourceId: string };
    // The secret was rotated AFTER GitHub confirmed, and internal metadata was stamped.
    const secretRef = `webhook/issues/${json.sourceId}`;
    expect(await secrets.get(secretRef)).toBeDefined();
    expect(webhookWrites).toEqual([{ id: json.sourceId, ref: secretRef }]);
  });
});
