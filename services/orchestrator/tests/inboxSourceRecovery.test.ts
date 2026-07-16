import type pg from "pg";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { InboxSourceAttention } from "../src/engine/forge/inbox/index.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createInboxRoutes } from "../src/routes/inbox/index.js";

const OBSERVED_AT = "2026-07-16T12:00:00.000Z";
const ADMIN: ActorContext = {
  userId: "admin",
  orgId: "org_a",
  projectId: null,
  scopes: ["org:admin"],
  source: "session",
};
const MEMBER: ActorContext = { ...ADMIN, userId: "member", scopes: ["org:member"] };

interface RecoveryPoolOptions {
  attention: InboxSourceAttention;
  config: Record<string, unknown> | null;
  failEvent?: boolean;
}

function recoveryPool(options: RecoveryPoolOptions): {
  pool: pg.Pool;
  state: () => { lifecycle: "active" | "needs_attention"; eventTypes: string[]; commits: number; rollbacks: number };
  effects: { authorityReads: number; lifecycleWrites: number };
} {
  let lifecycle: "active" | "needs_attention" = "needs_attention";
  let attention: InboxSourceAttention | null = options.attention;
  let enabled = false;
  let snapshot: {
    lifecycle: typeof lifecycle;
    attention: typeof attention;
    enabled: boolean;
    eventTypes: string[];
  } | null = null;
  let eventTypes: string[] = [];
  let commits = 0;
  let rollbacks = 0;
  const effects = { authorityReads: 0, lifecycleWrites: 0 };

  const row = () => ({
    id: "src_gh",
    org_id: "org_a",
    project_id: "project_a",
    kind: "issues",
    name: "github issues",
    detail: "",
    config: options.config,
    enabled: enabled ? "true" : "false",
    auto_route: "false",
    state: lifecycle,
    attention_code: attention?.code ?? null,
    attention_message: attention?.message ?? null,
    attention_observed_at: attention?.observedAt ?? null,
    webhook_configured: false,
    retry_not_before: null,
    project_valid: true,
  });
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql === "BEGIN") {
      snapshot = { lifecycle, attention, enabled, eventTypes: [...eventTypes] };
      return { rows: [], rowCount: 0 };
    }
    if (sql === "COMMIT") {
      commits += 1;
      snapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (sql === "ROLLBACK") {
      rollbacks += 1;
      if (snapshot !== null) {
        ({ lifecycle, attention, enabled } = snapshot);
        eventTypes = snapshot.eventTypes;
      }
      snapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SET LOCAL")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM inbox_sources WHERE id = $1")) return { rows: [row()], rowCount: 1 };
    if (sql.startsWith("SELECT config FROM organizations")) {
      effects.authorityReads += 1;
      return {
        rows: [
          {
            config: {
              version: 1,
              defaultCredentials: { github_token: "credential/github/org/org_a/default" },
            },
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.startsWith("UPDATE inbox_sources SET state = 'active'")) {
      effects.lifecycleWrites += 1;
      if (lifecycle !== "needs_attention" || attention?.observedAt !== params[2]) {
        return { rows: [], rowCount: 0 };
      }
      lifecycle = "active";
      attention = null;
      enabled = true;
      return { rows: [{ id: "src_gh" }], rowCount: 1 };
    }
    if (sql.includes("event_type, payload") && sql.includes("RETURNING id::text AS id")) {
      if (options.failEvent === true) throw new Error("event append failed");
      eventTypes.push(String(params[5]));
      return { rows: [{ id: "1" }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT pg_notify") || sql.startsWith("NOTIFY ")) return { rows: [], rowCount: 0 };
    throw new Error(`unexpected recovery query: ${sql}`);
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool;
  return {
    pool,
    state: () => ({ lifecycle, eventTypes, commits, rollbacks }),
    effects,
  };
}

function app(pool: pg.Pool, actor: ActorContext): Hono<ActorContextEnv> {
  const inbox = createInboxRoutes({
    pool,
    secrets: new FakeSecretStore(),
    githubHttp: { request: async () => ({ status: 200, body: [] }) },
    answererFactory: () => ({
      triage: async () => {
        throw new Error("triage must not run");
      },
    }),
  });
  const root = new Hono<ActorContextEnv>();
  root.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  root.route("/orgs", inbox);
  return root;
}

async function recover(pool: pg.Pool, actor: ActorContext, expectedObservedAt = OBSERVED_AT): Promise<Response> {
  return app(pool, actor).request("/orgs/org_a/inbox/sources/src_gh/recover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedObservedAt }),
  });
}

const retainedConfig = { owner: "cat-cave", repo: "app", labels: [] };
const credentialAttention: InboxSourceAttention = {
  code: "credential_unavailable",
  message: "repair the organization credential",
  observedAt: OBSERVED_AT,
};

describe("inbox source recovery", () => {
  it("denies an ordinary member before database or authority effects", async () => {
    let connects = 0;
    const pool = { connect: async () => (connects += 1) } as unknown as pg.Pool;
    const response = await recover(pool, MEMBER);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "org_admin_required" });
    expect(connects).toBe(0);
  });

  it("rejects stale observed-at evidence before authority or lifecycle CAS", async () => {
    const fixture = recoveryPool({ attention: credentialAttention, config: retainedConfig });
    const response = await recover(fixture.pool, ADMIN, "2026-07-16T12:01:00.000Z");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "source_recovery_conflict" });
    expect(fixture.effects).toEqual({ authorityReads: 0, lifecycleWrites: 0 });
  });

  it("rejects a discarded invalid config before authority or lifecycle CAS", async () => {
    const fixture = recoveryPool({
      attention: { code: "invalid_config", message: "recreate this source", observedAt: OBSERVED_AT },
      config: null,
    });
    const response = await recover(fixture.pool, ADMIN);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "source_recovery_not_supported" });
    expect(fixture.effects).toEqual({ authorityReads: 0, lifecycleWrites: 0 });
  });

  it("recovers retained config and appends sanctioned evidence in the same commit", async () => {
    const fixture = recoveryPool({ attention: credentialAttention, config: retainedConfig });
    const response = await recover(fixture.pool, ADMIN);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source: { id: "src_gh", state: "active", enabled: true, attention: null, config: retainedConfig },
    });
    expect(fixture.state()).toEqual({
      lifecycle: "active",
      eventTypes: ["credential.configured"],
      commits: 1,
      rollbacks: 0,
    });
  });

  it("rolls the lifecycle CAS back when the EventStore append fails", async () => {
    const fixture = recoveryPool({ attention: credentialAttention, config: retainedConfig, failEvent: true });
    const response = await recover(fixture.pool, ADMIN);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "source_recovery_invalid" });
    expect(fixture.state()).toEqual({ lifecycle: "needs_attention", eventTypes: [], commits: 0, rollbacks: 1 });
  });
});
