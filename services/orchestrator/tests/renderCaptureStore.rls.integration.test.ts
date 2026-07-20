// cspell:ignore vcap
// rv-9 real-Postgres proof for the render/response capture store. Skipped unless
// the RLS gate is enabled; every assertion after provisioning runs as the
// non-superuser tanren_app role. It proves: a capture is content-addressed into
// cas_artifacts + verification_artifacts under org scope, an identical capture
// dedupes onto ONE row, and a cross-org reader sees ZERO (RLS denies by default).
import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentDigestOf } from "../src/engine/contracts/cas.js";
import { PgCasByteStore } from "../src/engine/cas/pgCasByteStore.js";
import {
  PgVerificationCaptureStore,
  VerificationArtifactNotFoundError,
} from "../src/engine/verification/acceptance/renderCaptureStore.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_USER = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG_A = "org_rv9_capture_a";
const ORG_B = "org_rv9_capture_b";
const PROJECT_A = "project_rv9_capture_a";
const PROJECT_B = "project_rv9_capture_b";

function databaseName(): string {
  return `tanren_rv9_capture_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function connectionUrl(url: string, database: string, appRole = false): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (appRole) {
    parsed.username = APP_USER;
    parsed.password = APP_PASSWORD;
  }
  return parsed.toString();
}

async function seedTenant(owner: Pool, orgId: string, projectId: string): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [projectId, orgId],
  );
}

describeDb("rv-9 render-capture store — RLS + content-addressed dedupe", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let store: PgVerificationCaptureStore;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(ADMIN_URL, database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(ADMIN_URL, database, true) });
    await seedTenant(owner, ORG_A, PROJECT_A);
    await seedTenant(owner, ORG_B, PROJECT_B);
    store = new PgVerificationCaptureStore(app, new PgCasByteStore(app));
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

  it("connects as the restricted tanren_app non-superuser role", async () => {
    const identity = await app.query<{ current_user: string; rolsuper: boolean }>(
      `SELECT current_user, r.rolsuper FROM pg_roles AS r WHERE r.rolname = current_user`,
    );
    expect(identity.rows[0]?.current_user).toBe(APP_USER);
    expect(identity.rows[0]?.rolsuper).toBe(false);
  });

  it("content-addresses + dedupes a capture and isolates it from other orgs", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ probes: [{ probeId: "p1", status: 200 }] }));
    const digest = contentDigestOf(bytes);

    const first = await store.capture({
      orgId: ORG_A,
      projectId: PROJECT_A,
      kind: "response_capture",
      mediaType: "application/json",
      bytes,
      redactionClass: "sensitive",
    });
    expect(first.casDigest).toBe(digest);
    expect(first.deduped).toBe(false);

    // Identical content of the same kind dedupes onto ONE address/row.
    const again = await store.capture({
      orgId: ORG_A,
      projectId: PROJECT_A,
      kind: "response_capture",
      mediaType: "application/json",
      bytes: new Uint8Array(bytes),
      redactionClass: "sensitive",
    });
    expect(again.verificationArtifactId).toBe(first.verificationArtifactId);
    expect(again.deduped).toBe(true);

    // ORG_A can read its own bytes back (integrity-verified).
    const read = await store.read({ orgId: ORG_A, verificationArtifactId: first.verificationArtifactId });
    expect(read.bytes).toEqual(bytes);

    // Exactly one verification_artifacts + one cas_artifacts row for ORG_A.
    const counts = await runWithOrgScope(app, ORG_A, async (client) => {
      const va = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM verification_artifacts WHERE org_id = $1`,
        [ORG_A],
      );
      const cas = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM cas_artifacts WHERE org_id = $1`, [
        ORG_A,
      ]);
      return { va: va.rows[0]?.n, cas: cas.rows[0]?.n };
    });
    expect(counts.va).toBe("1");
    expect(counts.cas).toBe("1");

    // CROSS-ORG ZERO: ORG_B sees neither the verification_artifacts nor the cas row.
    const foreign = await runWithOrgScope(app, ORG_B, async (client) => {
      const va = await client.query(`SELECT id FROM verification_artifacts WHERE id = $1`, [
        first.verificationArtifactId,
      ]);
      const cas = await client.query(`SELECT digest FROM cas_artifacts WHERE digest = $1`, [digest]);
      return { va: va.rowCount ?? 0, cas: cas.rowCount ?? 0 };
    });
    expect(foreign.va).toBe(0);
    expect(foreign.cas).toBe(0);

    // A read from ORG_B for ORG_A's artifact id fails closed (RLS denies the row).
    await expect(
      store.read({ orgId: ORG_B, verificationArtifactId: first.verificationArtifactId }),
    ).rejects.toBeInstanceOf(VerificationArtifactNotFoundError);
  });
});
