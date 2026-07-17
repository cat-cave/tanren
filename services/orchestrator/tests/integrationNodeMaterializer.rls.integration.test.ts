// MQ-11: self-provisioning restricted-role proof that an authorized jj subset
// materializes only in its tenant and that assembly faults remain durable events.

import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPgIntegrationNodeMaterializer } from "../src/engine/merge/integrationNodeMaterializer.js";
import { InMemoryWorkspaceVcsCore } from "./conformance/fakes/inMemoryWorkspaceVcsCore.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const adminUrl = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const appPassword = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_mq11_a";
const ORG_B = "org_mq11_b";
const PROJECT_A = "project_mq11_a";
const PROJECT_B = "project_mq11_b";

function databaseName(): string {
  return `tanren_mq11_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

function databaseUrl(database: string, app = false): string {
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${database}`;
  if (app) {
    parsed.username = "tanren_app";
    parsed.password = appPassword;
  }
  return parsed.toString();
}

async function seedTenant(owner: Pool, orgId: string, projectId: string): Promise<void> {
  const suffix = orgId.slice(-1);
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await owner.query(
    "INSERT INTO projects (project_id, name, repo_url, org_id) VALUES ($1, $1, 'https://example.test/mq11.git', $2)",
    [projectId, orgId],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, $1, $1, 'in_flight')`,
    [`spec_mq11_${suffix}`, projectId, orgId],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'feature/mq11', 'running')`,
    [`run_mq11_${suffix}`, `spec_mq11_${suffix}`, projectId, orgId],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, $1, $1, 'in_flight')`,
    [`spec_mq11_${suffix}_second`, projectId, orgId],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'feature/mq11-second', 'running')`,
    [`run_mq11_${suffix}_second`, `spec_mq11_${suffix}_second`, projectId, orgId],
  );
}

describeDb("MQ-11 IntegrationNodeMaterializer — tanren_app RLS", () => {
  const database = databaseName();
  let owner: Pool;
  let runtime: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: adminUrl });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: databaseUrl(database) });
    await migrate(owner);
    runtime = new Pool({ connectionString: databaseUrl(database, true) });
    await seedTenant(owner, ORG_A, PROJECT_A);
    await seedTenant(owner, ORG_B, PROJECT_B);
  }, 60_000);

  afterAll(async () => {
    await runtime?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: adminUrl });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("persists the exact authorized subset as tanren_app and does not expose it to another org", async () => {
    const baseSha = "a".repeat(40);
    const memberA = "b".repeat(40);
    const memberB = "c".repeat(40);
    const workspace = new InMemoryWorkspaceVcsCore();
    workspace.seedRemoteRef("main", baseSha);
    workspace.seedRemoteRef("feature/a", memberA);
    workspace.seedRemoteRef("feature/b", memberB);
    const materializer = buildPgIntegrationNodeMaterializer(runtime, workspace);

    const materialized = await materializer.materialize({
      orgId: ORG_A,
      projectId: PROJECT_A,
      repoUrl: "https://example.test/mq11.git",
      baseBranch: "main",
      baseSha,
      members: [
        { specId: "spec_mq11_a", runId: "run_mq11_a", branch: "feature/a", headSha: memberA },
        {
          specId: "spec_mq11_a_second",
          runId: "run_mq11_a_second",
          branch: "feature/b",
          headSha: memberB,
        },
      ],
      localRef: "tanren-local-mq11-a",
      workspacePath: "/scratch/mq11-a",
      gateConfigHash: "gate-mq11",
      policyVersion: "policy-mq11",
    });

    expect(materialized).toMatchObject({ kind: "materialized", baseSha });
    if (materialized.kind !== "materialized") return;
    await runWithOrgScope(runtime, ORG_A, async (client) => {
      const role = await client.query<{ current_user: string }>("SELECT current_user");
      expect(role.rows[0]?.current_user).toBe("tanren_app");
      const node = await client.query<{
        org_id: string;
        project_id: string;
        base_sha: string;
        head_sha: string;
        tree_hash: string;
        status: string;
      }>(
        `SELECT org_id, project_id, base_sha, head_sha, tree_hash, status
           FROM integration_nodes WHERE node_id = $1`,
        [materialized.nodeId],
      );
      expect(node.rows).toEqual([
        {
          org_id: ORG_A,
          project_id: PROJECT_A,
          base_sha: baseSha,
          head_sha: materialized.headSha,
          tree_hash: materialized.treeHash,
          status: "building",
        },
      ]);
      const event = await client.query<{ event_type: string }>(
        "SELECT event_type FROM events WHERE project_id = $1 ORDER BY id",
        [PROJECT_A],
      );
      expect(event.rows).toEqual([{ event_type: "integration.node.materialized" }]);
    });
    await runWithOrgScope(runtime, ORG_B, async (client) => {
      const nodes = await client.query("SELECT node_id FROM integration_nodes WHERE project_id = $1", [PROJECT_A]);
      const events = await client.query("SELECT id FROM events WHERE project_id = $1", [PROJECT_A]);
      expect(nodes.rows).toEqual([]);
      expect(events.rows).toEqual([]);
    });
  });

  it("emits materialization_failed for a jj conflict instead of silently skipping the fault", async () => {
    const workspace = new InMemoryWorkspaceVcsCore();
    workspace.seedRemoteRef("main", "d".repeat(40));
    workspace.seedRemoteRef("feature/conflict", "conflict-member");
    const materializer = buildPgIntegrationNodeMaterializer(runtime, workspace);

    const result = await materializer.materialize({
      orgId: ORG_A,
      projectId: PROJECT_A,
      repoUrl: "https://example.test/mq11.git",
      baseBranch: "main",
      baseSha: "d".repeat(40),
      members: [
        {
          specId: "spec_mq11_a",
          runId: "run_mq11_a",
          branch: "feature/conflict",
          headSha: "e".repeat(40),
        },
      ],
      localRef: "tanren-local-mq11-conflict",
      workspacePath: "/scratch/mq11-conflict",
    });

    expect(result).toMatchObject({ kind: "failed", failureCode: "jj_conflict" });
    await runWithOrgScope(runtime, ORG_A, async (client) => {
      const failed = await client.query<{ event_type: string; payload: { failureCode: string } }>(
        `SELECT event_type, payload FROM events
          WHERE project_id = $1 AND event_type = 'integration.node.materialization_failed'
            AND payload->>'baseSha' = $2`,
        [PROJECT_A, "d".repeat(40)],
      );
      expect(failed.rows).toEqual([
        {
          event_type: "integration.node.materialization_failed",
          payload: expect.objectContaining({ failureCode: "jj_conflict" }),
        },
      ]);
    });
  });
});
