// rv-19 real-Postgres proof for the post-merge production re-proof + rollback hook.
// Every decisive write runs through the restricted non-superuser `tanren_app` role
// (rolsuper=false AND rolbypassrls=false), so the rollback-actually-reverts guarantee,
// the promote path, idempotency, and org isolation are proven on the live RLS-forced
// substrate. Gated on TANREN_RLS_DB_TEST like every peer *.rls.integration test; runs
// in the `smoke-rls-post-merge-reproof` recipe rather than the DB-less unit phase.
import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReleaseInstancesStore } from "../src/engine/repositories/releaseInstances.js";
import {
  PostMergeReproofCoordinator,
  type SettleReproofInput,
} from "../src/engine/verification/postMergeReproof/coordinator.js";
import type { ProductionResolutionStageResult } from "../src/engine/contracts/resolutionStage.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_USER = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG_A = "org_reproof_rls_a";
const ORG_B = "org_reproof_rls_b";
const PROJECT_A = "project_reproof_rls_a";
const PROJECT_B = "project_reproof_rls_b";
const PROVIDER = "deploy.fixture";
const APP_ID = "app_reproof";
const DIGEST_PRIOR = `sha256:${"a".repeat(64)}`;
const DIGEST_NEW = `sha256:${"b".repeat(64)}`;
const DIGEST_B = `sha256:${"c".repeat(64)}`;
const GIT_SHA = "a".repeat(40);

function databaseName(): string {
  return `tanren_reproof_rls_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function connectionUrl(database: string, appRole = false): string {
  const parsed = new URL(ADMIN_URL);
  parsed.pathname = `/${database}`;
  if (appRole) {
    parsed.username = APP_USER;
    parsed.password = APP_PASSWORD;
  }
  return parsed.toString();
}

const PRODUCT_RESOLVED: ProductionResolutionStageResult = {
  proofGrade: "active_causal",
  verificationRunId: "vrun_resolved",
  assertionIds: ["a1"],
  evidenceRefs: ["e1"],
  outcome: "passed",
  classification: "product_resolved",
};
const PRODUCT_FAILURE: ProductionResolutionStageResult = {
  proofGrade: "active_causal",
  verificationRunId: "vrun_failure",
  assertionIds: ["a1"],
  evidenceRefs: ["e1"],
  outcome: "failed",
  classification: "product_failure",
};
const INCONCLUSIVE: ProductionResolutionStageResult = {
  proofGrade: "active_causal",
  verificationRunId: "vrun_inconclusive",
  assertionIds: [],
  evidenceRefs: [],
  outcome: "inconclusive",
  classification: "infra_failure",
};

async function seedOrg(owner: Pool, orgId: string, projectId: string, digests: readonly string[]): Promise<void> {
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

async function seedRelease(
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

async function latestLiveId(app: Pool, orgId: string, projectId: string): Promise<string | undefined> {
  return runWithOrgScope(app, orgId, async (client) => {
    const live = await ReleaseInstancesStore.latestLive(client, orgId, projectId, PROVIDER, APP_ID);
    return live?.releaseInstanceId;
  });
}
async function stateOf(app: Pool, orgId: string, id: string): Promise<string | undefined> {
  return runWithOrgScope(app, orgId, async (client) => {
    const row = await ReleaseInstancesStore.getById(client, orgId, id);
    return row?.state;
  });
}
async function rolledBackCount(app: Pool, orgId: string, projectId: string, deploymentId: string): Promise<number> {
  return runWithOrgScope(app, orgId, async (client) => {
    const rows = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM events
        WHERE org_id = $1 AND project_id = $2 AND event_type = 'deployment.rolled_back'
          AND payload ->> 'deploymentId' = $3`,
      [orgId, projectId, deploymentId],
    );
    return Number(rows.rows[0]?.n ?? "0");
  });
}
async function promotedCount(app: Pool, orgId: string, projectId: string, deploymentId: string): Promise<number> {
  return runWithOrgScope(app, orgId, async (client) => {
    const rows = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM events
        WHERE org_id = $1 AND project_id = $2 AND event_type = 'deployment.promoted'
          AND payload ->> 'deploymentId' = $3`,
      [orgId, projectId, deploymentId],
    );
    return Number(rows.rows[0]?.n ?? "0");
  });
}

describeDb("rv-19 post-merge re-proof + rollback — real Postgres end-to-end", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let coordinator: PostMergeReproofCoordinator;

  const settle = (input: SettleReproofInput) => coordinator.settle(input);

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, true) });
    await seedOrg(owner, ORG_A, PROJECT_A, [DIGEST_PRIOR, DIGEST_NEW]);
    await seedOrg(owner, ORG_B, PROJECT_B, [DIGEST_B]);
    coordinator = new PostMergeReproofCoordinator({ pool: app });
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
    expect(identity.rows[0]).toEqual({ current_user: APP_USER, rolsuper: false, rolbypassrls: false });
  });

  it("DECISIVE — a FAILED re-proof rolls the live pointer back to the prior known-good release", async () => {
    // Prior good P was superseded when the (since-broken) Q went live carrying previous=P.
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "rb_prior",
      digest: DIGEST_PRIOR,
      state: "superseded",
      previous: null,
    });
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "rb_broken",
      digest: DIGEST_NEW,
      state: "live",
      previous: "rb_prior",
    });
    expect(await latestLiveId(app, ORG_A, PROJECT_A)).toBe("rb_broken");

    const decision = await settle({
      orgId: ORG_A,
      projectId: PROJECT_A,
      releaseInstanceId: "rb_broken",
      result: PRODUCT_FAILURE,
    });
    expect(decision).toBe("rolled_back");

    // The live pointer now returns the PRIOR, not the broken new release.
    expect(await latestLiveId(app, ORG_A, PROJECT_A)).toBe("rb_prior");
    expect(await stateOf(app, ORG_A, "rb_prior")).toBe("live");
    expect(await stateOf(app, ORG_A, "rb_broken")).toBe("superseded");
    expect(await rolledBackCount(app, ORG_A, PROJECT_A, "deployment-rb_broken")).toBe(1);
  });

  it("a PASSED re-proof promotes the proven release (stays live) and records deployment.promoted", async () => {
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "pr_live",
      digest: DIGEST_NEW,
      state: "live",
      previous: null,
      sourceRef: GIT_SHA,
    });
    const decision = await settle({
      orgId: ORG_A,
      projectId: PROJECT_A,
      releaseInstanceId: "pr_live",
      result: PRODUCT_RESOLVED,
    });
    expect(decision).toBe("promoted");
    expect(await stateOf(app, ORG_A, "pr_live")).toBe("live");
    expect(await latestLiveId(app, ORG_A, PROJECT_A)).toBe("pr_live");
    expect(await promotedCount(app, ORG_A, PROJECT_A, "deployment-pr_live")).toBe(1);
  });

  it("fail-closed — an INCONCLUSIVE re-proof neither promotes nor rolls back (release stays live)", async () => {
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "hold_prior",
      digest: DIGEST_PRIOR,
      state: "superseded",
      previous: null,
    });
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "hold_live",
      digest: DIGEST_NEW,
      state: "live",
      previous: "hold_prior",
    });
    const decision = await settle({
      orgId: ORG_A,
      projectId: PROJECT_A,
      releaseInstanceId: "hold_live",
      result: INCONCLUSIVE,
    });
    expect(decision).toBe("held");
    expect(await stateOf(app, ORG_A, "hold_live")).toBe("live");
    expect(await rolledBackCount(app, ORG_A, PROJECT_A, "deployment-hold_live")).toBe(0);
    expect(await promotedCount(app, ORG_A, PROJECT_A, "deployment-hold_live")).toBe(0);
  });

  it("fail-closed — a FAILED re-proof with NO prior release throws LOUD and never silently leaves the broken release live", async () => {
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "np_live",
      digest: DIGEST_NEW,
      state: "live",
      previous: null,
    });
    await expect(
      settle({ orgId: ORG_A, projectId: PROJECT_A, releaseInstanceId: "np_live", result: PRODUCT_FAILURE }),
    ).rejects.toThrow(/no prior known-good release/u);
    // The whole org-scoped transaction rolled back: the release is untouched (still live)
    // and NO rollback was recorded — the failure is LOUD (reclaimable), never a silent leave.
    expect(await stateOf(app, ORG_A, "np_live")).toBe("live");
    expect(await rolledBackCount(app, ORG_A, PROJECT_A, "deployment-np_live")).toBe(0);
  });

  it("idempotent — re-running a rollback after a crash re-decides exactly once", async () => {
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "idem_prior",
      digest: DIGEST_PRIOR,
      state: "superseded",
      previous: null,
    });
    await seedRelease(owner, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      id: "idem_broken",
      digest: DIGEST_NEW,
      state: "live",
      previous: "idem_prior",
    });
    const first = await settle({
      orgId: ORG_A,
      projectId: PROJECT_A,
      releaseInstanceId: "idem_broken",
      result: PRODUCT_FAILURE,
    });
    expect(first).toBe("rolled_back");
    const second = await settle({
      orgId: ORG_A,
      projectId: PROJECT_A,
      releaseInstanceId: "idem_broken",
      result: PRODUCT_FAILURE,
    });
    expect(second).toBe("noop");
    expect(await rolledBackCount(app, ORG_A, PROJECT_A, "deployment-idem_broken")).toBe(1);
    expect(await latestLiveId(app, ORG_A, PROJECT_A)).toBe("idem_prior");
  });

  it("org isolation — another org sees zero of this org's rollback records and release rows", async () => {
    await seedRelease(owner, {
      orgId: ORG_B,
      projectId: PROJECT_B,
      id: "b_live",
      digest: DIGEST_B,
      state: "live",
      previous: null,
    });
    // Org B's scoped read sees zero of org A's deployment.rolled_back events.
    const crossEvents = await runWithOrgScope(app, ORG_B, (client) =>
      client.query("SELECT id FROM events WHERE event_type = 'deployment.rolled_back' AND org_id = $1", [ORG_A]),
    );
    expect(crossEvents.rowCount).toBe(0);
    // And zero of org A's release rows.
    const crossReleases = await runWithOrgScope(app, ORG_B, (client) =>
      client.query("SELECT id FROM release_instances WHERE org_id = $1", [ORG_A]),
    );
    expect(crossReleases.rowCount).toBe(0);
  });
});
