// cspell:ignore verenv reeval
// mq-7 REAL-SEAM proof (real Postgres + real HTTP, restricted tanren_app role) that the LIVE
// post-merge production behavior-verdict lane RE-EVALUATES a stale flake quarantine across code
// GENERATIONS and RELEASES it when the new generation reveals a real regression — so a quarantine
// can NEVER silently persist and hide a genuine bug. Nothing is hand-called: the exact production
// verifier the resolution walker + operator-retry route drive —
// `buildPostMergeBehaviorAcceptanceVerifier(app).verify(...)` — records a `failed_product`
// production verdict for the NEW artifact and, because the behavior was quarantined in an OLDER
// epoch yet now deterministically FAILS, records a `release` transition (classification
// 'consistent_failure', gate_effect 'restored') that lifts the quarantine.
//
// This is the gravest-failure guard: had the actuator kept the stale quarantine, the regression
// would have been excluded from the gate and hidden. Instead the behavior is un-quarantined and
// the deterministic failure reaches the gate/bisection.
import { migrate, runWithOrgScope } from "@tanren/db";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPostMergeBehaviorAcceptanceVerifier } from "../src/engine/verification/postMergeReproof/behaviorAcceptanceVerdict.js";
import { PgBehaviorQuarantineStore } from "../src/engine/repositories/behaviorQuarantines.js";
import { FLAKE_CLASSIFIER_ACTOR } from "../src/engine/verification/acceptance/flakeQuarantineActuator.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG = "org_reeval_rls";
const OTHER_ORG = "org_reeval_rls_other";
const PROJECT = "project_reeval_rls";
const PERSONA = "pr_reeval_rls";
const BR = "br_reeval";
const NODE_ID = "inode_reeval_live";
const RELEASE_ID = "ri_reeval_live";
// The NEW code generation (the artifact the release is verified at) = the observed epoch.
const NEW_EPOCH = `sha256:${"a".repeat(64)}`;
// The OLDER generation the stale quarantine was proven in.
const OLD_EPOCH = `sha256:${"b".repeat(64)}`;
const CTX = `sha256:${"c".repeat(64)}`;
const GIT_SHA = "a".repeat(40);

// Asserts /health status equals 200. The test server returns 500, so the NEW-epoch production
// verdict is `failed_product` — a deterministic (consistent) failure in the new generation.
const ACCEPTANCE = {
  version: "v1",
  httpProbes: [{ probeId: "p1", method: "GET", path: "/health" }],
  assertions: [{ assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 }],
};

function databaseName(): string {
  return `tanren_reeval_rls_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

async function seedTenant(owner: Pool, serverUrl: string): Promise<void> {
  for (const org of [ORG, OTHER_ORG]) {
    await owner.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [org],
    );
  }
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, 0, 'application/octet-stream', 'inline_pg', $3)`,
    [ORG, NEW_EPOCH, Buffer.from([0])],
  );
  await owner.query(
    `INSERT INTO persona_revisions (id, org_id, project_id, persona_id, scope, revision_number, name, description, content_digest)
     VALUES ($1, $2, $3, 'persona', 'project', 1, 'persona', 'persona', $4)`,
    [PERSONA, ORG, PROJECT, NEW_EPOCH],
  );
  await owner.query(
    `INSERT INTO behavior_revisions (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then", content_digest, acceptance)
     VALUES ($1, $2, $3, $1, $4, 1, 'behavior', 'g', 'w', 't', $5, $6::jsonb)`,
    [BR, ORG, PROJECT, PERSONA, NEW_EPOCH, JSON.stringify(ACCEPTANCE)],
  );
  await owner.query(
    `INSERT INTO integration_nodes (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, member_key)
     VALUES ($1, $2, $3, 'main', $4, 'refs/heads/main', 'merge_batch', $5)`,
    [NODE_ID, PROJECT, ORG, NEW_EPOCH, `member-${NODE_ID}`],
  );
  await owner.query(
    `INSERT INTO release_instances (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref, artifact_digest, integration_node_id, url, state)
     VALUES ($1, $2, $3, 'fly', 'app_reeval', 'production', 'dep_reeval', $4, $5, $6, $7, 'live')`,
    [ORG, RELEASE_ID, PROJECT, GIT_SHA, NEW_EPOCH, NODE_ID, serverUrl],
  );
  await owner.query(
    `INSERT INTO release_instance_behavior_revisions (org_id, release_instance_id, behavior_revision_id, ordinal)
     VALUES ($1, $2, $3, 0)`,
    [ORG, RELEASE_ID, BR],
  );
}

describeDb("mq-7 LIVE epoch re-evaluation — verify() RELEASES a stale quarantine on a new-epoch regression", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let server: Server;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      // Always 500: the behavior deterministically FAILS in the new generation.
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "down" }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
    await seedTenant(owner, serverUrl);

    // Pre-seed a STALE quarantine proven in the OLDER generation (OLD_EPOCH) via the real store.
    await new PgBehaviorQuarantineStore(app).recordTransition({
      orgId: ORG,
      projectId: PROJECT,
      behaviorRevisionId: BR,
      transition: "quarantine",
      classification: "flaky",
      reason: "seeded flake in an older generation",
      actor: FLAKE_CLASSIFIER_ACTOR,
      evidence: [
        { verdictId: "seed_pass", outcome: "passed" },
        { verdictId: "seed_fail", outcome: "failed_product" },
      ],
      contextHash: CTX,
      epoch: OLD_EPOCH,
    });
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
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

  it("the behavior starts quarantined (stale, from the older generation)", async () => {
    const active = await new PgBehaviorQuarantineStore(app).readActiveQuarantinedBehaviors({
      orgId: ORG,
      projectId: PROJECT,
    });
    expect(active.has(BR)).toBe(true);
  });

  it("DECISIVE: verify() records a FAILED new-epoch verdict then RELEASES the stale quarantine (regression unmasked)", async () => {
    const result = await buildPostMergeBehaviorAcceptanceVerifier(app).verify({
      orgId: ORG,
      projectId: PROJECT,
      releaseInstanceId: RELEASE_ID,
    });
    expect(result.decision).toBe("recorded");
    // The new-generation production verdict is a real product failure (500 ≠ 200), not a pass.
    expect(result.failed).toBe(1);
    expect(result.passed).toBe(0);

    // The LIVE lane recorded a `release` transition for the new epoch — the quarantine did NOT persist.
    const release = await runWithOrgScope(app, ORG, async (client) => {
      const rows = await client.query<{
        transition: string;
        gate_effect: string;
        classification: string;
        epoch: string;
      }>(
        `SELECT transition, gate_effect, classification, epoch
           FROM behavior_flake_quarantines
          WHERE org_id = $1 AND behavior_revision_id = $2
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [ORG, BR],
      );
      return rows.rows[0];
    });
    expect(release).toBeDefined();
    expect(release!.transition).toBe("release");
    expect(release!.gate_effect).toBe("restored");
    expect(release!.classification).toBe("consistent_failure");
    expect(release!.epoch).toBe(NEW_EPOCH);

    // The behavior is NO LONGER quarantined — the deterministic regression now reaches the gate/bisection.
    const active = await new PgBehaviorQuarantineStore(app).readActiveQuarantinedBehaviors({
      orgId: ORG,
      projectId: PROJECT,
    });
    expect(active.has(BR)).toBe(false);
  });

  it("org isolation: another org sees ZERO of this org's quarantine transitions (RLS deny-by-default)", async () => {
    const foreign = await runWithOrgScope(app, OTHER_ORG, async (client) => {
      const rows = await client.query<{ n: string }>("SELECT count(*) AS n FROM behavior_flake_quarantines", []);
      return Number(rows.rows[0]?.n ?? "0");
    });
    expect(foreign).toBe(0);
  });
});
