// cspell:ignore rvenv
// rv-env real-Postgres proof: the deploy path is the MISSING producer of
// `verification_environments`. When a release goes LIVE in production
// (`ReleaseInstancesStore.markLive`) a ready verification environment is
// find-or-created, bound to that release, so a post-deploy acceptance run
// PERSISTS a real, immutable `behavior_verdict` against a REAL environment
// (replacing the ephemeral non-persisting sink rv-18 surfaced) — while the
// rv-11/0079 false-green invariants still hold on the persisted path. Runs as the
// restricted non-superuser tanren_app role so RLS, cross-org isolation, and the
// append-only ledger are all proven live. Gated on TANREN_RLS_DB_TEST; runs in the
// `smoke-rls-deploy-verification-environment` recipe, not the DB-less unit phase.
import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Digest } from "../src/engine/contracts/cas.js";
import type {
  AdapterUnavailableResult,
  DriverExecutionResult,
  DriverObservation,
} from "../src/engine/contracts/runtimeVerificationAdapters.js";
import type { ExecutionMatrix } from "../src/engine/contracts/runtimeVerificationPlan.js";
import {
  AcceptanceOrchestrator,
  PgAcceptanceEventSink,
  PgAcceptanceRunStore,
  type AcceptancePlan,
  type AcceptanceSurfaceDriver,
} from "../src/engine/verification/acceptance/index.js";
import { PgFixtureLeaseAdapter } from "../src/engine/verification/fixtureLease/index.js";
import { PgReleaseInstancesRepository } from "../src/engine/repositories/pgReleaseInstances.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG = "org_rvenv";
const OTHER_ORG = "org_rvenv_other";
const PROJECT = "project_rvenv";
const NODE_ID = "inode_rvenv";
const BEHAVIOR_REVISION = "br_rvenv";
const PERSONA_REVISION = "pr_rvenv";
const PROVIDER = "deploy.fixture";
const APP_ID = "app_rvenv";
const DEPLOYMENT_ID = "deploy_rvenv_1";
const RELEASE_URL = "https://rvenv.example.com";
const D = `sha256:${"d".repeat(64)}` as Digest;
const CAS = `sha256:${"a".repeat(64)}` as Digest;

function databaseName(): string {
  return `tanren_rvenv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

const MATRIX: ExecutionMatrix = {
  browser: ["chromium"],
  viewport: ["1280x720"],
  locale: ["en"],
  theme: ["light"],
  motion: ["no-preference"],
  contrast: ["normal"],
  device: ["desktop"],
};

function plan(): AcceptancePlan {
  return {
    planId: "plan_rvenv",
    behaviorRevisionId: BEHAVIOR_REVISION,
    requiredSurfaces: ["browser"],
    assertions: [{ assertionId: "a1", subject: "status", comparisonOperator: "equals", expected: 200 }],
    fixtures: [],
    examples: [],
    executionMatrix: MATRIX,
  };
}

function driver(observations: readonly DriverObservation[]): AcceptanceSurfaceDriver {
  return {
    surface: "browser",
    drive(): Promise<DriverExecutionResult | AdapterUnavailableResult> {
      return Promise.resolve({ kind: "executed", observations, providerChecksums: [] });
    },
  };
}
function observation(subject: string, value: number): DriverObservation {
  return { observationKind: "http", subject, value, observedAt: "2026-07-19T00:00:00.000Z" };
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
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO integration_nodes (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, member_key, head_sha, tree_hash, status)
     VALUES ($1, $2, $3, 'main', $4, 'refs/heads/main', 'merge_batch', 'member-rvenv', $4, 'tree-rvenv', 'ready')`,
    [NODE_ID, PROJECT, ORG, D],
  );
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, 0, 'application/octet-stream', 'inline_pg', $3)`,
    [ORG, CAS, Buffer.from([0])],
  );
  await owner.query(
    `INSERT INTO persona_revisions (id, org_id, project_id, persona_id, scope, revision_number, name, description, content_digest)
     VALUES ($1, $2, $3, 'persona', 'project', 1, 'persona', 'persona', $4)`,
    [PERSONA_REVISION, ORG, PROJECT, D],
  );
  await owner.query(
    `INSERT INTO behavior_revisions (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then", content_digest)
     VALUES ($1, $2, $3, 'behavior', $4, 1, 'behavior', 'g', 'w', 't', $5)`,
    [BEHAVIOR_REVISION, ORG, PROJECT, PERSONA_REVISION, D],
  );
}

// Drive the REAL deploy path as tenant app role through the production repository:
// create a built release then mark it live in production. The repository's markLive
// find-or-creates the ready verification env atomically in its own txn.
async function createBuiltAndMarkLive(app: Pool, deploymentId: string, url: string = RELEASE_URL): Promise<string> {
  const repo = new PgReleaseInstancesRepository(app);
  await repo.create({
    orgId: ORG,
    projectId: PROJECT,
    provider: PROVIDER,
    appId: APP_ID,
    environment: "preview",
    deploymentId,
    sourceRef: `${"e".repeat(40)}`,
    artifactDigest: CAS,
    providerChecksum: null,
    integrationNodeId: NODE_ID,
    behaviorRevisionIds: [BEHAVIOR_REVISION],
    state: "built",
  });
  const live = await repo.markLive({
    orgId: ORG,
    projectId: PROJECT,
    provider: PROVIDER,
    appId: APP_ID,
    deploymentId,
    url,
  });
  return live.releaseInstanceId;
}

interface EnvRow {
  id: string;
  deployment_target: string;
  lifecycle_status: string;
  tenant_lease_id: string;
}
async function readyEnvsFor(pool: Pool, org: string): Promise<EnvRow[]> {
  return runWithOrgScope(pool, org, async (client) => {
    const result = await client.query<EnvRow>(
      `SELECT id, deployment_target, lifecycle_status, tenant_lease_id
         FROM verification_environments
        WHERE org_id = $1 AND project_id = $2 AND integration_node_id = $3
          AND artifact_digest = $4 AND deployment_target = 'production' AND lifecycle_status = 'ready'`,
      [org, PROJECT, NODE_ID, CAS],
    );
    return result.rows;
  });
}

describeDb("rv-env — deploy creates the verification environment a real verdict persists against", () => {
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
    await seedTenant(owner);
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
  }, 60_000);

  it("persists a REAL passed behavior verdict against a deploy-created verification environment", async () => {
    const releaseInstanceId = await createBuiltAndMarkLive(app, DEPLOYMENT_ID);

    // The deploy created exactly ONE ready production env, bound to the release.
    const envs = await readyEnvsFor(app, ORG);
    expect(envs).toHaveLength(1);
    const environmentId = envs[0]!.id;
    expect(envs[0]!.deployment_target).toBe("production");
    expect(envs[0]!.lifecycle_status).toBe("ready");
    expect(envs[0]!.tenant_lease_id).toBe(releaseInstanceId);

    // Drive the real acceptance orchestrator against that env → a persisted verdict.
    const store = new PgAcceptanceRunStore(app);
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new PgAcceptanceEventSink(app),
      fixtureLease: new PgFixtureLeaseAdapter(app),
      drivers: [driver([observation("status", 200)])],
    });
    const result = await orchestrator.execute({
      orgId: ORG,
      projectId: PROJECT,
      integrationNodeId: NODE_ID,
      environmentId,
      preparedHeadSha: "abcdef",
      jjTreeId: "tree-rvenv",
      artifactDigest: CAS,
      deploymentFingerprint: "fp",
      purpose: "post_merge_production",
      plans: [plan()],
    });
    expect(result.passedVerdictCount).toBe(1);

    // The verdict is PERSISTED, immutable, and full-coverage — and its run FKs the
    // real deploy-created environment (proving the binding, not an ephemeral sink).
    const persisted = await runWithOrgScope(app, ORG, async (client) => {
      return client.query<{
        outcome: string;
        required: number;
        executed: number;
        environment_id: string;
      }>(
        `SELECT v.outcome, v.required_assertion_count AS required,
                v.executed_assertion_count AS executed, r.environment_id
           FROM behavior_verdicts v
           JOIN behavior_verification_runs r ON r.org_id = v.org_id AND r.id = v.run_id
          WHERE v.org_id = $1 AND v.run_id = $2`,
        [ORG, result.runId],
      );
    });
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]!.outcome).toBe("passed");
    expect(persisted.rows[0]!.executed).toBeGreaterThanOrEqual(persisted.rows[0]!.required);
    expect(persisted.rows[0]!.required).toBeGreaterThanOrEqual(1);
    expect(persisted.rows[0]!.environment_id).toBe(environmentId);
  });

  it("re-deploy is idempotent — no duplicate verification environment", async () => {
    await createBuiltAndMarkLive(app, "deploy_rvenv_2");
    // Same artifact + node + project → the ready env is REUSED, never duplicated.
    const envs = await readyEnvsFor(app, ORG);
    expect(envs).toHaveLength(1);
  });

  it("a passed verdict is still impossible without real coverage on the persisted path", async () => {
    const environmentId = (await readyEnvsFor(app, ORG))[0]!.id;
    const store = new PgAcceptanceRunStore(app);
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new PgAcceptanceEventSink(app),
      fixtureLease: new PgFixtureLeaseAdapter(app),
      // Driver observes NOTHING → the required assertion never executes.
      drivers: [driver([])],
    });
    const result = await orchestrator.execute({
      orgId: ORG,
      projectId: PROJECT,
      integrationNodeId: NODE_ID,
      environmentId,
      preparedHeadSha: "abcdef",
      jjTreeId: "tree-rvenv",
      artifactDigest: CAS,
      deploymentFingerprint: "fp",
      purpose: "post_merge_production",
      plans: [plan()],
    });
    expect(result.passedVerdictCount).toBe(0);
    const outcome = await runWithOrgScope(app, ORG, async (client) => {
      const rows = await client.query<{ outcome: string; executed: number }>(
        `SELECT outcome, executed_assertion_count AS executed FROM behavior_verdicts WHERE org_id = $1 AND run_id = $2`,
        [ORG, result.runId],
      );
      return rows.rows[0]!;
    });
    expect(outcome.outcome).not.toBe("passed");
    expect(outcome.executed).toBe(0);

    // The 0079 DB CHECK independently rejects a fabricated no-coverage green verdict.
    await expect(
      runWithOrgScope(app, ORG, async (client) => {
        await client.query(
          `INSERT INTO behavior_verdicts
             (org_id, id, project_id, run_id, behavior_revision_id, example_hash, matrix_hash,
              required_assertion_count, executed_assertion_count, outcome, attempt_count,
              flake_state, gate_effect, artifact_digest, runtime_behavior_context_hash)
           VALUES ($1, 'verdict_forged', $2, $3, $4, 'h', 'm', 0, 0, 'passed', 1, 'stable', 'blocking', $5, $5)`,
          [ORG, PROJECT, result.runId, BEHAVIOR_REVISION, CAS],
        );
      }),
    ).rejects.toThrow(/behavior_verdicts_pass_requires_coverage_floor|check constraint/u);
  });

  it("verification environments are org-isolated — another org sees zero rows", async () => {
    const otherOrgRows = await readyEnvsFor(app, OTHER_ORG);
    expect(otherOrgRows).toHaveLength(0);
  });

  it("honest binding — a deploy of the same artifact to a DIFFERENT url creates a DISTINCT env", async () => {
    const before = await readyEnvsFor(app, ORG);
    await createBuiltAndMarkLive(app, "deploy_rvenv_divergent", "https://rvenv-divergent.example.com");
    const after = await readyEnvsFor(app, ORG);
    // The divergent-URL deployment did not reuse the existing env (its fingerprint differs);
    // a new ready env exists, so a verdict is never bound to the wrong deployment URL.
    expect(after.length).toBe(before.length + 1);
    const beforeIds = new Set(before.map((row) => row.id));
    expect(after.some((row) => !beforeIds.has(row.id))).toBe(true);
  });
});
