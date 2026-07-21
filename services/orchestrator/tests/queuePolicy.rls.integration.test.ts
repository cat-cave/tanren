// mq-14 live RLS proof: policy, windows, and idempotent commands all require a
// scoped tanren_app transaction; no unscoped or cross-org row can become evidence.
import { migrate, runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QueuePolicyControlStore } from "../src/engine/merge/queuePolicyControlStore.js";
import { QueuePolicyController } from "../src/engine/merge/queuePolicyController.js";
import type { ActorContext } from "../src/auth/schemas.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createQueuePolicyRoutes } from "../src/routes/mergeQueue/policy.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_mq14_a";
const ORG_B = "org_mq14_b";
const PROJECT_A = "project_mq14_a";
const PROJECT_B = "project_mq14_b";

function dbName(): string {
  return `tanren_mq14_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function databaseUrl(base: string, database: string, app = false): string {
  const parsed = new URL(base);
  parsed.pathname = `/${database}`;
  if (app) {
    parsed.username = "tanren_app";
    parsed.password = APP_PASSWORD;
  }
  return parsed.toString();
}

const POLICY = {
  schemaVersion: "queue_policy.v1",
  routes: [
    {
      name: "main",
      targetBranch: "main",
      matcher: { kind: "branch", equals: "main" },
      priority: { base: "P1", aging: { enabled: true, step: 1 } },
      partition: { mode: "serial", capacity: 1, batchLimit: 1, deployGroupLimit: 1 },
      interruption: { mode: "hold" },
      requiredWindows: ["business"],
    },
  ],
};

function policyApp(pool: Pool): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  const actor: ActorContext = {
    userId: "platform_mq14",
    orgId: null,
    projectId: null,
    scopes: ["platform:admin"],
    source: "local_dev",
  };
  app.use("*", async (context, next) => {
    context.set("actor", actor);
    await next();
  });
  app.route("/orgs", createQueuePolicyRoutes({ pool }));
  return app;
}

describeDb("mq-14 QueuePolicyV1 under enforced RLS", () => {
  const database = dbName();
  let owner: Pool;
  let app: Pool;
  let controls: QueuePolicyControlStore;
  let controller: QueuePolicyController;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: databaseUrl(ADMIN_URL, database) });
    await migrate(owner);
    app = new Pool({ connectionString: databaseUrl(ADMIN_URL, database, true) });
    for (const [orgId, projectId] of [
      [ORG_A, PROJECT_A],
      [ORG_B, PROJECT_B],
    ] as const) {
      await owner.query(
        `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
         VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
        [orgId],
      );
      await owner.query(
        "INSERT INTO projects (project_id, name, repo_url, org_id) VALUES ($1, $1, 'https://example.com/mq-14.git', $2)",
        [projectId, orgId],
      );
    }
    controls = new QueuePolicyControlStore(app);
    controller = new QueuePolicyController(app);
  }, 60_000);

  afterAll(async () => {
    await app?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("persists a scoped policy/window and one idempotent command, then hides every row outside org A", async () => {
    const saved = await controls.putPolicy({ orgId: ORG_A, projectId: PROJECT_A, body: POLICY });
    await controls.addWindow({
      orgId: ORG_A,
      projectId: PROJECT_A,
      window: {
        schemaVersion: "queue_window.v1",
        name: "business",
        kind: "allow",
        timezone: "UTC",
        scope: { projectId: PROJECT_A },
        intervals: [{ startsAt: "2026-07-20T00:00:00.000Z", endsAt: "2026-07-21T00:00:00.000Z" }],
      },
    });
    const first = await controller.apply({
      kind: "command",
      orgId: ORG_A,
      projectId: PROJECT_A,
      actorId: "actor_mq14",
      command: {
        schemaVersion: "queue_command.v1",
        command: "freeze",
        idempotencyKey: "freeze_once",
        scope: { projectId: PROJECT_A },
        reason: "adversarial freeze",
      },
    });
    const duplicate = await controller.apply({
      kind: "command",
      orgId: ORG_A,
      projectId: PROJECT_A,
      actorId: "actor_mq14",
      command: {
        schemaVersion: "queue_command.v1",
        command: "freeze",
        idempotencyKey: "freeze_once",
        scope: { projectId: PROJECT_A },
        reason: "adversarial freeze",
      },
    });
    expect(duplicate).toEqual(first);
    const own = await runWithOrgScope(app, ORG_A, async (client) =>
      client.query<{ policies: string; windows: string; commands: string }>(
        `SELECT (SELECT count(*)::text FROM merge_queue_policies WHERE id = $1) AS policies,
                (SELECT count(*)::text FROM merge_queue_windows WHERE policy_id = $1) AS windows,
                (SELECT count(*)::text FROM merge_queue_commands WHERE idempotency_key = 'freeze_once') AS commands`,
        [saved.id],
      ),
    );
    expect(own.rows[0]).toEqual({ policies: "1", windows: "1", commands: "1" });
    const cross = await runWithOrgScope(app, ORG_B, async (client) =>
      client.query<{ policies: string; windows: string; commands: string }>(
        `SELECT (SELECT count(*)::text FROM merge_queue_policies WHERE id = $1) AS policies,
                (SELECT count(*)::text FROM merge_queue_windows WHERE policy_id = $1) AS windows,
                (SELECT count(*)::text FROM merge_queue_commands WHERE idempotency_key = 'freeze_once') AS commands`,
        [saved.id],
      ),
    );
    expect(cross.rows[0]).toEqual({ policies: "0", windows: "0", commands: "0" });
    for (const table of ["merge_queue_policies", "merge_queue_windows", "merge_queue_commands"]) {
      const unscoped = await app.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
      expect(unscoped.rows[0]?.count).toBe("0");
    }
  });

  it("rejects a non-grammar policy at the HTTP gate without an orphan policy or event", async () => {
    const before = await owner.query<{ policies: string; events: string }>(
      `SELECT (SELECT count(*)::text FROM merge_queue_policies) AS policies,
              (SELECT count(*)::text FROM events WHERE event_type = 'merge.policy.revised') AS events`,
    );
    const response = await policyApp(app).request(`/orgs/${ORG_A}/projects/${PROJECT_A}/merge-queue/policy/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...POLICY, shell: "land now" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "queue_policy_invalid" });
    const after = await owner.query<{ policies: string; events: string }>(
      `SELECT (SELECT count(*)::text FROM merge_queue_policies) AS policies,
              (SELECT count(*)::text FROM events WHERE event_type = 'merge.policy.revised') AS events`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
