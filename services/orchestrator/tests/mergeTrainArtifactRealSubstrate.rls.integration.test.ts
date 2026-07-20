// cspell:ignore mqreal headsha mainsha expmain
// SP-3 × mq-15 LIVE-WIRING proof (gated on TANREN_RLS_DB_TEST; decisive writes run as the
// non-superuser tanren_app role). Where `mergeTrainArtifact.rls.integration.test.ts` drives
// the watcher with a test substrate double, THIS proves the PRODUCTION connect-up: the sole
// production `PgProofSubstrate` (ed25519, the class the worker/route now assemble) seals a
// completed land group through mq-15's watcher, and the export route RE-VERIFIES that real
// bundle cryptographically. The negative control proves the fail-CLOSED posture: absent the
// platform signing key, the SAME watcher's seal throws LOUD (never a silent dormant no-op).

import { migrate, resetSystemPool, runWithOrgScope, setSystemPool } from "@tanren/db";
import { generateKeyPairSync } from "node:crypto";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { PgCasByteStore } from "../src/engine/cas/pgCasByteStore.js";
import { PgProofSubstrate, PROOF_SIGNING_KEY_REF } from "../src/engine/cas/pgProofSubstrate.js";
import { ProofSigningKeyUnavailableError } from "../src/engine/cas/proofSigningKey.js";
import { MergeTrainArtifactWatcher } from "../src/engine/postMerge/mergeTrainArtifactWatcher.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createMergeTrainArtifactRoutes } from "../src/routes/mergeQueue/trainArtifact.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG = "org_mqreal";
const PROJECT = "project_mqreal";
const NODE = "inode_mqreal";
const DECISION = "decision-inode_mqreal-headsha";
const LG = "lg_mqreal";
const RUN = "run_mqreal";
const SPEC = "spec_mqreal";
const MAIN = "mainsha_mqreal";
const HEAD = "headsha";
const EXPECTED_MAIN = "expmain_mqreal";
const PROOF_ROOT = `sha256:${"a".repeat(64)}`;
const ARTIFACT_DIGEST = `sha256:${"b".repeat(64)}`;
const MSH = "member-set-hash";

function databaseName(): string {
  return `tanren_mqreal_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function connectionUrl(database: string, role?: { user: string; password: string }): string {
  const parsed = new URL(ADMIN_URL);
  parsed.pathname = `/${database}`;
  if (role !== undefined) {
    parsed.username = role.user;
    parsed.password = role.password;
  }
  return parsed.toString();
}

/** A hermetic ed25519 platform signing key at the PRODUCTION ref the substrate defaults to. */
function secretsWithKey(): InMemorySecretStore {
  const { privateKey } = generateKeyPairSync("ed25519");
  const store = new InMemorySecretStore();
  void store.put({ ref: PROOF_SIGNING_KEY_REF, value: privateKey.export({ type: "pkcs8", format: "pem" }) as string });
  return store;
}

const EVENTS_TABLE = "events";
async function insertEvents(owner: Pool, rows: ReadonlyArray<[string, unknown]>): Promise<void> {
  for (const [eventType, payload] of rows) {
    await owner.query(
      `INSERT INTO ${EVENTS_TABLE} (run_id, project_id, spec_id, org_id, event_type, payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [RUN, PROJECT, SPEC, ORG, eventType, JSON.stringify(payload)],
    );
  }
}

/** Seed ONE org + a fully-evidenced completed land group (matches the mq-15 seal gates). */
async function seed(owner: Pool): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [ORG],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, 'p', 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, acceptance_criteria, status, created_at)
     VALUES ($1,$2,$3,'t','d','[]'::jsonb,'in_flight','2026-07-20T00:00:00.000Z')`,
    [SPEC, PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status, pr_url)
     VALUES ($1,$2,$3,$4,'cli','tanren/x','completed','https://example.com/pr/1')`,
    [RUN, SPEC, PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO authority_decisions
       (org_id, project_id, id, integration_node_id, subject_kind, head_sha, expected_main_sha,
        artifact_digest, proof_root, member_set_hash, policy_version, decision)
     VALUES ($1,$2,$3,$4,'integration_node',$5,$6,$7,$8,$9,'1','authorized')`,
    [ORG, PROJECT, DECISION, NODE, HEAD, EXPECTED_MAIN, ARTIFACT_DIGEST, PROOF_ROOT, MSH],
  );
  await owner.query(
    `INSERT INTO land_groups (org_id, id, decision_id, expected_main_sha, authorized_sha, state, main_sha, reconcile_token)
     VALUES ($1,$2,$3,$4,$5,'completed',$6,$7)`,
    [ORG, LG, DECISION, EXPECTED_MAIN, HEAD, MAIN, `land-group-${LG}`],
  );
  for (const [key, run, spec, pr] of [
    ["mk-a", "run-a", "spec-a", "1"],
    ["mk-b", RUN, SPEC, "2"],
  ] as const) {
    await owner.query(
      `INSERT INTO land_group_members (org_id, land_group_id, member_key, pr_number, run_id, spec_id, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,'landed')`,
      [ORG, LG, key, pr, run, spec],
    );
  }
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1,$2,0,'application/octet-stream','inline_pg',$3) ON CONFLICT (org_id, digest) DO NOTHING`,
    [ORG, ARTIFACT_DIGEST, Buffer.from([0])],
  );
  await owner.query(
    `INSERT INTO authority_effect_intents
       (org_id, project_id, id, decision_id, integration_node_id, into_main, authorized_sha, expected_main_sha, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,'main',$6,$7,$3)`,
    [ORG, PROJECT, `land-group-${LG}`, DECISION, NODE, HEAD, EXPECTED_MAIN],
  );
  await owner.query(
    `INSERT INTO authority_land_receipts (org_id, project_id, id, effect_intent_id, main_sha, audit_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [ORG, PROJECT, `receipt-land-group-${LG}`, `land-group-${LG}`, MAIN, "audit_mqreal"],
  );
  await owner.query(
    `INSERT INTO release_instances
       (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref, artifact_digest,
        integration_node_id, state)
     VALUES ($1,$2,$3,'deploy.flyio','app1','production',$4,$5,$6,$7,'live')`,
    [ORG, `rel-dep1`, PROJECT, "dep1", MAIN, ARTIFACT_DIGEST, NODE],
  );
  await insertEvents(owner, [
    [
      "merge.land_group.completed",
      {
        projectId: PROJECT,
        landGroupId: LG,
        decisionId: DECISION,
        expectedMainSha: EXPECTED_MAIN,
        authorizedSha: HEAD,
        mainSha: MAIN,
        memberKeys: ["mk-a", "mk-b"],
      },
    ],
    [
      "merge.group.formed",
      {
        projectId: PROJECT,
        groupId: LG,
        partitionId: "p",
        baseSha: EXPECTED_MAIN,
        memberKeys: ["mk-a", "mk-b"],
        policyHash: PROOF_ROOT,
      },
    ],
    [
      "integration.proof_root.composed",
      { projectId: PROJECT, integrationNodeId: NODE, proofRoot: PROOF_ROOT, proofUnitIds: ["u1"] },
    ],
    [
      "deploy.verified",
      { provider: "fly", appId: "app1", deploymentId: "dep1", url: "https://x", state: "live", smokeStatus: 200 },
    ],
    ["demo.completed", { surfaceKind: "web_url", behaviorCount: 3, passed: 3, failed: 0 }],
  ]);
}

const ADMIN: ActorContext = {
  userId: "admin",
  orgId: ORG,
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

function routeApp(pool: Pool, proofSubstrate: PgProofSubstrate): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", ADMIN);
    await next();
  });
  app.route("/orgs", createMergeTrainArtifactRoutes({ pool, proofSubstrate }));
  return app;
}

describeDb("SP-3 × mq-15 — the PRODUCTION substrate seals + re-verifies a delivery (LIVE wiring)", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
    setSystemPool(owner);
    await seed(owner);
  }, 60_000);

  afterAll(async () => {
    resetSystemPool();
    await app?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  });

  it("the sole production PgProofSubstrate seals ONE artifact and the export route re-verifies it (200)", async () => {
    // The EXACT production assembly the worker now wires: one shared CAS byte store, the real
    // ed25519 substrate over it, injected into mq-15's watcher (seal path LIVE, not dormant).
    const casByteStore = new PgCasByteStore(app);
    const secrets = secretsWithKey();
    const proofSubstrate = new PgProofSubstrate(app, secrets, { casByteStore });
    const watcher = new MergeTrainArtifactWatcher({ pool: app, proofSubstrate, casByteStore });

    await watcher.check(RUN);

    const sealed = await runWithOrgScope(app, ORG, async (client) => {
      const r = await client.query<{ n: string; key: string }>(
        `SELECT count(*)::text AS n, max(signing_key_id) AS key
         FROM proof_bundles WHERE org_id = $1`,
        [ORG],
      );
      return r.rows[0]!;
    });
    // A REAL bundle sealed under the production ed25519 key family (never the test HMAC).
    expect(Number(sealed.n)).toBe(1);
    expect(sealed.key).toMatch(/^ed25519:[0-9a-f]{64}$/u);
    const rowCount = await runWithOrgScope(app, ORG, async (client) => {
      const r = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM merge_train_artifacts WHERE org_id = $1 AND land_group_id = $2",
        [ORG, LG],
      );
      return Number(r.rows[0]!.n);
    });
    expect(rowCount).toBe(1);

    // The export route, injected with the SAME production substrate class, re-verifies the
    // real ed25519 signature cryptographically and serves the delivery.
    const owned = routeApp(app, new PgProofSubstrate(app, secrets));
    const list = await owned.request(`/orgs/${ORG}/projects/${PROJECT}/merge-queue/train`);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { artifacts: unknown[] }).artifacts).toHaveLength(1);
    const artifact = await owned.request(`/orgs/${ORG}/projects/${PROJECT}/merge-queue/land-groups/${LG}/artifact`);
    expect(artifact.status).toBe(200);
  });

  it("FAIL-CLOSED: with NO platform signing key the watcher's seal throws LOUD (never a silent dormant no-op)", async () => {
    // Same production substrate class, but the platform key is UNprovisioned. The doctrine
    // forbids a silent skip — sealing must fail loud with the typed key-unavailable error.
    const casByteStore = new PgCasByteStore(app);
    const keyless = new PgProofSubstrate(app, new InMemorySecretStore(), { casByteStore });
    const watcher = new MergeTrainArtifactWatcher({ pool: app, proofSubstrate: keyless, casByteStore });
    // RUN carries the full completed-land-group evidence, so gather succeeds and the flow
    // REACHES the seal — where the absent key must throw (not skip). constructBundle/seal
    // runs before any idempotent insert, so a prior sealed row does not mask the failure.
    await expect(watcher.check(RUN)).rejects.toBeInstanceOf(ProofSigningKeyUnavailableError);
  });
});
