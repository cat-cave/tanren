// Ingestion-autonomous behavior tests (feat/ingestion-autonomous).
//
// Covers the new API-drivable + autonomous-by-default intake surfaces:
//   B2  POST .../inbox/sources/:sourceId/items — a user-filed report triages →
//       auto-routes through the SAME intake pipeline the webhook uses.
//   B3  POST .../inbox/sources/:sourceId/ingest — an `auto_routable` candidate now
//       creates a spec (was a dead-end with no autoRoute deps).
//   App-only intake — the poller's per-org connector resolves an App INSTALLATION
//       token (no PAT) when the org has the App installed.
//   L1  a hallucinated `dependsOn` DROPS the bad edge + retries (no strand/500).
//   L2  linking a repo creates the matching `issues` inbox source.
//   B1  the webhook-provision endpoint creates the webhook + stores the secret ref +
//       wires the source (fake githubHttp + secrets).

import type pg from "pg";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { GithubAppTokenMinter } from "../src/engine/providers/githubAppTokenMinter.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { createInboxRoutes } from "../src/routes/inbox/index.js";
import { pollSourceOnce } from "../src/engine/forge/intake/index.js";
import { ensureIssuesInboxSource } from "../src/engine/forge/inbox/index.js";
import type {
  CandidateTriage,
  InboxSource,
  TriageAnswerer,
  TriageRoutableSpec,
} from "../src/engine/forge/inbox/index.js";
import type { ActorContext } from "../src/auth/schemas.js";

const ACTOR: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

const ISSUES_SOURCE: InboxSource = {
  id: "src_gh",
  orgId: "org_a",
  projectId: "project_a",
  kind: "issues",
  name: "github · cat-cave",
  detail: "",
  config: { provider: "github", owner: "cat-cave", repo: "app" },
  enabled: true,
  autoRoute: false,
};

function fixedTriage(verdict: CandidateTriage["verdict"], routableSpec: TriageRoutableSpec | null): TriageAnswerer {
  return {
    async triage(): Promise<CandidateTriage> {
      return {
        dedupe: "no match",
        match: "new behavior",
        placement: "auto",
        verdict,
        duplicateOfSpecId: null,
        discoveryVariant: "feature",
        routableSpec,
      };
    },
  };
}

function sourceRow(s: InboxSource): Record<string, unknown> {
  return {
    id: s.id,
    org_id: s.orgId,
    project_id: s.projectId,
    kind: s.kind,
    name: s.name,
    detail: s.detail,
    config: s.config,
    enabled: s.enabled ? "true" : "false",
    auto_route: s.autoRoute ? "true" : "false",
  };
}

// A SQL-substring stub pool capturing the spec INSERTs (so tests assert the DAG
// insert) and modeling the candidate + (optionally) the `specs` dependency check.
interface StubOpts {
  existingSpecIds?: string[];
  sources?: InboxSource[];
  orgConfig?: unknown;
  createdSources?: InboxSource[];
}
function stubPool(opts: StubOpts = {}): {
  pool: pg.Pool;
  specInserts: Array<{ specId: string; dependsOn: string[]; title: string; priority: string }>;
  sourceInserts: Array<Record<string, unknown>>;
  configUpdates: Array<{ id: string; config: unknown }>;
} {
  const candidates = new Map<string, Record<string, unknown>>();
  const byExternal = new Map<string, string>();
  const specInserts: Array<{ specId: string; dependsOn: string[]; title: string; priority: string }> = [];
  const sourceInserts: Array<Record<string, unknown>> = [];
  const configUpdates: Array<{ id: string; config: unknown }> = [];
  const existing = new Set(opts.existingSpecIds ?? []);
  const sources = [...(opts.sources ?? [])];

  const candidateRow = (id: string) => {
    const c = candidates.get(id)!;
    const src = sources.find((s) => s.id === c["source_id"]) ?? ISSUES_SOURCE;
    return { ...c, source_name: src.name, source_kind: src.kind };
  };

  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.startsWith("SELECT config FROM organizations")) {
      return { rows: [{ config: opts.orgConfig ?? {} }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT DISTINCT org_id FROM inbox_sources")) {
      return { rows: [{ org_id: "org_a" }], rowCount: 1 };
    }
    if (sql.includes("FROM inbox_sources WHERE org_id = $1")) {
      return { rows: sources.filter((s) => s.orgId === params[0]).map((s) => sourceRow(s)), rowCount: sources.length };
    }
    if (sql.includes("FROM inbox_sources WHERE id = $1")) {
      const found = sources.find((s) => s.id === params[0]);
      return found === undefined ? { rows: [], rowCount: 0 } : { rows: [sourceRow(found)], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO inbox_sources")) {
      const [id, orgId, projectId, kind, name, detail, config] = params as string[];
      const inserted = {
        id,
        org_id: orgId,
        project_id: projectId,
        kind,
        name,
        detail,
        config: JSON.parse(config),
        enabled: "true",
        auto_route: "false",
      };
      sourceInserts.push(inserted);
      sources.push({
        id,
        orgId,
        projectId,
        kind: kind as InboxSource["kind"],
        name,
        detail,
        config: JSON.parse(config),
        enabled: true,
        autoRoute: false,
      });
      return { rows: [inserted], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE inbox_sources SET config")) {
      const [id, config] = params as string[];
      configUpdates.push({ id, config: JSON.parse(config) });
      const src = sources.find((s) => s.id === id);
      if (src !== undefined) src.config = JSON.parse(config);
      return { rows: src === undefined ? [] : [sourceRow(src)], rowCount: src === undefined ? 0 : 1 };
    }
    if (sql.startsWith("SELECT spec_id, title, status FROM specs")) {
      return {
        rows: [...existing].map((id) => ({ spec_id: id, title: id, status: "open" })),
        rowCount: existing.size,
      };
    }
    if (sql.startsWith("SELECT spec_id FROM specs WHERE project_id")) {
      const wanted = (params[1] as string[]) ?? [];
      const found = wanted.filter((id) => existing.has(id));
      return { rows: found.map((id) => ({ spec_id: id })), rowCount: found.length };
    }
    if (sql.startsWith("INSERT INTO candidates")) {
      const [id, sourceId, orgId, projectId, externalId, title, body, severity, status, triage] = params as string[];
      const key = `${sourceId}::${externalId}`;
      const cid = byExternal.get(key) ?? id;
      candidates.set(cid, {
        id: cid,
        source_id: sourceId,
        org_id: orgId,
        project_id: projectId,
        external_id: externalId,
        title,
        body,
        severity,
        status,
        triage: JSON.parse(triage),
        resolved_spec_id: null,
      });
      byExternal.set(key, cid);
      return { rows: [candidateRow(cid)], rowCount: 1 };
    }
    if (sql.startsWith("SELECT c.id, c.source_id") && sql.includes("WHERE c.id = $1")) {
      const c = candidates.get(String(params[0]));
      return c === undefined ? { rows: [], rowCount: 0 } : { rows: [candidateRow(String(params[0]))], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE candidates c SET status")) {
      const [cid, status, specId] = params as (string | null)[];
      const c = candidates.get(String(cid));
      if (c === undefined) return { rows: [], rowCount: 0 };
      c["status"] = status;
      c["resolved_spec_id"] = specId;
      return { rows: [candidateRow(String(cid))], rowCount: 1 };
    }
    if (sql.startsWith("SELECT project_id FROM projects")) return { rows: [{ project_id: params[0] }], rowCount: 1 };
    if (sql.startsWith("SELECT org_id FROM projects")) return { rows: [{ org_id: "org_a" }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO specs")) {
      const dependsOn = (params[5] as string[]) ?? [];
      // L1: emulate `ensureSpecDependenciesExist` — a dependsOn id not in `existing`
      // throws SpecNotFoundError (the engine drops the edge + retries with []).
      const missing = dependsOn.filter((id) => !existing.has(id));
      if (missing.length > 0) {
        const err = new Error(`spec not found: ${missing.join(", ")}`);
        err.name = "SpecNotFoundError";
        throw err;
      }
      specInserts.push({
        specId: String(params[0]),
        title: String(params[2]),
        dependsOn,
        priority: String(params[7]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT metadata FROM specs")) return { rows: [{ metadata: {} }], rowCount: 1 };
    if (sql.startsWith("UPDATE specs SET metadata")) return { rows: [{ spec_id: params[0] }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  return { pool: pool as unknown as pg.Pool, specInserts, sourceInserts, configUpdates };
}

// A fake GitHubHttpClient recording the requests (and the token used per request).
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

function buildInboxApp(opts: {
  pool: pg.Pool;
  answerer: TriageAnswerer;
  githubHttp?: GitHubHttpClient;
  secrets?: FakeSecretStore;
  githubAppMinter?: GithubAppTokenMinter;
  publicBaseUrl?: string;
}) {
  return createInboxRoutes({
    pool: opts.pool,
    secrets: opts.secrets ?? new FakeSecretStore(),
    githubHttp: opts.githubHttp ?? fakeGithub(() => ({ status: 200, body: [] })).http,
    answererFactory: () => opts.answerer,
    ...(opts.githubAppMinter === undefined ? {} : { githubAppMinter: opts.githubAppMinter }),
    ...(opts.publicBaseUrl === undefined ? {} : { publicBaseUrl: opts.publicBaseUrl }),
  });
}

// Mount the inbox routes under `/orgs` behind an actor-injecting middleware, so the
// routes' `requireActor`/`guard` see the admin actor. Requests target `/orgs/...`.
function withActor(inbox: ReturnType<typeof createInboxRoutes>): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", ACTOR);
    await next();
  });
  app.route("/orgs", inbox);
  return app;
}

describe("B2 — file a report INTO Tanren auto-routes", () => {
  it("triages a user report → auto_routable → a spec is created over the API", async () => {
    const { pool, specInserts } = stubPool({ sources: [ISSUES_SOURCE] });
    const routableSpec: TriageRoutableSpec = {
      title: "fix the broken redirect",
      description: "a 404 instead of a redirect",
      acceptanceCriteria: ["redirect works"],
      dependsOn: [],
      priority: "P1",
    };
    const app = withActor(buildInboxApp({ pool, answerer: fixedTriage("auto_routable", routableSpec) }));
    const res = await app.request(`/orgs/org_a/inbox/sources/${ISSUES_SOURCE.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "broken redirect", body: "404", severity: "fail" }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { outcome: string; specId?: string };
    expect(json.outcome).toBe("auto_routed");
    expect(json.specId).toMatch(/^spec_/u);
    expect(specInserts).toHaveLength(1);
    expect(specInserts[0]!.title).toBe("fix the broken redirect");
  });

  it("a needs_call report rests in the inbox (no spec)", async () => {
    const { pool, specInserts } = stubPool({ sources: [ISSUES_SOURCE] });
    const app = withActor(buildInboxApp({ pool, answerer: fixedTriage("needs_call", null) }));
    const res = await app.request(`/orgs/org_a/inbox/sources/${ISSUES_SOURCE.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "should we build X?" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).outcome).toBe("inboxed");
    expect(specInserts).toHaveLength(0);
  });
});

describe("B3 — manual /ingest now auto-routes", () => {
  it("an auto_routable ingest result creates a spec (was a dead-end)", async () => {
    const oneIssue = fakeGithub(() => ({
      status: 200,
      body: [{ number: 11, title: "polled bug", body: "x", labels: [] }],
    }));
    const { pool, specInserts } = stubPool({ sources: [ISSUES_SOURCE] });
    const routableSpec: TriageRoutableSpec = {
      title: "ingested feature",
      description: "from /ingest",
      acceptanceCriteria: ["works"],
      dependsOn: [],
      priority: "P2",
    };
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "gh-pat", value: "pat-token" });
    const sourceWithPat: InboxSource = { ...ISSUES_SOURCE, config: { ...ISSUES_SOURCE.config, staticRef: "gh-pat" } };
    const local = stubPool({ sources: [sourceWithPat] });
    const app = withActor(
      buildInboxApp({
        pool: local.pool,
        answerer: fixedTriage("auto_routable", routableSpec),
        githubHttp: oneIssue.http,
        secrets,
      }),
    );
    const res = await app.request(`/orgs/org_a/inbox/sources/${ISSUES_SOURCE.id}/ingest`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(local.specInserts).toHaveLength(1);
    expect(local.specInserts[0]!.title).toBe("ingested feature");
    void pool;
    void specInserts;
  });
});

describe("App-only intake — per-org connector mints an installation token", () => {
  it("resolves an App installation token (no PAT) for the GitHub issues connector", async () => {
    const gh = fakeGithub((req) => {
      // The issues list call must carry the App installation token.
      if (req.path.includes("/issues")) return { status: 200, body: [] };
      return { status: 200, body: [] };
    });
    const orgConfig = {
      version: 1,
      github_app: {
        installationId: "inst_1",
        appId: "app_1",
        credentialRef: "gh-app/key",
        installedAt: "2026-01-01T00:00:00Z",
      },
    };
    const { pool } = stubPool({ orgConfig });
    // A fake minter: override the token mint so we don't sign a JWT / hit the network.
    const minter = new GithubAppTokenMinter({ secrets: new FakeSecretStore() });
    let mintedFor: string | undefined;
    minter.getInstallationToken = async (req): Promise<string> => {
      mintedFor = req.installationId;
      return "app-installation-token";
    };

    await pollSourceOnce(
      {
        pool,
        secrets: new FakeSecretStore(),
        githubHttp: gh.http,
        githubAppMinter: minter,
        answererFactory: () => fixedTriage("needs_call", null),
        autoRoute: { resolveActor: (orgId) => ({ ...ACTOR, orgId }) },
      },
      ISSUES_SOURCE,
    );

    expect(mintedFor).toBe("inst_1");
    const issuesCall = gh.requests.find((r) => r.path.includes("/issues"));
    expect(issuesCall).toBeDefined();
    expect(issuesCall!.token).toBe("app-installation-token");
  });
});

describe("L1 — hallucinated dependsOn drops + retries (no strand/500)", () => {
  it("drops a nonexistent dependsOn edge and still creates the spec", async () => {
    const { pool, specInserts } = stubPool({ sources: [ISSUES_SOURCE], existingSpecIds: [] });
    const routableSpec: TriageRoutableSpec = {
      title: "feature with a bad edge",
      description: "the model hallucinated a dep",
      acceptanceCriteria: ["works"],
      dependsOn: ["spec_does_not_exist"],
      priority: "P1",
    };
    const app = withActor(buildInboxApp({ pool, answerer: fixedTriage("auto_routable", routableSpec) }));
    const res = await app.request(`/orgs/org_a/inbox/sources/${ISSUES_SOURCE.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "feature" }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { outcome: string; specId?: string };
    expect(json.outcome).toBe("auto_routed");
    // The retry committed the spec with NO dependsOn (the bad edge was dropped).
    expect(specInserts).toHaveLength(1);
    expect(specInserts[0]!.dependsOn).toEqual([]);
  });
});

describe("L2 — linking a repo creates the issues inbox source", () => {
  it("creates a matching issues source for the repo (idempotent)", async () => {
    const { pool, sourceInserts } = stubPool({ sources: [] });
    const first = await ensureIssuesInboxSource({
      pool,
      orgId: "org_a",
      projectId: "project_a",
      repoUrl: "https://github.com/cat-cave/app",
    });
    expect(first.created).toBe(true);
    expect(first.source.kind).toBe("issues");
    expect(sourceInserts).toHaveLength(1);
    // A second call finds the existing source (no duplicate).
    const second = await ensureIssuesInboxSource({
      pool,
      orgId: "org_a",
      projectId: "project_a",
      repoUrl: "https://github.com/cat-cave/app",
    });
    expect(second.created).toBe(false);
    expect(sourceInserts).toHaveLength(1);
  });
});

describe("B1 — webhook provisioning endpoint", () => {
  it("creates the GitHub webhook, stores the secret ref, wires the source", async () => {
    const { pool, sourceInserts, configUpdates } = stubPool({ sources: [], orgConfig: {} });
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "gh-pat", value: "pat" });
    // Seed the org default credential so the App-less token resolves via PAT.
    const orgConfig = { version: 1, defaultCredentials: { github_token: "gh-pat" } };
    const seeded = stubPool({ sources: [], orgConfig });
    const gh = fakeGithub((req) => {
      if (req.method === "POST" && req.path.endsWith("/hooks")) return { status: 201, body: { id: 9001 } };
      return { status: 200, body: {} };
    });
    const app = withActor(
      buildInboxApp({
        pool: seeded.pool,
        answerer: fixedTriage("needs_call", null),
        githubHttp: gh.http,
        secrets,
        githubAppMinter: new GithubAppTokenMinter({ secrets }),
        publicBaseUrl: "https://tanren.example",
      }),
    );
    const res = await app.request(`/orgs/org_a/inbox/webhooks/provision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "project_a", repoUrl: "https://github.com/cat-cave/app" }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      sourceId: string;
      webhookSecretRef: string;
      callbackUrl: string;
      hookId: unknown;
    };
    expect(json.hookId).toBe(9001);
    expect(json.webhookSecretRef).toMatch(/^webhook\/issues\//u);
    expect(json.callbackUrl).toBe(`https://tanren.example/github/webhooks/issues/${json.sourceId}`);
    // The source was created and its config got the webhookSecretRef stamped.
    expect(sourceInserts.length + seeded.sourceInserts.length).toBeGreaterThanOrEqual(1);
    const update = seeded.configUpdates.find((u) => u.id === json.sourceId);
    expect(update).toBeDefined();
    expect((update!.config as { webhookSecretRef?: string }).webhookSecretRef).toBe(json.webhookSecretRef);
    // The HMAC secret was stored.
    expect(await secrets.get(json.webhookSecretRef)).toBeDefined();
    // The GitHub hook POST carried the issues event + the secret.
    const hookCall = gh.requests.find((r) => r.path.endsWith("/hooks"));
    expect(hookCall).toBeDefined();
    const body = hookCall!.body as { events: string[]; config: { secret: string; url: string } };
    expect(body.events).toEqual(["issues"]);
    expect(body.config.url).toBe(json.callbackUrl);
    void pool;
    void configUpdates;
  });
});
