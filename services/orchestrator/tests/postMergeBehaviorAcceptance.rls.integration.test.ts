// cspell:ignore verenv
// rv-16a END-TO-END proof (real Postgres + real HTTP) that the LIVE resolution-walker
// post-merge path PERSISTS a real PRODUCTION behavior verdict. The walker drives a production
// stage that re-proves the symptom (a stub here — the symptom stage is bh-10's concern), then
// the rv-16a verifier runs the run's DECLARED behaviors' rv-11 acceptance (the DEFAULT real
// HttpAcceptanceSurfaceDriver + real PgReleaseInstanceBaseUrlResolver + real
// PgAcceptancePlanLoader over the live `release_instances.url`) and PERSISTS a real
// `behavior_verdict` (purpose post_merge_production) into the 0079-hardened ledger, bound to the
// deploy-created `verification_environments` row (rv-env), all as the restricted tanren_app role.
//
// It proves the decisive anti-cosplay guarantees:
//   1. The production acceptance run PERSISTS a real verdict FK'd to the deploy-created env
//      (the REAL env id, never the integration node id). A 200-but-broken behavior persists
//      `failed_product`, not `passed`.
//   2. A behavior with a PRIOR `passed` verdict whose post-merge production verdict is
//      `failed_product` yields a detectable `passed`→`failed` pair in the ledger (rv-16c's signal).
//   3. rv-19's promote is untouched (the release stays live, `deployment.promoted` recorded), and
//      cross-org reads see ZERO rows (RLS).
// Gated on TANREN_RLS_DB_TEST; runs in the `smoke-rls-post-merge-behavior-verdict` recipe.
import { migrate, runWithOrgScope } from "@tanren/db";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPostMergeBehaviorAcceptanceVerifier } from "../src/engine/verification/postMergeReproof/behaviorAcceptanceVerdict.js";
import { PostMergeReproofCoordinator } from "../src/engine/verification/postMergeReproof/coordinator.js";
import { ResolutionDagWalker } from "../src/engine/dag/resolutionDagWalker.js";
import { ResolutionJobStore } from "../src/engine/repositories/resolutionJobs.js";
import type { ResolutionAuthority } from "../src/engine/contracts/resolutionAuthority.js";
import type {
  ProductionResolutionStageResult,
  ResolutionStage,
  ResolutionStageKind,
} from "../src/engine/contracts/resolutionStage.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG = "org_pm_behavior_rv16a";
const OTHER_ORG = "org_pm_behavior_rv16a_other";
const PROJECT = "project_pm_behavior_rv16a";
const NODE_ID = "inode_pm_behavior_rv16a";
const PERSONA_REVISION = "pr_pm_behavior_rv16a";
const PASS_BR = "br_pm_pass_rv16a";
const FAIL_BR = "br_pm_fail_rv16a";
const RELEASE_ID = "ri_pm_behavior_rv16a";
const LOOP_ID = "loop_pm_behavior_rv16a";
const CONTRACT_ID = "contract_pm_behavior_rv16a";
const JOB_ID = "rjob_pm_behavior_rv16a";
const CAS = `sha256:${"a".repeat(64)}`;
const CTX = `sha256:${"d".repeat(64)}`;
const GIT_SHA = "a".repeat(40);

const PASS_ACCEPTANCE = {
  version: "v1",
  httpProbes: [{ probeId: "p1", method: "GET", path: "/health" }],
  assertions: [
    { assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 },
    { assertionId: "a2", subject: "p1.body.count", comparisonOperator: "greater_than", expected: 1 },
  ],
};
// 200-but-broken: /health is reachable (200) with a REAL count of 3, so expecting 999 must FAIL
// on the observed value — failed_product, never a reachability pass.
const FAIL_ACCEPTANCE = {
  version: "v1",
  httpProbes: [{ probeId: "p1", method: "GET", path: "/health" }],
  assertions: [{ assertionId: "a1", subject: "p1.body.count", comparisonOperator: "equals", expected: 999 }],
};

// The stub production stage: the walker's symptom re-proof is bh-10's concern; rv-16a's verifier
// runs ALONGSIDE it. A `product_resolved` keeps the release live so rv-19 promotes it.
const PRODUCT_RESOLVED: ProductionResolutionStageResult = {
  proofGrade: "active_causal",
  verificationRunId: "vrun_pm_resolved",
  assertionIds: ["a1"],
  evidenceRefs: ["e1"],
  outcome: "passed",
  classification: "product_resolved",
};

const authorizedAuthority = (): ResolutionAuthority => ({
  authorize: () =>
    Promise.resolve({
      id: "rdec_pm_ok",
      decision: "authorized",
      inputSnapshotHash: `sha256:${"a".repeat(64)}`,
      reasons: [],
      created: true,
    }),
  waive: () => Promise.reject(new Error("walker cannot waive")),
});

function databaseName(): string {
  return `tanren_pm_behavior_rv16a_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    `INSERT INTO integration_nodes (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, member_key)
     VALUES ($1, $2, $3, 'main', $4, 'refs/heads/main', 'merge_batch', 'member-rv16a')`,
    [NODE_ID, PROJECT, ORG, CAS],
  );
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, 0, 'application/octet-stream', 'inline_pg', $3)`,
    [ORG, CAS, Buffer.from([0])],
  );
  await owner.query(
    `INSERT INTO persona_revisions (id, org_id, project_id, persona_id, scope, revision_number, name, description, content_digest)
     VALUES ($1, $2, $3, 'persona', 'project', 1, 'persona', 'persona', $4)`,
    [PERSONA_REVISION, ORG, PROJECT, CAS],
  );
  for (const [id, acceptance, num] of [
    [PASS_BR, PASS_ACCEPTANCE, 1],
    [FAIL_BR, FAIL_ACCEPTANCE, 2],
  ] as const) {
    await owner.query(
      `INSERT INTO behavior_revisions (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then", content_digest, acceptance)
       VALUES ($1, $2, $3, $4, $5, $6, 'behavior', 'g', 'w', 't', $7, $8::jsonb)`,
      [id, ORG, PROJECT, id, PERSONA_REVISION, num, CAS, JSON.stringify(acceptance)],
    );
  }
  // The merged fix's live production release, pointing at the live test server, delivering BOTH
  // declared behaviors. source_ref is the deployed commit sha (the frozen event's deploySha).
  await owner.query(
    `INSERT INTO release_instances (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref, artifact_digest, integration_node_id, url, state)
     VALUES ($1, $2, $3, 'fly', 'app_pm', 'production', 'dep_pm', $4, $5, $6, $7, 'live')`,
    [ORG, RELEASE_ID, PROJECT, GIT_SHA, CAS, NODE_ID, serverUrl],
  );
  for (const [ordinal, br] of [PASS_BR, FAIL_BR].entries()) {
    await owner.query(
      `INSERT INTO release_instance_behavior_revisions (org_id, release_instance_id, behavior_revision_id, ordinal)
       VALUES ($1, $2, $3, $4)`,
      [ORG, RELEASE_ID, br, ordinal],
    );
  }
  // The issue loop + symptom contract the resolution job binds (the stub stage ignores the body).
  await owner.query(
    `INSERT INTO inbox_sources (id, org_id, project_id, kind, name)
     VALUES ($1, $2, $3, 'issues', 'pm-src') ON CONFLICT DO NOTHING`,
    [`src_${LOOP_ID}`, ORG, PROJECT],
  );
  await owner.query(
    `INSERT INTO issue_loops
       (org_id, id, project_id, source_id, external_key, generation, fingerprint, severity, state,
        resolution_policy, row_version, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, 'high', 'verifying', 'active_causal', 1, now())`,
    [ORG, LOOP_ID, PROJECT, `src_${LOOP_ID}`, `ext_${LOOP_ID}`, `fp_${LOOP_ID}`],
  );
  await owner.query(
    `INSERT INTO symptom_contracts
       (org_id, project_id, id, issue_loop_id, schema_version, contract_json, canonical_hash,
        proof_policy, target, source_revision, state)
     VALUES ($1, $2, $3, $4, 1, '{}'::jsonb, $5, 'active_causal', '{}'::jsonb, 'rev-1', 'validated')`,
    [ORG, PROJECT, CONTRACT_ID, LOOP_ID, `sha256:${"e".repeat(64)}`],
  );
}

// Seed a PRIOR pre-merge PASSED verdict for the FAIL_BR behavior (its own env + run), so the
// post-merge production failed_product verdict forms the detectable passed→failed pair rv-16c bisects.
async function seedPriorPassedVerdict(owner: Pool): Promise<void> {
  await owner.query(
    `INSERT INTO verification_environments
       (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target,
        environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, 'verenv_pm_prior', $2, $3, $4, 'production', 'prior-fp', 'prior-lease', 'ready')`,
    [ORG, PROJECT, NODE_ID, CAS],
  );
  await owner.query(
    `INSERT INTO behavior_verification_runs
       (org_id, id, project_id, purpose, environment_id, prepared_head_sha, jj_tree_id,
        plan_set_hash, runtime_behavior_context_hash, artifact_digest, status, policy)
     VALUES ($1, 'vrun_pm_prior', $2, 'pre_merge', 'verenv_pm_prior', $3, $3, $4, $5, $6, 'completed', '{}'::jsonb)`,
    [ORG, PROJECT, CTX, CAS, CTX, CAS],
  );
  await owner.query(
    `WITH verdict AS (
       INSERT INTO behavior_verdicts
         (org_id, id, project_id, run_id, behavior_revision_id, example_hash, matrix_hash,
          required_assertion_count, executed_assertion_count, outcome, attempt_count,
          flake_state, gate_effect, artifact_digest, runtime_behavior_context_hash)
       VALUES ($1, 'verdict_pm_prior', $2, 'vrun_pm_prior', $3, 'ex', 'mx', 1, 1, 'passed', 1,
               'stable', 'blocking', $4, $5)
       RETURNING org_id, id
     ), attempt AS (
       INSERT INTO behavior_verdict_attempts (org_id, verdict_id, attempt_ordinal, outcome)
       SELECT org_id, id, 1, 'passed' FROM verdict
     )
     INSERT INTO behavior_verdict_assertions (org_id, verdict_id, assertion_id, executed, passed)
     SELECT org_id, id, 'assertion_seed', true, true FROM verdict`,
    [ORG, PROJECT, FAIL_BR, CAS, CTX],
  );
}

describeDb("rv-16a persisted post-merge production behavior verdict — real Postgres + HTTP, walker-driven", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let server: Server;

  const buildWalker = (store: ResolutionJobStore) =>
    new ResolutionDagWalker({
      store,
      orgIds: () => Promise.resolve([ORG]),
      stages: new Map<ResolutionStageKind, ResolutionStage>([
        ["production", { kind: "production", run: () => Promise.resolve(PRODUCT_RESOLVED) }],
      ]),
      authority: authorizedAuthority(),
      reproofCoordinator: new PostMergeReproofCoordinator({ pool: app }),
      behaviorVerifier: buildPostMergeBehaviorAcceptanceVerifier(app),
      leaseOwner: "walker_pm_rv16a",
    });

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", count: 3 }));
        return;
      }
      res.writeHead(404);
      res.end();
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
    await seedPriorPassedVerdict(owner);
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

  it("runs the decisive writes as the non-superuser tanren_app role", async () => {
    const identity = await app.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles AS r WHERE r.rolname = current_user",
    );
    expect(identity.rows[0]).toEqual({ current_user: "tanren_app", rolsuper: false, rolbypassrls: false });
  });

  it("DECISIVE: the walker post-merge path PERSISTS a real production behavior verdict FK'd to the deploy-created env + a passed→failed signal", async () => {
    const store = new ResolutionJobStore(app);
    await store.enqueue({
      orgId: ORG,
      projectId: PROJECT,
      id: JOB_ID,
      issueLoopId: LOOP_ID,
      contractId: CONTRACT_ID,
      releaseInstanceId: RELEASE_ID,
      stage: "production",
      idempotencyKey: "idem_pm_rv16a",
    });

    // Drive the LIVE walker: symptom re-proof (stub product_resolved) → rv-16a acceptance verdict
    // → rv-19 promote → settle. Nothing is hand-called; the wiring is the production path.
    await buildWalker(store).tick();

    // rv-env: the verifier find-or-created the ready production env for THIS live release, bound
    // to the real release id — NOT the prior seeded env, NOT the integration node id.
    const env = await runWithOrgScope(app, ORG, async (client) => {
      const rows = await client.query<{ id: string; tenant_lease_id: string }>(
        `SELECT id, tenant_lease_id FROM verification_environments
          WHERE org_id = $1 AND project_id = $2 AND integration_node_id = $3
            AND artifact_digest = $4 AND deployment_target = 'production'
            AND lifecycle_status = 'ready' AND tenant_lease_id = $5`,
        [ORG, PROJECT, NODE_ID, CAS, RELEASE_ID],
      );
      return rows.rows[0];
    });
    expect(env).toBeDefined();
    expect(env!.id).not.toBe(NODE_ID);

    // Both behaviors PERSISTED a real production verdict (purpose post_merge_production) into the
    // 0079-hardened ledger, each FK'd to the deploy-created env — never the integration node id.
    const verdicts = await runWithOrgScope(app, ORG, async (client) => {
      const rows = await client.query<{
        behavior_revision_id: string;
        outcome: string;
        req: number;
        exe: number;
        environment_id: string;
        purpose: string;
      }>(
        `SELECT v.behavior_revision_id, v.outcome, v.required_assertion_count AS req,
                v.executed_assertion_count AS exe, r.environment_id, r.purpose
           FROM behavior_verdicts v
           JOIN behavior_verification_runs r ON r.org_id = v.org_id AND r.id = v.run_id
          WHERE v.org_id = $1 AND r.purpose = 'post_merge_production'`,
        [ORG],
      );
      return rows.rows;
    });
    expect(verdicts).toHaveLength(2);
    for (const row of verdicts) expect(row.environment_id).toBe(env!.id);
    const passed = verdicts.find((row) => row.behavior_revision_id === PASS_BR);
    expect(passed!.outcome).toBe("passed");
    // The rv-11/0079 coverage invariant holds on the LIVE persisted production path.
    expect(passed!.exe).toBeGreaterThanOrEqual(passed!.req);
    expect(passed!.req).toBeGreaterThanOrEqual(1);
    const failed = verdicts.find((row) => row.behavior_revision_id === FAIL_BR);
    // 200-but-broken persists failed_product, NOT passed.
    expect(failed!.outcome).toBe("failed_product");

    // The frozen post_merge.behavior.* events were emitted for each persisted verdict.
    const events = await runWithOrgScope(app, ORG, async (client) => {
      const rows = await client.query<{ event_type: string; payload: Record<string, unknown> }>(
        `SELECT event_type, payload FROM events
          WHERE org_id = $1 AND event_type LIKE 'post_merge.behavior.%' ORDER BY event_type`,
        [ORG],
      );
      return rows.rows;
    });
    const verified = events.find((e) => e.event_type === "post_merge.behavior.verified");
    const failedEvent = events.find((e) => e.event_type === "post_merge.behavior.failed");
    expect(verified!.payload).toMatchObject({ behaviorRevisionId: PASS_BR, deploySha: GIT_SHA, artifactDigest: CAS });
    expect(failedEvent!.payload).toMatchObject({ behaviorRevisionId: FAIL_BR, outcome: "failed_product" });

    // rv-16c's regression signal: the SAME behavior (FAIL_BR) has a prior passed verdict AND a
    // post-merge production failed_product verdict — a detectable passed→failed pair in the ledger.
    const pair = await runWithOrgScope(app, ORG, async (client) => {
      const rows = await client.query<{ passed_before: string; failed_after: string }>(
        `SELECT p.id AS passed_before, f.id AS failed_after
           FROM behavior_verdicts p
           JOIN behavior_verification_runs pr ON pr.org_id = p.org_id AND pr.id = p.run_id
           JOIN behavior_verdicts f ON f.org_id = p.org_id AND f.behavior_revision_id = p.behavior_revision_id
           JOIN behavior_verification_runs fr ON fr.org_id = f.org_id AND fr.id = f.run_id
          WHERE p.org_id = $1 AND p.behavior_revision_id = $2
            AND p.outcome = 'passed' AND f.outcome = 'failed_product'
            AND fr.purpose = 'post_merge_production' AND f.created_at >= p.created_at`,
        [ORG, FAIL_BR],
      );
      return rows.rows[0];
    });
    expect(pair).toBeDefined();

    // rv-19 promote is untouched: the release stays live + deployment.promoted recorded.
    const release = await runWithOrgScope(app, ORG, async (client) => {
      const rows = await client.query<{ state: string }>(
        "SELECT state FROM release_instances WHERE org_id = $1 AND id = $2",
        [ORG, RELEASE_ID],
      );
      return rows.rows[0];
    });
    expect(release!.state).toBe("live");
    const promoted = await runWithOrgScope(app, ORG, async (client) => {
      const rows = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM events
          WHERE org_id = $1 AND event_type = 'deployment.promoted' AND payload ->> 'deploymentId' = 'dep_pm'`,
        [ORG],
      );
      return Number(rows.rows[0]?.n ?? "0");
    });
    expect(promoted).toBe(1);
  });

  it("org isolation: another org sees ZERO of this org's persisted production verdicts (RLS denies cross-org reads)", async () => {
    const foreign = await runWithOrgScope(app, OTHER_ORG, async (client) => {
      const rows = await client.query<{ n: string }>("SELECT count(*) AS n FROM behavior_verdicts", []);
      return Number(rows.rows[0]?.n ?? "0");
    });
    expect(foreign).toBe(0);
  });
});
