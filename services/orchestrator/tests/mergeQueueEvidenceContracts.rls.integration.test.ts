// cspell:ignore mq12rls
import { migrate } from "@tanren/db";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  fragmentEvidenceContentBytes,
  fragmentEvidenceContentDigest,
} from "../src/engine/templates/fragments/fragmentEvidenceContract.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createMergeQueueEvidenceContractRoutes } from "../src/routes/mergeQueue/evidenceContracts.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_mq12_a";
const ORG_B = "org_mq12_b";
const PROJECT_A = "project_mq12_a";
const PROJECT_B = "project_mq12_b";
const NODE_A = "inode_mq12_a";
const DIGEST_INPUT = {
  schemaVersion: "fragment_evidence.v1" as const,
  junitReportPath: "reports/junit.xml",
  testSelector: { path: ".tanren/test-selector.json", format: "json" as const },
  behaviorManifest: { path: ".tanren/behavior-manifest.json", format: "json" as const },
  contentDigest: `sha256:${"0".repeat(64)}`,
};
const DIGEST = fragmentEvidenceContentDigest(DIGEST_INPUT);
const CONTRACT = { ...DIGEST_INPUT, contentDigest: DIGEST };
const CONTRACT_BYTES = fragmentEvidenceContentBytes(CONTRACT);
const ACTOR_A: ActorContext = {
  userId: "user_mq12",
  orgId: ORG_A,
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function databaseName(): string {
  return `tanren_mq12_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(database: string, app = false): string {
  const parsed = new URL(ADMIN_URL);
  parsed.pathname = `/${database}`;
  if (app) {
    parsed.username = "tanren_app";
    parsed.password = APP_PASSWORD;
  }
  return parsed.toString();
}

function routeApp(pool: Pool): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", ACTOR_A);
    await next();
  });
  app.route("/orgs", createMergeQueueEvidenceContractRoutes({ pool }));
  return app;
}

async function seed(owner: Pool): Promise<void> {
  for (const [org, project] of [
    [ORG_A, PROJECT_A],
    [ORG_B, PROJECT_B],
  ] as const) {
    await owner.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [org],
    );
    await owner.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
       VALUES ($1, $1, 'https://example.invalid/repo.git', 'main', 'runner:v1', $2, '{}'::jsonb)`,
      [project, org],
    );
  }
  await owner.query(
    `INSERT INTO fragments (fragment_id, org_id, kind, label, version, body_ts, contract, depends_on, status, validated_at)
     VALUES ('mq12:runtime-custom:1', $1, 'runtime', 'custom', '1', 'body', $2::jsonb, '[]'::jsonb, 'validated', now())`,
    [ORG_A, JSON.stringify({ reportPath: "reports/junit.xml", evidence: CONTRACT })],
  );
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, $3, 'application/vnd.tanren.fragment-evidence-contract+json', 'inline_pg', $4)`,
    [ORG_A, DIGEST, CONTRACT_BYTES.byteLength, Buffer.from(CONTRACT_BYTES)],
  );
  await owner.query(
    `INSERT INTO verification_artifacts
       (org_id, id, project_id, cas_digest, proof_unit_digest, kind, media_type, byte_size, redaction_class, retention_class)
     VALUES ($1, 'verification_artifact_mq12', $2, $3, NULL, 'fragment_evidence_contract',
             'application/vnd.tanren.fragment-evidence-contract+json', $4, 'sensitive', 'standard')`,
    [ORG_A, PROJECT_A, DIGEST, CONTRACT_BYTES.byteLength],
  );
  await owner.query(
    `INSERT INTO integration_proof_units
       (org_id, project_id, proof_unit_id, kind, subject_id, input_hash, verdict, artifact_hash, source_node_id, quarantine_epoch)
     VALUES ($1, $2, 'punit_mq12', 'artifact_provenance', 'fragment_evidence:selected', $3, 'pass', $3, $4, 0)`,
    [ORG_A, PROJECT_A, DIGEST, NODE_A],
  );
}

describeDb("mq-12 evidence-contract route RLS", () => {
  const database = databaseName();
  let owner: Pool;
  let appPool: Pool;
  let app: Hono<ActorContextEnv>;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: withDatabase(database) });
    await migrate(owner);
    await seed(owner);
    appPool = new Pool({ connectionString: withDatabase(database, true) });
    app = routeApp(appPool);
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("returns the redacted frozen contract only for the owner project and hides cross-org proof/artifact reads", async () => {
    const own = await app.request(`/orgs/${ORG_A}/projects/${PROJECT_A}/merge-queue/evidence-contracts/${NODE_A}`);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({
      resolutionStatus: "selected",
      contract: { contentDigest: DIGEST, junitReportPath: "reports/junit.xml" },
      proofUnit: { id: "punit_mq12", artifactDigest: DIGEST },
    });
    const otherOrg = await app.request(`/orgs/${ORG_B}/projects/${PROJECT_B}/merge-queue/evidence-contracts/${NODE_A}`);
    const crossProject = await app.request(
      `/orgs/${ORG_A}/projects/${PROJECT_B}/merge-queue/evidence-contracts/${NODE_A}`,
    );
    expect(otherOrg.status).toBe(404);
    expect(crossProject.status).toBe(404);
  });

  it("shows zero tenant proof/artifact rows off the scoped client", async () => {
    for (const table of ["integration_proof_units", "verification_artifacts"] as const) {
      const result = await appPool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
      expect(result.rows[0]?.count).toBe("0");
    }
  });
});
