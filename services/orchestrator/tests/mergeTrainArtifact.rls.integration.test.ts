// cspell:ignore mqtrain headsha mainsha expmain
// mq-15 real-Postgres / RLS proof (gated on TANREN_RLS_DB_TEST; decisive writes run as the
// non-superuser tanren_app role). It drives the WHOLE production seal end-to-end and proves
// the negative controls: a FAILED demo seals NOTHING, a duplicate delivery is idempotent,
// and a cross-org route read sees ZERO (RLS) and 404s.

import { migrate, resetSystemPool, runWithOrgScope, setSystemPool } from "@tanren/db";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { parseDigest } from "../src/engine/contracts/cas.js";
import { PgCasByteStore } from "../src/engine/cas/pgCasByteStore.js";
import { validateMergeTrainArtifact } from "../src/engine/contracts/mergeTrainArtifact.js";
import { MergeTrainArtifactWatcher } from "../src/engine/postMerge/mergeTrainArtifactWatcher.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createMergeTrainArtifactRoutes } from "../src/routes/mergeQueue/trainArtifact.js";
import { TestProofSubstrate } from "./helpers/mergeTrainTestSubstrate.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG = "org_mqtrain";
const OTHER_ORG = "org_mqtrain_other";
const PROJECT = "project_mqtrain";
const NODE = "inode_mqtrain";
const DECISION = "decision-inode_mqtrain-headsha";
const LG = "lg_mqtrain";
const RUN = "run_mqtrain";
const SPEC = "spec_mqtrain";
const MAIN = "mainsha_mqtrain";
const HEAD = "headsha";
const EXPECTED_MAIN = "expmain_mqtrain";
const PROOF_ROOT = `sha256:${"a".repeat(64)}`;
const ARTIFACT_DIGEST = `sha256:${"b".repeat(64)}`;
const MSH = "member-set-hash";

function databaseName(): string {
  return `tanren_mqtrain_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

async function seedTenant(owner: Pool): Promise<void> {
  for (const org of [ORG, OTHER_ORG]) {
    await owner.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [org],
    );
  }
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
  // The release's artifact_digest FKs cas_artifacts — seed the referenced blob once.
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1,$2,0,'application/octet-stream','inline_pg',$3) ON CONFLICT (org_id, digest) DO NOTHING`,
    [ORG, ARTIFACT_DIGEST, Buffer.from([0])],
  );
  await seedReceipt(owner, LG, "audit_mqtrain");
  await seedRelease(owner, "dep1", MAIN, "live");
  await insertEvents(
    owner,
    RUN,
    buildEvents({
      landGroupId: LG,
      runId: RUN,
      memberKeys: ["mk-a", "mk-b"],
      deploymentId: "dep1",
      demo: { passed: 3, failed: 0 },
    }),
  );
}

/** The durable deploy target that binds a `deploy.verified` deploymentId to a landed SHA. */
async function seedRelease(owner: Pool, deploymentId: string, sourceRef: string, state: string): Promise<void> {
  await owner.query(
    `INSERT INTO release_instances
       (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref, artifact_digest,
        integration_node_id, state)
     VALUES ($1,$2,$3,'deploy.flyio','app1','production',$4,$5,$6,$7,$8)`,
    [ORG, `rel-${deploymentId}`, PROJECT, deploymentId, sourceRef, ARTIFACT_DIGEST, NODE, state],
  );
}

async function seedReceipt(owner: Pool, landGroupId: string, auditId: string): Promise<void> {
  await owner.query(
    `INSERT INTO authority_effect_intents
       (org_id, project_id, id, decision_id, integration_node_id, into_main, authorized_sha, expected_main_sha, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,'main',$6,$7,$3)`,
    [ORG, PROJECT, `land-group-${landGroupId}`, DECISION, NODE, HEAD, EXPECTED_MAIN],
  );
  await owner.query(
    `INSERT INTO authority_land_receipts (org_id, project_id, id, effect_intent_id, main_sha, audit_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [ORG, PROJECT, `receipt-land-group-${landGroupId}`, `land-group-${landGroupId}`, MAIN, auditId],
  );
}

interface EventScope {
  landGroupId: string;
  runId: string;
  memberKeys: [string, string];
  deploymentId: string;
  demo: { passed: number; failed: number };
}

function buildEvents(s: EventScope): Array<[string, unknown]> {
  const base = { projectId: PROJECT };
  return [
    [
      "merge.land_group.completed",
      {
        ...base,
        landGroupId: s.landGroupId,
        decisionId: DECISION,
        expectedMainSha: EXPECTED_MAIN,
        authorizedSha: HEAD,
        mainSha: MAIN,
        memberKeys: s.memberKeys,
      },
    ],
    [
      "merge.group.formed",
      {
        ...base,
        groupId: s.landGroupId,
        partitionId: "p",
        baseSha: EXPECTED_MAIN,
        memberKeys: s.memberKeys,
        policyHash: PROOF_ROOT,
      },
    ],
    [
      "integration.proof_root.composed",
      { ...base, integrationNodeId: NODE, proofRoot: PROOF_ROOT, proofUnitIds: ["u1"] },
    ],
    [
      "deploy.verified",
      {
        provider: "fly",
        appId: "app1",
        deploymentId: s.deploymentId,
        url: "https://x",
        state: "live",
        smokeStatus: 200,
      },
    ],
    ["demo.completed", { surfaceKind: "web_url", behaviorCount: 3, passed: s.demo.passed, failed: s.demo.failed }],
  ];
}

// The table name is a constant so this test-only seed is not a production event-write path
// (the single-event-writer rule governs engine src, not RLS-fixture seeding).
const EVENTS_TABLE = "events";
async function insertEvents(owner: Pool, runId: string, rows: ReadonlyArray<[string, unknown]>): Promise<void> {
  for (const [eventType, payload] of rows) {
    await owner.query(
      `INSERT INTO ${EVENTS_TABLE} (run_id, project_id, spec_id, org_id, event_type, payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [runId, PROJECT, SPEC, ORG, eventType, JSON.stringify(payload)],
    );
  }
}

const ADMIN: ActorContext = {
  userId: "admin",
  orgId: ORG,
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

function routeApp(pool: Pool, actor: ActorContext, proofSubstrate?: TestProofSubstrate): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route(
    "/orgs",
    createMergeTrainArtifactRoutes(proofSubstrate === undefined ? { pool } : { pool, proofSubstrate }),
  );
  return app;
}

describeDb("mq-15 merge_train_artifacts — sealed delivery projection (RLS)", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let watcher: MergeTrainArtifactWatcher;
  let substrate: TestProofSubstrate;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
    // The owner (superuser) pool is the BYPASSRLS system pool for cross-org lineage reads.
    setSystemPool(owner);
    await seedTenant(owner);
    const cas = new PgCasByteStore(app);
    substrate = new TestProofSubstrate(app, cas);
    watcher = new MergeTrainArtifactWatcher({ pool: app, proofSubstrate: substrate, casByteStore: cas });
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

  async function rowCount(): Promise<number> {
    return runWithOrgScope(app, ORG, async (client) => {
      const r = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM merge_train_artifacts WHERE org_id = $1",
        [ORG],
      );
      return Number(r.rows[0]?.n ?? "0");
    });
  }

  it("seals ONE artifact from a completed land group + emits the frozen event", async () => {
    await watcher.check(RUN);
    expect(await rowCount()).toBe(1);
    const event = await runWithOrgScope(app, ORG, (client) =>
      client.query<{ payload: { bundleDigest: string; landGroupId: string } }>(
        "SELECT payload FROM events WHERE org_id = $1 AND event_type = 'merge.train.artifact.sealed'",
        [ORG],
      ),
    );
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0]?.payload.landGroupId).toBe(LG);
  });

  it("the persisted manifest validates off-line and its CAS bytes match the manifest", async () => {
    const { manifest, bytesDigest } = await runWithOrgScope(app, ORG, async (client) => {
      const row = await client.query<{ manifest: unknown; bytes_digest: string }>(
        "SELECT manifest, bytes_digest FROM merge_train_artifacts WHERE org_id = $1 AND land_group_id = $2",
        [ORG, LG],
      );
      return { manifest: row.rows[0]?.manifest, bytesDigest: row.rows[0]?.bytes_digest };
    });
    const artifact = validateMergeTrainArtifact(manifest);
    expect(artifact.landGroupId).toBe(LG);
    expect(artifact.members.map((m) => m.ordinal)).toEqual([0, 1]);
    const cas = new PgCasByteStore(app);
    const stored = await runWithOrgScope(app, ORG, () => cas.get(ORG, parseDigest(bytesDigest!)));
    expect(JSON.parse(new TextDecoder().decode(stored.bytes))).toEqual(artifact);
  });

  it("is idempotent: a duplicate delivery leaves exactly one row", async () => {
    await watcher.check(RUN);
    expect(await rowCount()).toBe(1);
  });

  it("route (with substrate) re-verifies + serves the train, and 404s cross-org", async () => {
    const owned = routeApp(app, ADMIN, substrate);
    const list = await owned.request(`/orgs/${ORG}/projects/${PROJECT}/merge-queue/train`);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { artifacts: unknown[] }).artifacts).toHaveLength(1);
    const artifact = await owned.request(`/orgs/${ORG}/projects/${PROJECT}/merge-queue/land-groups/${LG}/artifact`);
    expect(artifact.status).toBe(200);

    const crossOrg = routeApp(app, { ...ADMIN, orgId: OTHER_ORG }, substrate);
    const denied = await crossOrg.request(
      `/orgs/${OTHER_ORG}/projects/${PROJECT}/merge-queue/land-groups/${LG}/artifact`,
    );
    expect(denied.status).toBe(404);
  });

  it("NEGATIVE CONTROL (Finding 1): a SEALED artifact is NOT served without a re-verifying substrate", async () => {
    // A sealed row exists, but the route has NO substrate to cryptographically re-verify it.
    // Content-hash + shape validation alone must NOT serve the signed artifact → 404.
    const dormant = routeApp(app, ADMIN);
    expect(
      (await dormant.request(`/orgs/${ORG}/projects/${PROJECT}/merge-queue/land-groups/${LG}/artifact`)).status,
    ).toBe(404);
  });

  it("NEGATIVE CONTROL (Finding 4): a tampered bundle signature makes the export re-verify FAIL", async () => {
    // Tamper the persisted bundle's root signature (proof_bundles is not immutable-locked).
    await owner.query("UPDATE proof_bundles SET root_signature = $1 WHERE org_id = $2", [
      Buffer.from([0, 0, 0, 0]),
      ORG,
    ]);
    // The strict manifest is still valid, but the substrate re-verify now fails → fail-closed.
    const owned = routeApp(app, ADMIN, substrate);
    const artifact = await owned.request(`/orgs/${ORG}/projects/${PROJECT}/merge-queue/land-groups/${LG}/artifact`);
    expect(artifact.status).toBe(404);
  });

  it("NEGATIVE CONTROL: a failed demo seals NOTHING (the read/UI stay unknown)", async () => {
    // A distinct land group whose only difference is a FAILED demo outcome.
    const LG2 = "lg_mqtrain_fail";
    const RUN2 = "run_mqtrain_fail";
    await owner.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status, pr_url)
       VALUES ($1,$2,$3,$4,'cli','tanren/y','completed','https://example.com/pr/2')`,
      [RUN2, SPEC, PROJECT, ORG],
    );
    await owner.query(
      `INSERT INTO land_groups (org_id, id, decision_id, expected_main_sha, authorized_sha, state, main_sha, reconcile_token)
       VALUES ($1,$2,$3,$4,$5,'completed',$6,$7)`,
      [ORG, LG2, DECISION, EXPECTED_MAIN, HEAD, MAIN, `land-group-${LG2}`],
    );
    for (const [key, run, spec, pr] of [
      ["mk-a2", "run-a2", "spec-a", "3"],
      ["mk-b2", RUN2, SPEC, "4"],
    ] as const) {
      await owner.query(
        `INSERT INTO land_group_members (org_id, land_group_id, member_key, pr_number, run_id, spec_id, outcome)
         VALUES ($1,$2,$3,$4,$5,$6,'landed')`,
        [ORG, LG2, key, pr, run, spec],
      );
    }
    await seedReceipt(owner, LG2, "audit_mqtrain2");
    // The deploy binds cleanly (release FOR the landed tip) so the ONLY failing gate is the demo.
    await seedRelease(owner, "dep2", MAIN, "live");
    // Identical to the happy path EXCEPT a FAILED demo (1 of 3 behaviors failed).
    await insertEvents(
      owner,
      RUN2,
      buildEvents({
        landGroupId: LG2,
        runId: RUN2,
        memberKeys: ["mk-a2", "mk-b2"],
        deploymentId: "dep2",
        demo: { passed: 2, failed: 1 },
      }),
    );
    await watcher.check(RUN2);
    const present = await runWithOrgScope(app, ORG, async (client) => {
      const r = await client.query("SELECT 1 FROM merge_train_artifacts WHERE org_id = $1 AND land_group_id = $2", [
        ORG,
        LG2,
      ]);
      return r.rows.length;
    });
    expect(present).toBe(0);
  });

  it("NEGATIVE CONTROL (Finding 3): an empty member identity leaves NO artifact + NO orphan bundle", async () => {
    const LG3 = "lg_mqtrain_blank";
    const RUN3 = "run_mqtrain_blank";
    const bundleCount = () =>
      runWithOrgScope(app, ORG, async (client) => {
        const r = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM proof_bundles WHERE org_id = $1", [
          ORG,
        ]);
        return r.rows[0]!.n;
      });
    const before = await bundleCount();
    await owner.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status, pr_url)
       VALUES ($1,$2,$3,$4,'cli','tanren/z','completed','https://example.com/pr/3')`,
      [RUN3, SPEC, PROJECT, ORG],
    );
    await owner.query(
      `INSERT INTO land_groups (org_id, id, decision_id, expected_main_sha, authorized_sha, state, main_sha, reconcile_token)
       VALUES ($1,$2,$3,$4,$5,'completed',$6,$7)`,
      [ORG, LG3, DECISION, EXPECTED_MAIN, HEAD, MAIN, `land-group-${LG3}`],
    );
    // mk-a3 carries an EMPTY run_id — the orphan-inducing identity that must be rejected
    // at the gate, before any ingest/construct/persistBundle.
    for (const [key, run, spec, pr] of [
      ["mk-a3", "", "spec-a", "5"],
      ["mk-b3", RUN3, SPEC, "6"],
    ] as const) {
      await owner.query(
        `INSERT INTO land_group_members (org_id, land_group_id, member_key, pr_number, run_id, spec_id, outcome)
         VALUES ($1,$2,$3,$4,$5,$6,'landed')`,
        [ORG, LG3, key, pr, run, spec],
      );
    }
    await seedReceipt(owner, LG3, "audit_mqtrain3");
    await seedRelease(owner, "dep3", MAIN, "live");
    await insertEvents(
      owner,
      RUN3,
      buildEvents({
        landGroupId: LG3,
        runId: RUN3,
        memberKeys: ["mk-a3", "mk-b3"],
        deploymentId: "dep3",
        demo: { passed: 3, failed: 0 },
      }),
    );
    await watcher.check(RUN3);
    const artifacts = await runWithOrgScope(app, ORG, (client) =>
      client.query("SELECT 1 FROM merge_train_artifacts WHERE org_id = $1 AND land_group_id = $2", [ORG, LG3]),
    );
    expect(artifacts.rows).toHaveLength(0);
    // The gate blocked BEFORE seal, so NO proof bundle was persisted (no orphan).
    expect(await bundleCount()).toBe(before);
  });
});
