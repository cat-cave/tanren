// in-2 apex proof: real HTTP -> validated requirement -> durable event -> CAS bytes.
// Gated behind TANREN_RLS_DB_TEST=1 + an owner/superuser DATABASE_URL.

import { migrate, runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { PgCasByteStore } from "../src/engine/cas/pgCasByteStore.js";
import { contentDigestOf, parseDigest } from "../src/engine/contracts/cas.js";
import {
  canonicalRequirementBytes,
  goldenControlNotifyRequirement,
  goldenCrossPlaneForbiddenRequirement,
  goldenProductMessagingRequirement,
} from "../src/engine/contracts/integrationRequirement.js";
import { orgScopingPool } from "../src/engine/data/orgScopedDb.js";
import { IntegrationRequirementValidatedPayload } from "../src/engine/events/schemas/eventVocabularyW0.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createBehaviorRoutes } from "../src/routes/behaviors/index.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_in2_apex_a";
const ORG_B = "org_in2_apex_b";
const ORG_NEGATIVE = "org_in2_apex_negative";

interface ValidateResponse {
  readonly ok: true;
  readonly missionNodeId: "in-2";
  readonly persisted: boolean;
  readonly requirementDigest: string;
  readonly artifact: {
    readonly digest: string;
    readonly byteSize: number;
    readonly mediaType: string;
  };
}

function dbName(): string {
  return `tanren_in2_apex_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

function actorFor(orgId: string): ActorContext {
  return {
    userId: `user_${orgId}`,
    orgId,
    projectId: null,
    scopes: ["org:member"],
    source: "session",
  };
}

function buildProductionWire(pool: Pool, actor: ActorContext) {
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return actor;
        },
      } as never,
      localDevActor: actor,
      pool,
    }),
  );
  app.route("/orgs", createBehaviorRoutes({ pool: orgScopingPool(pool) }));
  return app;
}

describeDb("integration contracts apex (in-2)", () => {
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
              ($2, 'oidc', $2, $2, $2, '{"version":1}'::jsonb),
              ($3, 'oidc', $3, $3, $3, '{"version":1}'::jsonb)`,
      [ORG_A, ORG_B, ORG_NEGATIVE],
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

  it("proves HTTP validation -> governed event -> retrievable CAS bytes under RLS", async () => {
    const app = buildProductionWire(runtimePool, actorFor(ORG_A));
    const requirement = goldenProductMessagingRequirement();
    const requestBody = JSON.stringify({ requirement, persist: true });

    const first = await app.request(`/orgs/${ORG_A}/integration-contracts:validate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "tanren_session=dev" },
      body: requestBody,
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as ValidateResponse;
    expect(firstBody).toMatchObject({ ok: true, missionNodeId: "in-2", persisted: true });

    const firstEvents = await loadValidationEvents(runtimePool, ORG_A, ORG_A);
    expect(firstEvents).toHaveLength(1);
    const payload = IntegrationRequirementValidatedPayload.parse(firstEvents[0]?.payload);
    expect(payload.requirementDigest).toBe(firstBody.requirementDigest);
    expect(payload.artifact).toEqual(firstBody.artifact);

    const digest = parseDigest(firstBody.artifact.digest);
    const stored = await new PgCasByteStore(runtimePool).get(ORG_A, digest);
    expect(contentDigestOf(stored.bytes)).toBe(digest);
    expect(stored.mediaType).toBe(firstBody.artifact.mediaType);
    expect(Buffer.from(stored.bytes).equals(Buffer.from(canonicalRequirementBytes(requirement)))).toBe(true);

    const crossOrgEvents = await loadValidationEvents(runtimePool, ORG_B, ORG_A);
    expect(crossOrgEvents).toHaveLength(0);
    expect(await new PgCasByteStore(runtimePool).has(ORG_B, digest)).toBe(false);

    const second = await app.request(`/orgs/${ORG_A}/integration-contracts:validate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "tanren_session=dev" },
      body: requestBody,
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as ValidateResponse;
    expect(secondBody.artifact.digest).toBe(firstBody.artifact.digest);
    expect(await loadValidationEvents(runtimePool, ORG_A, ORG_A)).toHaveLength(2);
    expect(await countCasArtifacts(runtimePool, ORG_A, digest)).toBe(1);

    const denied = await app.request(`/orgs/${ORG_B}/integration-contracts:validate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "tanren_session=dev" },
      body: requestBody,
    });
    expect(denied.status).toBe(403);
    expect(await loadValidationEvents(runtimePool, ORG_B, ORG_B)).toHaveLength(0);
  });

  it("proves preview, invalid, malformed, and denied requests have zero durable effects", async () => {
    const app = buildProductionWire(runtimePool, actorFor(ORG_NEGATIVE));
    const preview = await app.request(`/orgs/${ORG_NEGATIVE}/integration-contracts:validate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "tanren_session=dev" },
      body: JSON.stringify({ requirement: goldenControlNotifyRequirement(), persist: false }),
    });
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as ValidateResponse;
    expect(previewBody.persisted).toBe(false);
    expect(await new PgCasByteStore(runtimePool).has(ORG_NEGATIVE, parseDigest(previewBody.artifact.digest))).toBe(
      false,
    );

    const invalid = await app.request(`/orgs/${ORG_NEGATIVE}/integration-contracts:validate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "tanren_session=dev" },
      body: JSON.stringify({ requirement: goldenCrossPlaneForbiddenRequirement() }),
    });
    expect(invalid.status).toBe(422);

    const malformed = await app.request(`/orgs/${ORG_NEGATIVE}/integration-contracts:validate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "tanren_session=dev" },
      body: JSON.stringify({ requirement: goldenProductMessagingRequirement(), persist: "yes" }),
    });
    expect(malformed.status).toBe(400);

    const denied = await app.request(`/orgs/${ORG_B}/integration-contracts:validate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "tanren_session=dev" },
      body: JSON.stringify({ requirement: goldenProductMessagingRequirement() }),
    });
    expect(denied.status).toBe(403);
    expect(await loadValidationEvents(runtimePool, ORG_NEGATIVE, ORG_NEGATIVE)).toHaveLength(0);
    expect(await countAllCasArtifacts(runtimePool, ORG_NEGATIVE)).toBe(0);
  });
});

async function loadValidationEvents(pool: Pool, scopeOrgId: string, targetOrgId: string) {
  const result = await runWithOrgScope(pool, scopeOrgId, (client) =>
    client.query<{ payload: unknown }>(
      `SELECT payload
       FROM events
       WHERE org_id = $1 AND event_type = 'integration.requirement.validated'
       ORDER BY id`,
      [targetOrgId],
    ),
  );
  return result.rows;
}

async function countCasArtifacts(pool: Pool, orgId: string, digest: string): Promise<number> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM cas_artifacts WHERE org_id = $1 AND digest = $2",
      [orgId, digest],
    );
    return Number(result.rows[0]?.count);
  });
}

async function countAllCasArtifacts(pool: Pool, orgId: string): Promise<number> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM cas_artifacts WHERE org_id = $1",
      [orgId],
    );
    return Number(result.rows[0]?.count);
  });
}
