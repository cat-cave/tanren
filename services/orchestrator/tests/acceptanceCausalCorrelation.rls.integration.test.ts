// Real-Postgres proof for rv-12 A3 causal-correlation. It drives the REAL
// acceptance orchestrator + the REAL correlation core + the REAL rv-8 immutable
// effect evidence (seeded through PgSideEffectObserverAdapter.observe) + the
// PgCausalEffectReader, as the restricted non-superuser tanren_app role. It proves
// (a) a genuinely correlated effect set records a passed verdict, (b) an effect
// from a DIFFERENT cause is never counted, and (c) cross-org effect isolation —
// so no false-green can survive on the live substrate. Gated on TANREN_RLS_DB_TEST;
// runs in the `smoke-rls-causal-correlation` recipe.
import { migrate } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Digest } from "../src/engine/contracts/cas.js";
import type { AdapterUnavailableResult } from "../src/engine/contracts/runtimeVerificationAdapters.js";
import type { ExecutionMatrix } from "../src/engine/contracts/runtimeVerificationPlan.js";
import { PgCausalEffectReader } from "../src/engine/verification/effectObserver/pgCausalEffectReader.js";
import { PgSideEffectObserverAdapter } from "../src/engine/verification/effectObserver/pgSideEffectObserverAdapter.js";
import {
  AcceptanceOrchestrator,
  PgAcceptanceEventSink,
  PgAcceptanceRunStore,
  type AcceptanceCauseDriver,
  type AcceptancePlan,
  type CauseFiring,
} from "../src/engine/verification/acceptance/index.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG = "org_causal_rv12";
const OTHER_ORG = "org_causal_rv12_other";
const PROJECT = "project_causal_rv12";
const NODE_ID = "inode_causal_rv12";
const ENV_ID = "venv_causal_rv12";
const BEHAVIOR_REVISION = "br_causal_rv12";
const PERSONA_REVISION = "pr_causal_rv12";
const D = `sha256:${"c".repeat(64)}` as Digest;
const CAS = `sha256:${"a".repeat(64)}` as Digest;
const ID = (n: number): string => `sha256:${String(n).padStart(64, "0")}`;

function databaseName(): string {
  return `tanren_causal_rv12_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

function causeDriver(firing: CauseFiring): AcceptanceCauseDriver {
  return {
    surface: "api",
    fireCause(): Promise<CauseFiring | AdapterUnavailableResult> {
      return Promise.resolve(firing);
    },
  };
}

function causalPlan(expected: number): AcceptancePlan {
  return {
    planId: "plan_causal_rv12",
    behaviorRevisionId: BEHAVIOR_REVISION,
    requiredSurfaces: [],
    assertions: [
      {
        assertionId: "a1",
        subject: "slack_effects",
        comparisonOperator: "has_cardinality",
        expected,
        correlation: { causeId: "order", observer: "slack", provider: "slack", requireCorrelationId: true },
      },
    ],
    fixtures: [],
    examples: [],
    executionMatrix: MATRIX,
    causes: [{ causeId: "order", surface: "api", action: "post_order" }],
  };
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
     VALUES ($1, $2, $3, 'main', $4, 'refs/heads/main', 'merge_batch', 'member-causal')`,
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

describeDb("rv-12 A3 causal-correlation — real Postgres end-to-end", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let observer: PgSideEffectObserverAdapter;

  function orchestratorWith(firing: CauseFiring): AcceptanceOrchestrator {
    return new AcceptanceOrchestrator({
      store: new PgAcceptanceRunStore(app),
      events: new PgAcceptanceEventSink(app),
      causeDrivers: [causeDriver(firing)],
      effectReader: new PgCausalEffectReader(app),
    });
  }

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
    await seedTenant(owner);
    observer = new PgSideEffectObserverAdapter(app);
    // Seed the immutable rv-8 evidence: one effect correlated to the cause (id 1)
    // and one from a DIFFERENT cause (id 2), both in the same provider window.
    await observer.observe({
      orgId: ORG,
      projectId: PROJECT,
      observer: "slack",
      provider: "slack",
      triggerIdHash: ID(1),
      afterWatermark: "2000",
    });
    await observer.observe({
      orgId: ORG,
      projectId: PROJECT,
      observer: "slack",
      provider: "slack",
      triggerIdHash: ID(2),
      afterWatermark: "2000",
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

  it("DECISIVE: exactly one CORRELATED effect passes; the different-cause effect is excluded", async () => {
    const orchestrator = orchestratorWith({ causeId: "order", correlationId: ID(1), firedAtCursor: "1000" });
    const result = await orchestrator.execute(baseRequest([causalPlan(1)]));
    // Two effects exist for the provider, but only id-1 correlates to this cause.
    expect(result.behaviors[0]?.outcome).toBe("passed");
    expect(result.behaviors[0]?.executedAssertionCount).toBe(1);
    expect(result.passedVerdictCount).toBe(1);
  });

  it("DECISIVE: expecting cardinality 2 fails — the second effect is genuinely uncorrelated", async () => {
    const orchestrator = orchestratorWith({ causeId: "order", correlationId: ID(1), firedAtCursor: "1000" });
    const result = await orchestrator.execute(baseRequest([causalPlan(2)]));
    expect(result.behaviors[0]?.outcome).toBe("failed_product");
    expect(result.behaviors[0]?.outcome).not.toBe("passed");
  });

  it("org isolation: another org sees zero of this org's effect observations", async () => {
    const crossOrg = await new PgCausalEffectReader(app).effectsForProvider({
      orgId: OTHER_ORG,
      projectId: PROJECT,
      observer: "slack",
      provider: "slack",
    });
    expect(crossOrg).toHaveLength(0);
  });
});
