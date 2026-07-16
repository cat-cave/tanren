// Real-Postgres proof for the SP-8 W0 catalog extension and org-scoped append
// path. This stays gated until migration 0042 is unparked after CAS migration
// 0041 lands; once enabled, it exercises the same migration runner and runtime
// RLS role used by the production service.

import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgEventStore } from "../src/engine/eventStore.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_event_vocabulary_w0_a";
const ORG_B = "org_event_vocabulary_w0_b";

const W0_CATALOG_ROWS = [
  { name: "behavior.coverage.selection_analyzed", defaultSeverity: "info" },
  { name: "governance.audit_posture.updated", defaultSeverity: "info" },
  { name: "integration.requirement.validated", defaultSeverity: "info" },
  { name: "merge.member.policy_blocked", defaultSeverity: "warn" },
  { name: "merge.signal.classified", defaultSeverity: "info" },
  { name: "review.simulated_intent", defaultSeverity: "info" },
] as const;

function dbName(): string {
  return `tanren_event_vocabulary_w0_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function runtimeUrl(adminUrl: string, database: string): string {
  const parsed = new URL(adminUrl);
  parsed.username = RUNTIME_ROLE;
  parsed.password = RUNTIME_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

describeDb("SP-8 W0 event catalog and org-scoped append", () => {
  const database = dbName();
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    runtimePool = new Pool({ connectionString: runtimeUrl(ADMIN_URL, database) });

    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb),
              ($2, 'oidc', $2, $2, $2, '{"version":1}'::jsonb)`,
      [ORG_A, ORG_B],
    );
  }, 60_000);

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("seeds all six rows and permits only the matching org scope to append/read them", async () => {
    const catalog = await ownerPool.query<{ name: string; defaultSeverity: string }>(
      `SELECT name, default_severity AS "defaultSeverity"
       FROM event_types
       WHERE name = ANY($1::text[])
       ORDER BY name`,
      [W0_CATALOG_ROWS.map(({ name }) => name)],
    );
    expect(catalog.rows).toEqual(W0_CATALOG_ROWS);

    await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      await appendW0Events(new PgEventStore(runtimePool));
      const visible = await client.query<{ eventType: string }>(
        `SELECT event_type AS "eventType"
         FROM events
         WHERE org_id = $1
         ORDER BY event_type`,
        [ORG_A],
      );
      expect(visible.rows.map(({ eventType }) => eventType)).toEqual(W0_CATALOG_ROWS.map(({ name }) => name));
    });

    const rawRuntime = await runtimePool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM events WHERE org_id = $1",
      [ORG_A],
    );
    expect(Number(rawRuntime.rows[0]?.count)).toBe(0);

    await runWithOrgScope(runtimePool, ORG_B, async (client) => {
      const crossOrg = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM events WHERE org_id = $1",
        [ORG_A],
      );
      expect(Number(crossOrg.rows[0]?.count)).toBe(0);
    });

    const owner = await ownerPool.query<{ eventType: string }>(
      `SELECT event_type AS "eventType"
       FROM events
       WHERE org_id = $1
       ORDER BY event_type`,
      [ORG_A],
    );
    expect(owner.rows.map(({ eventType }) => eventType)).toEqual(W0_CATALOG_ROWS.map(({ name }) => name));
  });
});

async function appendW0Events(store: PgEventStore): Promise<void> {
  const shaA = `sha256:${"a".repeat(64)}`;
  const shaB = `sha256:${"b".repeat(64)}`;
  const mergeIdentity = {
    missionNodeId: "mq-1" as const,
    evaluationId: `mqeval_${"a".repeat(64)}`,
    groupId: `mqgrp_${"b".repeat(64)}`,
    signalVersion: "merge_signal.v1" as const,
  };
  const deterministicPolicy = {
    ...mergeIdentity,
    memberIds: ["member-a"],
    findingIds: ["finding-a"],
    classification: "deterministic_policy" as const,
    reasonCode: "audit_policy" as const,
    retryability: "non_retryable" as const,
    wakeKey: null,
    disposition: "member_repair" as const,
  };

  await store.append({
    orgId: ORG_A,
    eventType: "integration.requirement.validated",
    payload: {
      missionNodeId: "in-2",
      requirementDigest: shaA,
      artifact: {
        digest: shaB,
        byteSize: 42,
        mediaType: "application/vnd.tanren.integration-requirement.v1+json",
      },
      capability: "github.pull_request.read",
      plane: "control",
      direction: "inbound",
      criticality: "merge_required",
    },
  });
  await store.append({
    orgId: ORG_A,
    eventType: "behavior.coverage.selection_analyzed",
    payload: {
      version: "v1",
      analysisId: "analysis-1",
      mode: "targeted",
      changedTargets: [{ kind: "source", targetRef: "src/index.ts" }],
      unknownTargets: [],
      selected: [
        {
          behaviorRevisionId: "behavior-revision-1",
          reasons: [{ kind: "direct_edge", edgeId: "edge-1", target: { kind: "source", targetRef: "src/index.ts" } }],
        },
      ],
      excluded: [],
    },
  });
  await store.append({
    orgId: ORG_A,
    eventType: "governance.audit_posture.updated",
    payload: {
      actorUserId: "user-1",
      previous: { blockReviewAt: "P1", p2p3Handling: "fix-if-idle", autonomousRemediation: false },
      current: { blockReviewAt: "P0", p2p3Handling: "route-to-dag", autonomousRemediation: true },
    },
  });
  await store.append({
    orgId: ORG_A,
    eventType: "review.simulated_intent",
    payload: {
      headSha: "a".repeat(40),
      state: "approved",
      event: "APPROVE",
      body: "Simulated review\ntanren-simulated-review:v1:approved",
      message: "Simulation only",
      reviewerLogin: "tanren-simulator",
      marker: "tanren-simulated-review:v1:approved",
    },
  });
  await store.append({ orgId: ORG_A, eventType: "merge.signal.classified", payload: deterministicPolicy });
  await store.append({ orgId: ORG_A, eventType: "merge.member.policy_blocked", payload: deterministicPolicy });
}
