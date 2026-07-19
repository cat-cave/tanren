// Real-Postgres proof for the rv-11 A1 executable-acceptance orchestrator. It
// drives the REAL orchestrator (PgAcceptanceRunStore + PgAcceptanceEventSink +
// PgFixtureLeaseAdapter + a conformance surface driver) end-to-end as the
// restricted non-superuser tanren_app role, so the false-green pass gate, the
// append-only verdict ledger, and org isolation are proven on the live substrate.
// Gated on TANREN_RLS_DB_TEST like every peer *.rls.integration test; runs in the
// `smoke-rls-acceptance-orchestrator` recipe rather than the DB-less unit phase.
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
import { AllowAllPeerVerifier } from "../src/engine/contracts/index.js";
import { createInternalAcceptanceRunRoutes } from "../src/routes/internal/acceptanceRuns.js";
import { PgFixtureLeaseAdapter } from "../src/engine/verification/fixtureLease/index.js";
import {
  AcceptanceOrchestrator,
  PgAcceptanceEventSink,
  PgAcceptanceRunStore,
  type AcceptancePlan,
  type AcceptanceSurfaceDriver,
} from "../src/engine/verification/acceptance/index.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG = "org_acceptance_rv11";
const OTHER_ORG = "org_acceptance_rv11_other";
const PROJECT = "project_acceptance_rv11";
const NODE_ID = "inode_acceptance_rv11";
const ENV_ID = "venv_acceptance_rv11";
const BEHAVIOR_REVISION = "br_acceptance_rv11";
const PERSONA_REVISION = "pr_acceptance_rv11";
const D = `sha256:${"c".repeat(64)}` as Digest;
const CAS = `sha256:${"a".repeat(64)}` as Digest;

function databaseName(): string {
  return `tanren_acceptance_rv11_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

function plan(assertions: AcceptancePlan["assertions"]): AcceptancePlan {
  return {
    planId: "plan_acceptance_rv11",
    behaviorRevisionId: BEHAVIOR_REVISION,
    requiredSurfaces: ["browser"],
    assertions,
    fixtures: [{ id: "fixture_1" }],
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
  return { observationKind: "http", subject, value, observedAt: "2026-07-18T00:00:00.000Z" };
}

function baseRequest(plans: readonly AcceptancePlan[]) {
  return {
    orgId: ORG,
    projectId: PROJECT,
    integrationNodeId: NODE_ID,
    environmentId: ENV_ID,
    preparedHeadSha: "abcdef",
    jjTreeId: "tree_1",
    artifactDigest: CAS,
    deploymentFingerprint: D,
    plans,
  };
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
    `INSERT INTO integration_nodes (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, member_key)
     VALUES ($1, $2, $3, 'main', $4, 'refs/heads/main', 'merge_batch', 'member-acceptance')`,
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
  await owner.query(
    `INSERT INTO verification_environments (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target, environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, 'container', $6, $6, 'ready')`,
    [ORG, ENV_ID, PROJECT, NODE_ID, CAS, D],
  );
}

describeDb("rv-11 A1 acceptance orchestrator — real Postgres end-to-end", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let orchestrator: AcceptanceOrchestrator;
  let store: PgAcceptanceRunStore;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
    await seedTenant(owner);
    store = new PgAcceptanceRunStore(app);
    orchestrator = new AcceptanceOrchestrator({
      store,
      events: new PgAcceptanceEventSink(app),
      fixtureLease: new PgFixtureLeaseAdapter(app),
      drivers: [driver([observation("status", 200), observation("count", 3)])],
    });
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

  it("runs the decisive writes as the non-superuser tanren_app role", async () => {
    const identity = await app.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles AS r WHERE r.rolname = current_user",
    );
    expect(identity.rows[0]).toEqual({ current_user: "tanren_app", rolsuper: false, rolbypassrls: false });
  });

  it("records a passed verdict when every required assertion executed and passed", async () => {
    const result = await orchestrator.execute(
      baseRequest([
        plan([
          { assertionId: "a1", subject: "status", comparisonOperator: "equals", expected: 200 },
          { assertionId: "a2", subject: "count", comparisonOperator: "greater_than", expected: 1 },
        ]),
      ]),
    );
    expect(result.behaviors[0]?.outcome).toBe("passed");
    expect(result.behaviors[0]?.executedAssertionCount).toBe(2);
    const stored = await store.listVerdicts({ orgId: ORG, runId: result.runId });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.outcome).toBe("passed");
    expect(stored[0]?.executedAssertionCount).toBe(2);
    expect(stored[0]?.requiredAssertionCount).toBe(2);
  });

  it("DECISIVE false-green: under-coverage records a non-passed verdict on the live ledger", async () => {
    const underCoverage = new AcceptanceOrchestrator({
      store,
      events: new PgAcceptanceEventSink(app),
      fixtureLease: new PgFixtureLeaseAdapter(app),
      // The driver observes ONLY `status`; the `count` assertion never executes.
      drivers: [driver([observation("status", 200)])],
    });
    const result = await underCoverage.execute(
      baseRequest([
        plan([
          { assertionId: "a1", subject: "status", comparisonOperator: "equals", expected: 200 },
          { assertionId: "a2", subject: "count", comparisonOperator: "greater_than", expected: 1 },
        ]),
      ]),
    );
    expect(result.behaviors[0]?.outcome).toBe("failed_verification_contract");
    expect(result.behaviors[0]?.executedAssertionCount).toBe(1);
    const stored = await store.listVerdicts({ orgId: ORG, runId: result.runId });
    expect(stored[0]?.outcome).not.toBe("passed");
    expect(stored[0]?.executedAssertionCount).toBe(1);
    expect(stored[0]?.requiredAssertionCount).toBe(2);
  });

  it("the appended verdict is immutable — a tamper UPDATE is rejected (0079 trigger)", async () => {
    const result = await orchestrator.execute(
      baseRequest([plan([{ assertionId: "a1", subject: "status", comparisonOperator: "equals", expected: 200 }])]),
    );
    const verdictId = result.behaviors[0]?.verdictId;
    await expect(
      runWithOrgScope(app, ORG, (client) =>
        client.query("UPDATE behavior_verdicts SET outcome = 'failed_product' WHERE org_id = $1 AND id = $2", [
          ORG,
          verdictId,
        ]),
      ),
    ).rejects.toThrow(/immutable.*append-only.*UPDATE rejected/iu);
  });

  it("org isolation: another org sees zero of this org's verdicts", async () => {
    const result = await orchestrator.execute(
      baseRequest([plan([{ assertionId: "a1", subject: "status", comparisonOperator: "equals", expected: 200 }])]),
    );
    const crossOrg = await store.listVerdicts({ orgId: OTHER_ORG, runId: result.runId });
    expect(crossOrg).toHaveLength(0);
  });

  it("drives the full HTTP surface: POST /execute → orchestrator → recorded verdict → GET", async () => {
    const routes = createInternalAcceptanceRunRoutes({
      pool: app,
      verifier: new AllowAllPeerVerifier(),
      drivers: [driver([observation("status", 200), observation("count", 3)])],
    });
    const body = {
      orgId: ORG,
      projectId: PROJECT,
      integrationNodeId: NODE_ID,
      environmentId: ENV_ID,
      preparedHeadSha: "abcdef",
      jjTreeId: "tree_1",
      artifactDigest: CAS,
      deploymentFingerprint: D,
      plans: [
        {
          planId: "plan_http_rv11",
          behaviorRevisionId: BEHAVIOR_REVISION,
          requiredSurfaces: ["browser"],
          fixtures: [{ id: "fixture_1" }],
          assertions: [
            { assertionId: "a1", subject: "status", comparisonOperator: "equals", expected: 200 },
            { assertionId: "a2", subject: "count", comparisonOperator: "greater_than", expected: 1 },
          ],
        },
      ],
    };
    const executeResponse = await routes.request(
      "/internal/acceptance-runs/execute",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      { incoming: { socket: {} } },
    );
    expect(executeResponse.status).toBe(201);
    const executed = (await executeResponse.json()) as {
      result: { runId: string; passedVerdictCount: number; behaviors: { outcome: string }[] };
    };
    expect(executed.result.behaviors[0]?.outcome).toBe("passed");
    expect(executed.result.passedVerdictCount).toBe(1);

    const readResponse = await routes.request(
      `/internal/acceptance-runs/${ORG}/${executed.result.runId}`,
      { method: "GET" },
      { incoming: { socket: {} } },
    );
    expect(readResponse.status).toBe(200);
    const read = (await readResponse.json()) as { verdicts: { outcome: string; executedAssertionCount: number }[] };
    expect(read.verdicts).toHaveLength(1);
    expect(read.verdicts[0]?.outcome).toBe("passed");
    expect(read.verdicts[0]?.executedAssertionCount).toBe(2);
  });
});
