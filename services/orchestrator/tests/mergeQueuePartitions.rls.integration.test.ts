// cspell:ignore mqgrp
// MQ-4's live RLS proof. The owner provisions/migrates the isolated database;
// every queue, lease, partition, and event assertion runs through tanren_app.

import { migrate, resetSystemPool, runWithOrgScope, setSystemPool } from "@tanren/db";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { PgMergeQueueEventEmitter, PgMergeQueueModel } from "../src/engine/merge/coordinatorPg.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createMergeQueueScheduleRoutes } from "../src/routes/mergeQueue/schedule.js";
import { DirectRunStateWriter } from "../src/engine/worker/directRunStateWriter.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG = "org_mq4";
const PROJECT = "project_mq4";

function dbName(): string {
  return `tanren_mq4_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function appUrl(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = "tanren_app";
  parsed.password = APP_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function seedMember(owner: Pool, id: string): Promise<void> {
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, $1, 'mq-4 lease fixture', 'in_flight')`,
    [`spec_${id}`, PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'ci', $1, 'completed')`,
    [`run_${id}`, `spec_${id}`, PROJECT, ORG],
  );
}

describeDb("MQ-4 partition leases under tanren_app RLS", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;
  let queue: PgMergeQueueModel;
  const queueIds = new Map<string, string>();

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    appPool = new Pool({ connectionString: appUrl(ADMIN_URL, database) });
    setSystemPool(ownerPool);
    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [ORG],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id)
       VALUES ($1, 'mq-4', 'https://example.com/mq-4.git', $2)`,
      [PROJECT, ORG],
    );
    for (const member of ["a", "b", "orphan", "fenced", "poison", "sibling"]) await seedMember(ownerPool, member);
    const events = new PgMergeQueueEventEmitter(appPool, new DirectRunStateWriter(appPool));
    queue = new PgMergeQueueModel(appPool, events);
    for (const [member, scopeFingerprint] of [
      ["a", "scope-a"],
      ["b", "scope-b"],
      ["orphan", "scope-orphan"],
      ["fenced", "scope-fenced"],
      ["poison", "scope-shared"],
      ["sibling", "scope-shared"],
    ] as const) {
      const created = await queue.enqueue({
        projectId: PROJECT,
        runId: `run_${member}`,
        specId: `spec_${member}`,
        prUrl: `https://example.com/pr/${member}`,
        prNumber: queueIds.size + 1,
        targetBranch: "main",
        scopeFingerprint,
      });
      queueIds.set(member, created.queueId);
    }
  }, 60_000);

  afterAll(async () => {
    resetSystemPool();
    await appPool?.end();
    await ownerPool?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("permits disjoint scopes concurrently and refuses a second holder", async () => {
    await expect(queue.claim(queueIds.get("a")!)).resolves.toBe(true);
    await expect(queue.claim(queueIds.get("b")!)).resolves.toBe(true);
    await expect(queue.claim(queueIds.get("a")!)).resolves.toBe(false);
    const rows = await runWithOrgScope(appPool, ORG, async (client) =>
      client.query<{ partition_id: string; lease_owner: string; lease_expires_at: Date }>(
        `SELECT partition_id, lease_owner, lease_expires_at
           FROM merge_queue
          WHERE queue_id IN ($1, $2) AND status = 'merging'
          ORDER BY queue_id`,
        [queueIds.get("a"), queueIds.get("b")],
      ),
    );
    expect(rows.rows).toHaveLength(2);
    expect(new Set(rows.rows.map((row) => row.partition_id)).size).toBe(2);
    expect(rows.rows.every((row) => row.lease_owner !== "" && row.lease_expires_at instanceof Date)).toBe(true);
    const identity = await runWithOrgScope(appPool, ORG, (client) =>
      client.query<{ current_user: string }>("SELECT current_user"),
    );
    expect(identity.rows[0]?.current_user).toBe("tanren_app");
    const unscoped = await appPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM merge_queue_partitions",
    );
    expect(unscoped.rows[0]?.count).toBe("0");
  });

  it("reclaims only a stale progress heartbeat and lets a new owner acquire it", async () => {
    // `lease_expires_at` records the last ActivityWatchdog progress. A stale
    // heartbeat is the durable absence-of-progress proof for recovery.
    await runWithOrgScope(appPool, ORG, (client) =>
      client.query("UPDATE merge_queue SET lease_expires_at = now() - interval '2 seconds' WHERE queue_id = $1", [
        queueIds.get("a"),
      ]),
    );
    await expect(queue.recoverStaleClaims(PROJECT)).resolves.toBe(1);
    await expect(queue.claim(queueIds.get("a")!)).resolves.toBe(true);
    expect(queue.renewClaim).toBeDefined();
    await expect(queue.renewClaim!(queueIds.get("a")!)).resolves.toBe(true);
  });

  it("fences a reclaimed owner from settlement and host land while the new owner lands once", async () => {
    const queueId = queueIds.get("fenced")!;
    const replacement = new PgMergeQueueModel(appPool);
    await expect(queue.claim(queueId)).resolves.toBe(true);
    await runWithOrgScope(appPool, ORG, (client) =>
      client.query("UPDATE merge_queue SET lease_expires_at = now() - interval '2 seconds' WHERE queue_id = $1", [
        queueId,
      ]),
    );
    await expect(replacement.recoverStaleClaims(PROJECT)).resolves.toBe(1);
    await expect(replacement.claim(queueId)).resolves.toBe(true);

    // Original owner A cannot mutate B's epoch and must not call the host seam.
    expect(await queue.markMerged(queueId)).toBe(false);
    expect(await queue.releaseClaim(queueId)).toBe(false);
    let lands = 0;
    const landAuthorizedIntegration = async (owner: PgMergeQueueModel): Promise<boolean> => {
      if (!(await owner.renewClaim!(queueId))) return false;
      lands += 1;
      return owner.markMerged(queueId);
    };
    expect(await landAuthorizedIntegration(queue)).toBe(false);
    expect(lands).toBe(0);

    expect(await landAuthorizedIntegration(replacement)).toBe(true);
    expect(lands).toBe(1);
  });

  it("isolates a poison member, releases its shared scope, and appends the frozen event", async () => {
    await expect(queue.claim(queueIds.get("poison")!)).resolves.toBe(true);
    await expect(
      queue.isolateMember({
        queueId: queueIds.get("poison")!,
        groupId: "mqgrp_mq4",
        memberId: "spec_poison",
        reason: "audit_policy",
        findingIds: ["finding_mq4_poison"],
      }),
    ).resolves.toBe(true);
    const isolated = await runWithOrgScope(appPool, ORG, async (client) =>
      client.query<{ mode: string; lease_owner: string | null; partition_id: string }>(
        `SELECT p.mode, mq.lease_owner, mq.partition_id
           FROM merge_queue mq
           JOIN merge_queue_partitions p ON p.org_id = mq.org_id AND p.id = mq.partition_id
          WHERE mq.queue_id = $1`,
        [queueIds.get("poison")],
      ),
    );
    const partitionId = isolated.rows[0]?.partition_id;
    expect(isolated.rows[0]).toMatchObject({ mode: "isolated", lease_owner: null });
    expect(partitionId).toBeTruthy();
    await expect(queue.claim(queueIds.get("sibling")!)).resolves.toBe(true);
    const events = await runWithOrgScope(appPool, ORG, async (client) =>
      client.query<{ event_type: string; payload: { memberId: string; partitionId: string } }>(
        "SELECT event_type, payload FROM events WHERE event_type = 'merge.member.isolated' ORDER BY ts, id",
      ),
    );
    expect(events.rows.at(-1)).toMatchObject({
      event_type: "merge.member.isolated",
      payload: { memberId: "spec_poison", partitionId },
    });
  });

  it("serves semantic scheduling only within the requesting org and RLS rejects cross-org partition mutation", async () => {
    const app = scheduleApp(appPool, platformActor());
    const own = await app.request(`/orgs/${ORG}/projects/${PROJECT}/merge-queue/schedule`);
    expect(own.status).toBe(200);
    await expect(own.json()).resolves.toMatchObject({ schedule: { selectedCap: 1, partitions: expect.any(Array) } });

    const cross = await app.request(`/orgs/org_other/projects/${PROJECT}/merge-queue/schedule`);
    expect(cross.status).toBe(404);
    const mutation = await runWithOrgScope(appPool, "org_other", (client) =>
      client.query(
        "UPDATE merge_queue SET scope_fingerprint = 'semantic:v1:all_scopes' WHERE project_id = $1 RETURNING queue_id",
        [PROJECT],
      ),
    );
    expect(mutation.rowCount).toBe(0);
  });

  it("blocks scheduling rather than coercing malformed dependency data to an empty set", async () => {
    await ownerPool.query("UPDATE specs SET depends_on = ARRAY['']::text[] WHERE spec_id = 'spec_orphan'");

    await expect(queue.loadSnapshot(PROJECT)).rejects.toThrow(
      "spec spec_orphan depends_on must be an array of non-blank strings",
    );
  });
});

function scheduleApp(pool: Pool, actor: ActorContext): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (context, next) => {
    context.set("actor", actor);
    await next();
  });
  app.route("/orgs", createMergeQueueScheduleRoutes({ pool }));
  return app;
}

function platformActor(): ActorContext {
  return { userId: "user_mq4", orgId: null, projectId: null, scopes: ["platform:admin"], source: "local_dev" };
}
