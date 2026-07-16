// Loop 6 (fail-loud at creation): an AUTO-ROUTING inbox source MUST name a
// project. Its candidates skip manual triage and commit straight into the DAG —
// project-scoped — so a project-less auto-route source produces routable
// candidates that can never become specs (they stall in the inbox). The
// `POST /:orgId/inbox/sources` route rejects that misconfiguration at creation
// rather than discovering it per item. A non-auto-route source (operator-triaged)
// may still be project-less.

import type pg from "pg";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { createInboxRoutes } from "../src/routes/inbox/index.js";
import type { ActorContext } from "../src/auth/schemas.js";
import type { TriageAnswerer } from "../src/engine/forge/inbox/index.js";

const ACTOR: ActorContext = {
  userId: "user_admin",
  orgId: "org_a",
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

const noopAnswerer: TriageAnswerer = {
  async triage() {
    throw new Error("triage should not run for a source-creation test");
  },
};

// A SQL-substring stub pool that captures `INSERT INTO inbox_sources` so a test
// can assert whether the (mis)configured source was actually created. Returns an
// empty result for everything else.
function stubPool(): { pool: pg.Pool; sourceInserts: Array<Record<string, unknown>> } {
  const sourceInserts: Array<Record<string, unknown>> = [];
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.startsWith("INSERT INTO inbox_sources")) {
      const [id, orgId, projectId, kind, name] = params as string[];
      const row = {
        id,
        org_id: orgId,
        project_id: projectId,
        kind,
        name,
        detail: "",
        config: {},
        enabled: "true",
        auto_route: "true",
      };
      sourceInserts.push(row);
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  return { pool: pool as unknown as pg.Pool, sourceInserts };
}

function app(
  pool: pg.Pool,
  options: { secrets?: FakeSecretStore; providerCalls?: unknown[] } = {},
): Hono<ActorContextEnv> {
  const inbox = createInboxRoutes({
    pool,
    secrets: options.secrets ?? new FakeSecretStore(),
    githubHttp: {
      async request(input) {
        options.providerCalls?.push(input);
        return { status: 200, body: [] };
      },
    },
    answererFactory: () => noopAnswerer,
  });
  const root = new Hono<ActorContextEnv>();
  root.use("*", async (c, next) => {
    c.set("actor", ACTOR);
    await next();
  });
  root.route("/orgs", inbox);
  return root;
}

async function postSource(pool: pg.Pool, body: unknown): Promise<Response> {
  return app(pool).request(`/orgs/org_a/inbox/sources`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function storedIssuesPool(config: Record<string, unknown>): pg.Pool {
  const row = {
    id: "source_removed_provider",
    org_id: "org_a",
    project_id: "project_a",
    kind: "issues",
    name: "removed provider",
    detail: "",
    config,
    enabled: "true",
    auto_route: "false",
  };
  const query = async (text: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.includes("FROM inbox_sources WHERE id = $1")) {
      return { rows: [row], rowCount: 1 };
    }
    throw new Error(`unexpected query after unsupported provider boundary: ${sql}`);
  };
  return { query } as unknown as pg.Pool;
}

describe("inbox source creation — auto-route requires a project (Loop 6)", () => {
  it("rejects an auto_route source with no projectId (candidates could never become specs)", async () => {
    const { pool, sourceInserts } = stubPool();
    const res = await postSource(pool, { kind: "system", name: "org default intake", autoRoute: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_source");
    // The misconfigured source was NOT created.
    expect(sourceInserts).toHaveLength(0);
  });

  it("accepts an auto_route source WITH a projectId", async () => {
    const { pool, sourceInserts } = stubPool();
    const res = await postSource(pool, {
      kind: "system",
      name: "project intake",
      projectId: "project_a",
      autoRoute: true,
    });
    expect(res.status).toBe(201);
    expect(sourceInserts).toHaveLength(1);
  });

  it("still accepts a NON-auto_route source with no projectId (operator-triaged is fine)", async () => {
    const { pool, sourceInserts } = stubPool();
    const res = await postSource(pool, { kind: "manual", name: "manual triage" });
    expect(res.status).toBe(201);
    expect(sourceInserts).toHaveLength(1);
  });
});

describe("inbox issues source boundary — removed providers never reach authority or transport", () => {
  it.each([
    ["linear", { provider: "linear", team: "ENG", tokenRef: "credential/linear/old" }],
    ["jira", { provider: "jira", baseUrl: "https://jira.example", projectKey: "ENG" }],
    ["raw tokenRef", { provider: "github", owner: "cat-cave", repo: "app", tokenRef: "credential/old" }],
  ])("rejects %s config at source creation without persisting it", async (_label, config) => {
    const { pool, sourceInserts } = stubPool();
    const res = await postSource(pool, { kind: "issues", name: "unsupported", config });
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toMatchObject({ error: "unsupported_inbox_provider" });
    expect(sourceInserts).toHaveLength(0);
  });

  it("still creates an explicitly supported GitHub issues source", async () => {
    const { pool, sourceInserts } = stubPool();
    const res = await postSource(pool, {
      kind: "issues",
      name: "github issues",
      config: { provider: "github", owner: "cat-cave", repo: "app" },
    });
    expect(res.status).toBe(201);
    expect(sourceInserts).toHaveLength(1);
  });

  it.each([
    ["linear", { provider: "linear", team: "ENG" }],
    ["jira", { provider: "jira", baseUrl: "https://jira.example", projectKey: "ENG" }],
    ["raw tokenRef", { provider: "github", owner: "cat-cave", repo: "app", tokenRef: "credential/old" }],
  ])("returns a stable 400 for a persisted %s source before secret/provider I/O", async (_label, config) => {
    const secrets = new FakeSecretStore();
    const secretRead = vi.spyOn(secrets, "get");
    const providerCalls: unknown[] = [];
    const res = await app(storedIssuesPool(config), { secrets, providerCalls }).request(
      "/orgs/org_a/inbox/sources/source_removed_provider/ingest",
      { method: "POST" },
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toMatchObject({ error: "unsupported_inbox_provider" });
    expect(secretRead).not.toHaveBeenCalled();
    expect(providerCalls).toEqual([]);
  });
});
