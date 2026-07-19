// cspell:ignore premerge verenv inode
// rv-premerge — real-Postgres, ANTI-COSPLAY end-to-end proof. Three things the injected-value
// unit tests could NOT catch (the fail-open audit):
//   (A) PRODUCTION resolution: the producer resolves the run's DECLARED behavior ids
//       (spec_behaviors) to their ACTIVE behavior_revision ids (PgBehaviorRevisionResolver) and
//       drives the REAL rv-11 orchestrator (real rv-6 driver, injected fetch — no live network)
//       → a FAILING behavior records a `pre_merge` failed verdict that the real
//       resolveLandTimeBehaviorGate BLOCKS the land on; a passing behavior clears.
//   (B) REAL node binding (fix #2): a pre-merge preview binds a REAL `pre_merge_preview`
//       integration_nodes node (ensurePreMergePreviewNode) — NOT the runId (binding the env to
//       the runId violates the FK and fails the gate closed on every run).
//   (C) LEAK-SAFE teardown (fix #2): when the env bind throws AFTER applyPreview, the deployed
//       preview is torn down — no leaked previews.
import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveLandTimeBehaviorGate } from "../src/engine/merge/behaviorLandGate.js";
import {
  AcceptanceOrchestrator,
  HttpAcceptanceSurfaceDriver,
  PgAcceptancePlanLoader,
  PgAcceptanceRunStore,
  type AcceptanceBaseUrlResolver,
  type AcceptanceEventSink,
} from "../src/engine/verification/acceptance/index.js";
import type { HttpFetch } from "../src/engine/verification/acceptance/httpDriver.js";
import { PgBehaviorRevisionResolver } from "../src/engine/repositories/behaviorRevisionResolver.js";
import {
  ensurePreMergePreviewNode,
  ensurePreviewVerificationEnvironment,
} from "../src/engine/repositories/verificationEnvironments.js";
import { DeployAdapterPreviewSurfaceProvisioner } from "../src/engine/verification/preMerge/deployAdapterPreviewProvisioner.js";
import {
  PreviewBehaviorGateProducer,
  type PreMergeBehaviorGateInput,
  type PreviewProvisionResult,
  type PreviewSurface,
  type PreviewSurfaceProvisioner,
} from "../src/engine/verification/preMerge/preMergeBehaviorGateProducer.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG = "org_premerge";
const PROJECT = "project_premerge";
const NODE_ID = "inode_premerge";
const ENV_ID = "venv_premerge";
const PERSONA_REVISION = "pr_premerge";
const BEHAVIOR_ID = "behavior_premerge";
const BEHAVIOR_REVISION = "br_premerge";
const SPEC_ID = "spec_premerge";
const D = `sha256:${"c".repeat(64)}`;
const CAS = `sha256:${"a".repeat(64)}`;

// A minimal but VALID executable acceptance spec: one HTTP probe + one assertion that the
// health probe returns HTTP 200. A 500 fake response FAILS it (failed_product); 200 passes.
const ACCEPTANCE = {
  requiredSurfaces: ["api"],
  httpProbes: [{ probeId: "p1", method: "GET", path: "/" }],
  assertions: [{ assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 }],
};

function databaseName(): string {
  return `tanren_premerge_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

class FixedBaseUrlResolver implements AcceptanceBaseUrlResolver {
  public constructor(private readonly baseUrl: string) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  public async resolve(): Promise<{ kind: "resolved"; baseUrl: string }> {
    return { kind: "resolved", baseUrl: this.baseUrl };
  }
}
const NOOP_SINK: AcceptanceEventSink = { append: async () => {} };
function fakeFetch(status: number): HttpFetch {
  // eslint-disable-next-line @typescript-eslint/require-await
  return async () => ({ status, headers: { get: () => null }, text: async () => "{}" });
}

/** A provisioner that hands the producer a surface bound to the SEEDED real node/env/digest. */
function fixedProvisioner(): PreviewSurfaceProvisioner {
  const surface: PreviewSurface = {
    deploymentId: "dep_premerge",
    url: "https://preview.premerge.test",
    integrationNodeId: NODE_ID,
    artifactDigest: CAS as PreviewSurface["artifactDigest"],
    environmentId: ENV_ID,
    orgId: ORG,
    projectId: PROJECT,
    provider: "deploy.vercel",
    appId: "app1",
  };
  const result: PreviewProvisionResult = { kind: "provisioned", surface };
  return { provision: async () => result, teardown: async () => {} };
}

async function seedTenant(owner: Pool): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [ORG],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://github.com/acme/web.git', 'main', 'runner:v0', $2, $3::jsonb)`,
    [PROJECT, ORG, JSON.stringify({ version: 1, deployProvider: "deploy.vercel", deployAppId: "app1" })],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, 'premerge', 'pre-merge behavior gate', 'in_flight')`,
    [SPEC_ID, PROJECT, ORG],
  );
  // The run's DECLARED behavior (spec_behaviors → behaviors) — the producer resolves this
  // behavior id to its ACTIVE behavior_revision id in production (NOT injected).
  await owner.query(
    `INSERT INTO personas (id, scope, org_id, project_id, name, description)
     VALUES ('persona_pm', 'project', $1, $2, 'persona', 'persona')`,
    [ORG, PROJECT],
  );
  await owner.query(
    `INSERT INTO behaviors (id, persona_id, title, given, "when", "then")
     VALUES ($1, 'persona_pm', 'behavior', 'g', 'w', 't')`,
    [BEHAVIOR_ID],
  );
  await owner.query(`INSERT INTO spec_behaviors (spec_id, behavior_id) VALUES ($1, $2)`, [SPEC_ID, BEHAVIOR_ID]);
  await owner.query(
    `INSERT INTO integration_nodes (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, member_key)
     VALUES ($1, $2, $3, 'main', $4, 'refs/heads/main', 'merge_batch', 'member-premerge')`,
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
  // The behavior's ACTIVE revision carries the acceptance spec the plan loader compiles.
  await owner.query(
    `INSERT INTO behavior_revisions (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then", content_digest, acceptance, status)
     VALUES ($1, $2, $3, $4, $5, 1, 'behavior', 'g', 'w', 't', $6, $7::jsonb, 'active')`,
    [BEHAVIOR_REVISION, ORG, PROJECT, BEHAVIOR_ID, PERSONA_REVISION, D, JSON.stringify(ACCEPTANCE)],
  );
  await owner.query(
    `INSERT INTO verification_environments (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target, environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, 'preview', $6, $6, 'ready')`,
    [ORG, ENV_ID, PROJECT, NODE_ID, CAS, D],
  );
}

async function seedMergeRun(owner: Pool, mergeRunId: string): Promise<void> {
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'feat', 'running')`,
    [mergeRunId, SPEC_ID, PROJECT, ORG],
  );
}

function buildProducer(app: Pool, status: number, provisioner: PreviewSurfaceProvisioner): PreviewBehaviorGateProducer {
  return new PreviewBehaviorGateProducer({
    provisioner,
    // PRODUCTION resolution: behavior ids → ACTIVE behavior_revision ids over the real DB.
    behaviorRevisions: new PgBehaviorRevisionResolver(app),
    planLoader: new PgAcceptancePlanLoader(app),
    buildExecutor: (baseUrl) =>
      new AcceptanceOrchestrator({
        store: new PgAcceptanceRunStore(app),
        events: NOOP_SINK,
        drivers: [
          new HttpAcceptanceSurfaceDriver({
            resolveBaseUrl: new FixedBaseUrlResolver(baseUrl),
            fetchImpl: fakeFetch(status),
          }),
        ],
      }),
  });
}

function gateInput(mergeRunId: string): PreMergeBehaviorGateInput {
  return {
    orgId: ORG,
    projectId: PROJECT,
    runId: mergeRunId,
    specId: SPEC_ID,
    repoUrl: "https://github.com/acme/web.git",
    headSha: "deadbeef",
    // The run's DECLARED behavior id (as context.behaviorIds hydrates it) — resolved to its
    // active revision by the producer, NOT a pre-resolved revision id.
    behaviorIds: [BEHAVIOR_ID],
  };
}

describeDb("pre-merge behavior gate — production resolution, real-node binding, leak-safe teardown", () => {
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
  }, 30_000);

  it("(A) FAILING behavior (production revision resolution) → pre_merge verdict BLOCKS the land", async () => {
    const mergeRunId = "run_premerge_fail";
    await seedMergeRun(owner, mergeRunId);
    expect(await resolveLandTimeBehaviorGate(app, ORG, mergeRunId)).toEqual({ kind: "not_applicable" });

    const outcome = await buildProducer(app, 500, fixedProvisioner()).produce(gateInput(mergeRunId));
    expect(outcome).toMatchObject({ kind: "blocked" });

    const gate = await resolveLandTimeBehaviorGate(app, ORG, mergeRunId);
    expect(gate).toMatchObject({ kind: "failed", behaviorRevisionId: BEHAVIOR_REVISION, outcome: "failed_product" });
  });

  it("(A) PASSING behavior → pre_merge passed verdict → the land gate CLEARS", async () => {
    const mergeRunId = "run_premerge_pass";
    await seedMergeRun(owner, mergeRunId);
    const outcome = await buildProducer(app, 200, fixedProvisioner()).produce(gateInput(mergeRunId));
    expect(outcome).toMatchObject({ kind: "passed", passedBlockingCount: 1 });
    expect(await resolveLandTimeBehaviorGate(app, ORG, mergeRunId)).toEqual({ kind: "passed", passedBlockingCount: 1 });
  });

  it("(A) PARTIAL coverage: a 2nd declared behavior with NO active revision → blocked (real resolver drops it)", async () => {
    // A second declared behavior whose ONLY revision is superseded (no active) — the real
    // PgBehaviorRevisionResolver returns only the first behavior's revision, so the producer
    // must BLOCK on the shortfall rather than pass on the 1-of-2 subset.
    await owner.query(
      `INSERT INTO behaviors (id, persona_id, title, given, "when", "then") VALUES ('beh2', 'persona_pm', 'b2', 'g', 'w', 't')`,
    );
    await owner.query(
      `INSERT INTO behavior_revisions (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then", content_digest, acceptance, status)
       VALUES ('br2_superseded', $1, $2, 'beh2', $3, 1, 'b2', 'g', 'w', 't', $4, $5::jsonb, 'superseded')`,
      [ORG, PROJECT, PERSONA_REVISION, D, JSON.stringify(ACCEPTANCE)],
    );
    const mergeRunId = "run_premerge_partial";
    await seedMergeRun(owner, mergeRunId);
    const input = { ...gateInput(mergeRunId), behaviorIds: [BEHAVIOR_ID, "beh2"] };
    const outcome = await buildProducer(app, 200, fixedProvisioner()).produce(input);
    expect(outcome.kind).toBe("blocked");
    // Nothing was verified/recorded — the land gate stays not_applicable (the producer BLOCKS
    // in-band; the caller halts on it).
    expect(await resolveLandTimeBehaviorGate(app, ORG, mergeRunId)).toEqual({ kind: "not_applicable" });
  });

  it("(B) ensurePreMergePreviewNode mints a REAL node (not the runId) the preview env FKs", async () => {
    const runId = "run_node_bind";
    const nodeId = await runWithOrgScope(app, ORG, (client) =>
      ensurePreMergePreviewNode(client, { orgId: ORG, projectId: PROJECT, runId, headSha: "cafe1234" }),
    );
    expect(nodeId).not.toBe(runId);
    expect(nodeId.startsWith("inode_")).toBe(true);
    // Idempotent: a second call for the same run reuses the row.
    const again = await runWithOrgScope(app, ORG, (client) =>
      ensurePreMergePreviewNode(client, { orgId: ORG, projectId: PROJECT, runId, headSha: "cafe1234" }),
    );
    expect(again).toBe(nodeId);
    // The preview env binds to the REAL node (FK satisfied)...
    const env = await runWithOrgScope(app, ORG, (client) =>
      ensurePreviewVerificationEnvironment(client, {
        orgId: ORG,
        projectId: PROJECT,
        integrationNodeId: nodeId,
        artifactDigest: CAS as never,
        releaseInstanceId: "rel_node_bind",
        url: "https://preview.node.test",
      }),
    );
    expect(env.environmentId.length).toBeGreaterThan(0);
    // ...but binding to the runId (not a node_id) VIOLATES the FK — the very bug this fixes.
    await expect(
      runWithOrgScope(app, ORG, (client) =>
        client.query(
          `INSERT INTO verification_environments (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target, environment_fingerprint, tenant_lease_id, lifecycle_status)
           VALUES ($1, 'venv_bad', $2, $3, $4, 'preview', 'fp_bad', 'lease_bad', 'ready')`,
          [ORG, PROJECT, runId, CAS],
        ),
      ),
    ).rejects.toThrow(/foreign key|violates/iu);
  });

  it("(C) env bind fails AFTER applyPreview → the deployed preview is TORN DOWN (no leak)", async () => {
    const runId = "run_leak_safe";
    const teardownPreview = vi.fn<() => Promise<void>>(async () => {});
    // A fake adapter: applyPreview 'deploys' but (unlike the real one) does NOT register the
    // preview artifact in cas_artifacts, so the subsequent env bind FK-fails — the leak scenario.
    const fakeAdapter = {
      applyPreview: async () => ({
        deploymentId: "dep_leak",
        url: "https://preview.leak.test",
        environment: "preview" as const,
        artifactDigest: CAS as never,
        state: "preview" as const,
      }),
      teardownPreview,
    };
    // The provisioner runs on the PRIVILEGED worker pool (as in production) — resolveTarget
    // reads projects.config under system scope, which the RLS app role cannot do.
    const provisioner = new DeployAdapterPreviewSurfaceProvisioner(
      owner,
      { transport: {} as never, secrets: {} as never },
      {
        adapter: fakeAdapter,
        loadGrant: async () => ({}) as never,
      },
    );
    const result = await provisioner.provision(
      {
        orgId: ORG,
        projectId: PROJECT,
        runId,
        specId: SPEC_ID,
        repoUrl: "https://github.com/acme/web.git",
        headSha: "beef5678",
        behaviorIds: [BEHAVIOR_ID],
      },
      [BEHAVIOR_REVISION as never],
    );
    expect(result.kind).toBe("failed");
    // The deployed preview was reaped despite the env-bind failure — no leaked preview.
    expect(teardownPreview).toHaveBeenCalledOnce();
    // And a REAL pre_merge_preview node was minted for the run (fix #2b, exercised in prod path).
    const node = await runWithOrgScope(app, ORG, (client) =>
      client.query<{ node_id: string; purpose: string }>(
        `SELECT node_id, purpose FROM integration_nodes WHERE org_id = $1 AND member_key = $2`,
        [ORG, `pre_merge_preview:${runId}`],
      ),
    );
    expect(node.rows[0]?.purpose).toBe("pre_merge_preview");
    expect(node.rows[0]?.node_id.startsWith("inode_")).toBe(true);
  });
});
