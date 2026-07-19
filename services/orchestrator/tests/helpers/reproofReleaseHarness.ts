// Shared fixtures + seed/query helpers for the rv-19 post-merge re-proof RLS proof.
// Split out of the test file so the decisive scenarios stay under the max-lines cap; the
// DB lifecycle (create/migrate/drop) stays in the test's beforeAll/afterAll.
import { runWithOrgScope } from "@tanren/db";
import type { Pool } from "pg";
import { ReleaseInstancesStore } from "../../src/engine/repositories/releaseInstances.js";
import type { ProductionResolutionStageResult, ResolutionJob } from "../../src/engine/contracts/resolutionStage.js";

export const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
export const APP_USER = "tanren_app";
export const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

export const ORG_A = "org_reproof_rls_a";
export const ORG_B = "org_reproof_rls_b";
export const PROJECT_A = "project_reproof_rls_a";
export const PROJECT_B = "project_reproof_rls_b";
export const PROVIDER = "deploy.fixture";
export const APP_ID = "app_reproof";
export const DIGEST_PRIOR = `sha256:${"a".repeat(64)}`;
export const DIGEST_NEW = `sha256:${"b".repeat(64)}`;
export const DIGEST_B = `sha256:${"c".repeat(64)}`;
export const GIT_SHA = "a".repeat(40);

export const PRODUCT_RESOLVED: ProductionResolutionStageResult = {
  proofGrade: "active_causal",
  verificationRunId: "vrun_resolved",
  assertionIds: ["a1"],
  evidenceRefs: ["e1"],
  outcome: "passed",
  classification: "product_resolved",
};
export const PRODUCT_FAILURE: ProductionResolutionStageResult = {
  proofGrade: "active_causal",
  verificationRunId: "vrun_failure",
  assertionIds: ["a1"],
  evidenceRefs: ["e1"],
  outcome: "failed",
  classification: "product_failure",
};
export const INCONCLUSIVE: ProductionResolutionStageResult = {
  proofGrade: "active_causal",
  verificationRunId: "vrun_inconclusive",
  assertionIds: [],
  evidenceRefs: [],
  outcome: "inconclusive",
  classification: "infra_failure",
};

export function reproofDatabaseName(): string {
  return `tanren_reproof_rls_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
export function connectionUrl(database: string, appRole = false): string {
  const parsed = new URL(ADMIN_URL);
  parsed.pathname = `/${database}`;
  if (appRole) {
    parsed.username = APP_USER;
    parsed.password = APP_PASSWORD;
  }
  return parsed.toString();
}

export async function seedOrg(
  owner: Pool,
  orgId: string,
  projectId: string,
  digests: readonly string[],
): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', $2, '{"version":1}'::jsonb)`,
    [projectId, orgId],
  );
  for (const digest of digests) {
    await owner.query(
      `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
       VALUES ($1, $2, 1, 'application/octet-stream', 'inline_pg', '\\x00'::bytea)`,
      [orgId, digest],
    );
  }
}

export async function seedRelease(
  owner: Pool,
  input: {
    orgId: string;
    projectId: string;
    id: string;
    digest: string;
    state: string;
    previous: string | null;
    sourceRef?: string;
  },
): Promise<void> {
  await owner.query(
    `INSERT INTO release_instances
       (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref, artifact_digest,
        provider_checksum, integration_node_id, url, previous_release_instance_id, state)
     VALUES ($1, $2, $3, $4, $5, 'production', $6, $7, $8, NULL, $9, $10, $11, $12)`,
    [
      input.orgId,
      input.id,
      input.projectId,
      PROVIDER,
      APP_ID,
      `deployment-${input.id}`,
      input.sourceRef ?? "main",
      input.digest,
      `integration-node-${input.id}`,
      `https://example.invalid/${input.id}`,
      input.previous,
      input.state,
    ],
  );
}

export async function latestLiveId(app: Pool, orgId: string, projectId: string): Promise<string | undefined> {
  return runWithOrgScope(app, orgId, async (client) => {
    const live = await ReleaseInstancesStore.latestLive(client, orgId, projectId, PROVIDER, APP_ID);
    return live?.releaseInstanceId;
  });
}
export async function stateOf(app: Pool, orgId: string, id: string): Promise<string | undefined> {
  return runWithOrgScope(app, orgId, async (client) => {
    const row = await ReleaseInstancesStore.getById(client, orgId, id);
    return row?.state;
  });
}
export async function deployEventCount(
  app: Pool,
  eventType: "deployment.rolled_back" | "deployment.promoted",
  orgId: string,
  projectId: string,
  deploymentId: string,
): Promise<number> {
  return runWithOrgScope(app, orgId, async (client) => {
    const rows = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM events
        WHERE org_id = $1 AND project_id = $2 AND event_type = $3 AND payload ->> 'deploymentId' = $4`,
      [orgId, projectId, eventType, deploymentId],
    );
    return Number(rows.rows[0]?.n ?? "0");
  });
}

export function reproofJob(releaseInstanceId: string, overrides: Partial<ResolutionJob> = {}): ResolutionJob {
  return {
    id: "rjob_reproof",
    orgId: ORG_A,
    projectId: PROJECT_A,
    issueLoopId: "loop_a",
    contractId: "contract_a",
    releaseInstanceId,
    stage: "production",
    state: "running",
    leaseOwner: "reproof_lease",
    leaseExpiry: "2026-07-18T00:00:00.000Z",
    idempotencyKey: "idem_a",
    attempt: 1,
    ...overrides,
  };
}
