// ds-8 RLS proof: public metadata is not private release access; org B must
// redeem a live share before it owns any grant, and can never bind org A's row.

import { createHash } from "node:crypto";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope, setSystemPool } from "@tanren/db";
import type { ActorContext } from "../src/auth/schemas.js";
import { DesignEcosystemService } from "../src/engine/design/system/designEcosystemService.js";
import { InMemorySecretStore } from "../src/engine/contracts/index.js";
import { DesignBindingTargetError, DesignStudioStore } from "../src/engine/design/system/designStudioStore.js";
import { mountFeatureRoutes } from "../src/mountFeatureRoutes.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_ds8_a";
const ORG_B = "org_ds8_b";
const SYSTEM = "system_ds8";
const RELEASE = "release_ds8";
const ARTIFACT = "artifact_ds8";
const PUBLICATION = "publication_ds8";
const DIGEST = `sha256:${"a".repeat(64)}`;
const MANIFEST = `sha256:${"b".repeat(64)}`;
const TOKEN = "cross-org-share-token-with-enough-entropy-12345";
const ORG_B_ADMIN: ActorContext = {
  userId: "admin_b",
  orgId: ORG_B,
  projectId: null,
  scopes: ["org:admin"],
  source: "local_dev",
};

function databaseName(): string {
  return `tanren_ds8_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function databaseUrl(url: string, database: string, app = false): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (app) {
    parsed.username = "tanren_app";
    parsed.password = APP_PASSWORD;
  }
  return parsed.toString();
}
function hash(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

function mountedEcosystemApp(pool: Pool): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use("*", createAuthMiddleware({ store: {} as never, localDevActor: ORG_B_ADMIN }));
  mountFeatureRoutes(app, {
    pool,
    secrets: new InMemorySecretStore(),
    githubHttp: {} as never,
    githubAppMinter: {} as never,
    credentialRegistry: {} as never,
    configGateGithub: {} as never,
    vaultHealthCheck: async () => ({ ok: true, status: 200 }),
    allocator: {} as never,
    ssh: {} as never,
    identitySecretRef: "identity/ds8-test",
  });
  return app;
}

describeDb("ds-8 ecosystem RLS cross-org isolation", () => {
  const database = databaseName();
  let owner: Pool;
  let runtime: Pool;
  let service: DesignEcosystemService;
  let app: Hono<ActorContextEnv>;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: databaseUrl(ADMIN_URL, database) });
    await migrate(owner);
    runtime = new Pool({ connectionString: databaseUrl(ADMIN_URL, database, true) });
    setSystemPool(owner);
    await owner.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1,'oidc',$1,$1,$1,'{"version":1}'::jsonb),($2,'oidc',$2,$2,$2,'{"version":1}'::jsonb)`,
      [ORG_A, ORG_B],
    );
    await runWithOrgScope(runtime, ORG_A, async (client) => {
      await client.query(`INSERT INTO design_systems (org_id,id,slug,name) VALUES ($1,$2,'private','Private DS')`, [
        ORG_A,
        SYSTEM,
      ]);
      await client.query(
        `INSERT INTO design_artifacts (org_id,id,design_system_id,digest,media_type,manifest_version,object_store_key,byte_size)
         VALUES ($1,$2,$3,$4,'application/json',1,'private/key',1)`,
        [ORG_A, ARTIFACT, SYSTEM, MANIFEST],
      );
      await client.query(
        `INSERT INTO design_system_releases
           (org_id,id,design_system_id,version,state,contract_id,contract_version,contract_digest,
            manifest_schema_version,canonical_artifact_id,created_by,published_by,published_at)
         VALUES ($1,$2,$3,1,'published','contract_a',1,$4,1,$5,'seed','seed',now())`,
        [ORG_A, RELEASE, SYSTEM, DIGEST, ARTIFACT],
      );
    });
    await owner.query(
      `INSERT INTO published_design_system_releases
         (publication_id,source_org_id,public_slug,source_release_digest,manifest_digest,safe_preview_digest,license,attribution,state)
       VALUES ($1,$2,'public-console',$3,$4,$5,'MIT','{"notice":"example"}'::jsonb,'published')`,
      [PUBLICATION, ORG_A, DIGEST, MANIFEST, MANIFEST],
    );
    await runWithOrgScope(runtime, ORG_A, (client) =>
      client.query(
        `INSERT INTO design_share_links
           (org_id,id,publication_id,source_release_id,source_release_digest,recipient_org_id,token_hash,permission,expires_at,redemption_limit,revoked_at)
         VALUES ($1,'share_live',$2,$3,$4,$5,$6,'fork','2031-01-01T00:00:00.000Z',1,NULL),
                ($1,'share_expired',$2,$3,$4,$5,$7,'fork','2020-01-01T00:00:00.000Z',1,NULL),
                ($1,'share_revoked',$2,$3,$4,$5,$8,'fork','2031-01-01T00:00:00.000Z',1,now())`,
        [ORG_A, PUBLICATION, RELEASE, DIGEST, ORG_B, hash(TOKEN), hash(`${TOKEN}-expired`), hash(`${TOKEN}-revoked`)],
      ),
    );
    service = new DesignEcosystemService(runtime);
    app = mountedEcosystemApp(runtime);
  }, 60_000);

  afterAll(async () => {
    await runtime?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("NEGATIVE — org B guesses source ids/digests: zero private rows, bytes, grants, or bind", async () => {
    const privateRows = await runWithOrgScope(runtime, ORG_B, (client) =>
      client.query(`SELECT id FROM design_system_releases WHERE id = $1 OR contract_digest = $2`, [RELEASE, DIGEST]),
    );
    const artifactRows = await runWithOrgScope(runtime, ORG_B, (client) =>
      client.query(`SELECT id FROM design_artifacts WHERE id = $1`, [ARTIFACT]),
    );
    const grants = await runWithOrgScope(runtime, ORG_B, (client) =>
      client.query(`SELECT id FROM design_system_grants`),
    );
    expect(privateRows.rowCount).toBe(0);
    expect(artifactRows.rowCount).toBe(0);
    expect(grants.rowCount).toBe(0);
    await expect(
      new DesignStudioStore(runtime).putBinding({
        orgId: ORG_B,
        projectId: "guessed_project",
        designSystemId: SYSTEM,
        pinMode: "release",
        pinnedReleaseId: RELEASE,
        boundBy: "attacker",
      }),
    ).rejects.toBeInstanceOf(DesignBindingTargetError);
  });

  it("NEGATIVE — mounted route blocks a foreign revoke and RLS hides org A Studio rows", async () => {
    await runWithOrgScope(runtime, ORG_A, async (client) => {
      await client.query(
        `INSERT INTO design_system_grants
           (org_id,id,idempotency_key,publication_id,allowed_release_digest,capability,expires_at,revoked_at,import_policy)
         VALUES ($1,'grant_a','grant-a-key',$2,$3,'fork','2030-01-01T00:00:00.000Z',NULL,'{}'::jsonb)`,
        [ORG_A, PUBLICATION, DIGEST],
      );
      await client.query(
        `INSERT INTO design_imports
           (org_id,id,publication_id,source_release_digest,design_system_id,release_id,attribution,sync_policy,last_seen_upstream)
         VALUES ($1,'import_a',$2,$3,$4,$5,'{}'::jsonb,'immutable_fork','upstream-a')`,
        [ORG_A, PUBLICATION, DIGEST, SYSTEM, RELEASE],
      );
      await client.query(
        `INSERT INTO design_external_imports
           (org_id,id,source,locator,external_revision,snapshot_digest,receipt_digest,receipt,disposition)
         VALUES ($1,'external_a','figma','figma://file/a','rev-a',$2,$2,'{}'::jsonb,'candidate')`,
        [ORG_A, DIGEST],
      );
    });
    const beforeEvents = await owner.query(`SELECT id FROM events WHERE org_id = $1`, [ORG_A]);
    const revoked = await app.request(`/v1/orgs/${ORG_B}/design-ecosystem/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "foreign-revoke" },
      body: JSON.stringify({ type: "revoke_publication", publicationId: PUBLICATION }),
    });
    expect(revoked.status).toBe(404);
    expect(await revoked.json()).toEqual({ error: "not_found" });
    const publication = await owner.query<{ state: string; revoked_at: Date | null }>(
      `SELECT state, revoked_at FROM published_design_system_releases WHERE publication_id = $1`,
      [PUBLICATION],
    );
    expect(publication.rows).toEqual([{ state: "published", revoked_at: null }]);
    expect(await owner.query(`SELECT id FROM events WHERE org_id = $1`, [ORG_A])).toEqual(beforeEvents);

    const studio = await app.request(`/v1/orgs/${ORG_B}/design-ecosystem`);
    expect(studio.status).toBe(200);
    expect(await studio.json()).toMatchObject({ grants: [], imports: [], externalImports: [] });
  });

  it("POSITIVE — the public GET remains sanitized; redeem atomically creates only a destination grant", async () => {
    const publication = await service.readPublic(PUBLICATION);
    expect(JSON.stringify(publication)).not.toMatch(/artifactId|objectStore|download|orgId/iu);
    const redeemed = await service.execute({
      orgId: ORG_B,
      actorId: "admin_b",
      idempotencyKey: "redeem_live",
      command: {
        type: "redeem_share",
        grantId: "grant_live",
        publicationId: PUBLICATION,
        releaseDigest: DIGEST,
        bearerToken: TOKEN,
        grantExpiresAt: "2030-01-01T00:00:00.000Z",
      },
    });
    expect(redeemed).toMatchObject({ kind: "grant_redeemed", grantId: "grant_live" });
    const grants = await runWithOrgScope(runtime, ORG_B, (client) =>
      client.query(`SELECT id FROM design_system_grants`),
    );
    expect(grants.rows).toEqual([{ id: "grant_live" }]);
    const foreign = await runWithOrgScope(runtime, ORG_B, (client) =>
      client.query(`SELECT id FROM design_artifacts WHERE id = $1`, [ARTIFACT]),
    );
    expect(foreign.rowCount).toBe(0);
  });

  it("NEGATIVE — expired or revoked tokens return opaque not_found and create zero additional grants", async () => {
    for (const token of [`${TOKEN}-expired`, `${TOKEN}-revoked`]) {
      await expect(
        service.execute({
          orgId: ORG_B,
          actorId: "admin_b",
          idempotencyKey: `bad-${token.slice(-7)}`,
          command: {
            type: "redeem_share",
            grantId: `grant_${token.slice(-7)}`,
            publicationId: PUBLICATION,
            releaseDigest: DIGEST,
            bearerToken: token,
            grantExpiresAt: "2030-01-01T00:00:00.000Z",
          },
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    }
    const grants = await runWithOrgScope(runtime, ORG_B, (client) =>
      client.query(`SELECT id FROM design_system_grants`),
    );
    expect(grants.rowCount).toBe(1);
  });
});
