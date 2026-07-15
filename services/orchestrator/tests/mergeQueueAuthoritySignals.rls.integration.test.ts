import { migrate, runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { PgEventStore } from "../src/engine/eventStore.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createMergeQueueAuthoritySignalRoutes } from "../src/routes/mergeQueue/authoritySignals.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG_A = "org_mq1_a";
const ORG_B = "org_mq1_b";
const PROJECT_A = "project_mq1_a";
const PROJECT_B = "project_mq1_b";
const EVALUATION = "evaluation-shared-id";

const actorA: ActorContext = {
  userId: "user_mq1_a",
  orgId: ORG_A,
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function dbName(): string {
  return `tanren_mq1_rls_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function runtimeUrl(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = "tanren_app";
  parsed.password = APP_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function buildApp(pool: Pool): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return actorA;
        },
      } as never,
      localDevActor: actorA,
    }),
  );
  app.route("/orgs", createMergeQueueAuthoritySignalRoutes({ pool }));
  return app;
}

describeDb("mq-1 authority-signal route under enforced event RLS", () => {
  const database = dbName();
  let ownerPool: Pool;
  let runtimePool: Pool;
  let app: Hono<ActorContextEnv>;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    runtimePool = new Pool({ connectionString: runtimeUrl(ADMIN_URL, database) });

    // Migration 0042 will carry these production catalog inserts after 0041
    // lands. This isolated RLS proof seeds the same two vocabulary rows locally
    // so it can exercise the route before that serialized migration is cut.
    await ownerPool.query(
      `INSERT INTO event_types (name, default_severity)
       VALUES ('merge.signal.classified', 'info'), ('merge.member.policy_blocked', 'warn')
       ON CONFLICT (name) DO NOTHING`,
    );
    await seedTenant(ownerPool, ORG_A, PROJECT_A, "A");
    await seedTenant(ownerPool, ORG_B, PROJECT_B, "B");
    app = buildApp(runtimePool);
  }, 60_000);

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("returns only org A's same-ID evaluation and conceals org B's project", async () => {
    const own = await app.request(`/orgs/${ORG_A}/projects/${PROJECT_A}/merge-queue/evaluations/${EVALUATION}/signals`);
    expect(own.status).toBe(200);
    const body = (await own.json()) as { signals: Array<{ signal: { memberIds: string[] } }> };
    expect(body.signals).toHaveLength(1);
    expect(body.signals[0]?.signal.memberIds).toEqual(["A"]);

    const crossPath = await app.request(
      `/orgs/${ORG_B}/projects/${PROJECT_B}/merge-queue/evaluations/${EVALUATION}/signals`,
    );
    const crossProject = await app.request(
      `/orgs/${ORG_A}/projects/${PROJECT_B}/merge-queue/evaluations/${EVALUATION}/signals`,
    );
    expect(crossPath.status).toBe(404);
    expect(crossProject.status).toBe(404);

    const raw = await runtimePool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM events WHERE event_type = 'merge.signal.classified'",
    );
    expect(Number(raw.rows[0]?.n)).toBe(0);
  });
});

async function seedTenant(owner: Pool, orgId: string, projectId: string, memberId: string): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, $1, $2, $3)`,
    [projectId, `https://example.com/${projectId}.git`, orgId],
  );
  await runWithOrgScope(owner, orgId, () =>
    new PgEventStore(owner).append({
      projectId,
      orgId,
      eventType: "merge.signal.classified",
      payload: {
        missionNodeId: "mq-1",
        evaluationId: EVALUATION,
        groupId: "group-rls",
        memberIds: [memberId],
        findingIds: [`finding-${memberId}`],
        signalVersion: "merge_signal.v1",
        classification: "deterministic_policy",
        reasonCode: "audit_policy",
        retryability: "non_retryable",
        wakeKey: null,
        repairRoute: "respec",
      },
    }),
  );
}
