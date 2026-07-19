// cspell:ignore premerge verenv
// rv-premerge — real-Postgres, ANTI-COSPLAY end-to-end proof: the pre-merge behavior-gate
// producer drives the REAL rv-11 AcceptanceOrchestrator (real rv-6 HttpAcceptanceSurfaceDriver,
// fed by an injected fetch so no live network is needed) against a preview URL, PERSISTS a
// `purpose='pre_merge'` BLOCKING verdict through the real PgAcceptanceRunStore, and that
// recorded verdict — read by the real `resolveLandTimeBehaviorGate` — BLOCKS the land when the
// behavior fails. A passing behavior clears. The verdict is never fabricated: a 500 response
// makes the acceptance assertion FAIL (failed_product); a 200 passes.
import { migrate } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

/** A provisioner that hands the producer a preview surface bound to the SEEDED env/node. */
function fixedProvisioner(): PreviewSurfaceProvisioner {
  const surface: PreviewSurface = {
    deploymentId: "dep_premerge",
    url: "https://preview.premerge.test",
    integrationNodeId: NODE_ID,
    artifactDigest: CAS as PreviewSurface["artifactDigest"],
    environmentId: ENV_ID,
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
     VALUES ($1, $1, 'https://github.com/acme/web.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, 'premerge', 'pre-merge behavior gate', 'in_flight')`,
    [SPEC_ID, PROJECT, ORG],
  );
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
  await owner.query(
    `INSERT INTO behavior_revisions (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then", content_digest, acceptance)
     VALUES ($1, $2, $3, 'behavior', $4, 1, 'behavior', 'g', 'w', 't', $5, $6::jsonb)`,
    [BEHAVIOR_REVISION, ORG, PROJECT, PERSONA_REVISION, D, JSON.stringify(ACCEPTANCE)],
  );
  // A preview-target verification environment the pre_merge run persists against.
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

function buildProducer(app: Pool, status: number): PreviewBehaviorGateProducer {
  return new PreviewBehaviorGateProducer({
    provisioner: fixedProvisioner(),
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
    behaviorRevisionIds: [BEHAVIOR_REVISION],
  };
}

describeDb("pre-merge behavior gate — records pre_merge verdict that blocks/clears the land", () => {
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

  it("a FAILING behavior on the preview → pre_merge failed verdict → resolveLandTimeBehaviorGate BLOCKS the land", async () => {
    const mergeRunId = "run_premerge_fail";
    await seedMergeRun(owner, mergeRunId);
    // Before the producer runs, the land gate sees no pre_merge run → not_applicable.
    expect(await resolveLandTimeBehaviorGate(app, ORG, mergeRunId)).toEqual({ kind: "not_applicable" });

    const outcome = await buildProducer(app, 500).produce(gateInput(mergeRunId));
    expect(outcome).toMatchObject({ kind: "blocked" });

    // The recorded pre_merge blocking verdict now BLOCKS the land, fail-closed.
    const gate = await resolveLandTimeBehaviorGate(app, ORG, mergeRunId);
    expect(gate).toMatchObject({ kind: "failed", behaviorRevisionId: BEHAVIOR_REVISION, outcome: "failed_product" });
  });

  it("a PASSING behavior on the preview → pre_merge passed verdict → the land gate CLEARS", async () => {
    const mergeRunId = "run_premerge_pass";
    await seedMergeRun(owner, mergeRunId);
    const outcome = await buildProducer(app, 200).produce(gateInput(mergeRunId));
    expect(outcome).toMatchObject({ kind: "passed", passedBlockingCount: 1 });
    expect(await resolveLandTimeBehaviorGate(app, ORG, mergeRunId)).toEqual({ kind: "passed", passedBlockingCount: 1 });
  });
});
