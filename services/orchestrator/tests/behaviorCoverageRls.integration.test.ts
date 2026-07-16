// RV4-BEHAVIOR-COVERAGE-RLS — real-Postgres proof for the canonical 0037 table
// and rv-4 repository. The restricted runtime role must deny cross-org and
// unscoped reads/writes, while repository reads preserve exact project and
// integration-node bindings within one org. The 0044 composite project FK is
// added to this proof only after the serialized migration lease is released.

import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BehaviorRevisionId } from "../src/engine/contracts/behaviorRevision.js";
import { BehaviorCoverageEdgesStore } from "../src/engine/repositories/behaviorCoverageEdges.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_rv4_a";
const ORG_B = "org_rv4_b";
const PROJECT_A = "project_rv4_a";
const PROJECT_A2 = "project_rv4_a2";
const PROJECT_B = "project_rv4_b";
const BEHAVIOR_A = "behavior_revision_rv4_a" as BehaviorRevisionId;
const BEHAVIOR_B = "behavior_revision_rv4_b" as BehaviorRevisionId;
const ORG_BEHAVIOR_A = "behavior_revision_rv4_org_a" as BehaviorRevisionId;
const NODE_A = "integration_node_rv4_a";

function databaseName(): string {
  return `tanren_rv4_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function connectionUrl(url: string, database: string, role?: { user: string; password: string }): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (role !== undefined) {
    parsed.username = role.user;
    parsed.password = role.password;
  }
  return parsed.toString();
}

describeDb("RV4-BEHAVIOR-COVERAGE-RLS — org and project isolation", () => {
  const database = databaseName();
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();
    ownerPool = new Pool({ connectionString: connectionUrl(ADMIN_URL, database) });
    await migrate(ownerPool);
    runtimePool = new Pool({
      connectionString: connectionUrl(ADMIN_URL, database, {
        user: RUNTIME_ROLE,
        password: RUNTIME_PASSWORD,
      }),
    });

    await seedOrg(ownerPool, ORG_A, [PROJECT_A, PROJECT_A2]);
    await seedOrg(ownerPool, ORG_B, [PROJECT_B]);
    await seedBehavior(ownerPool, ORG_A, PROJECT_A, "persona_rv4_a", BEHAVIOR_A);
    await seedBehavior(ownerPool, ORG_B, PROJECT_B, "persona_rv4_b", BEHAVIOR_B);
    await seedBehavior(ownerPool, ORG_A, null, "persona_rv4_org_a", ORG_BEHAVIOR_A);
    await seedIntegrationNode(ownerPool, ORG_A, PROJECT_A, NODE_A);
    await runWithOrgScope(runtimePool, ORG_B, (client) =>
      BehaviorCoverageEdgesStore.record(
        client,
        { orgId: ORG_B, projectId: PROJECT_B },
        { behaviorRevisionId: BEHAVIOR_B, kind: "source", targetRef: "src/login.ts" },
      ),
    );
  }, 60_000);

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("round-trips canonical edges under the exact org/project scope", async () => {
    await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      const source = await BehaviorCoverageEdgesStore.record(
        client,
        { orgId: ORG_A, projectId: PROJECT_A },
        { behaviorRevisionId: BEHAVIOR_A, kind: "source", targetRef: "src/login.ts" },
      );
      const dependency = await BehaviorCoverageEdgesStore.record(
        client,
        { orgId: ORG_A, projectId: PROJECT_A },
        { behaviorRevisionId: BEHAVIOR_A, kind: "dependency", targetRef: ORG_BEHAVIOR_A },
      );
      const snapshot = await BehaviorCoverageEdgesStore.readSnapshot(client, {
        orgId: ORG_A,
        projectId: PROJECT_A,
      });
      expect(snapshot.behaviors.map((behavior) => behavior.behaviorRevisionId)).toEqual([BEHAVIOR_A, ORG_BEHAVIOR_A]);
      expect(snapshot.behaviors[0]?.edges.map((edge) => edge.id)).toEqual([dependency.id, source.id]);
      expect(snapshot.behaviors.map((behavior) => behavior.contentDigest)).toEqual([
        `sha256:${"2".repeat(64)}`,
        `sha256:${"2".repeat(64)}`,
      ]);
      expect(snapshot.behaviors[1]?.edges).toEqual([]);
    });
  });

  it("binds the graph to the exact ready integration node identity", async () => {
    const bound = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      BehaviorCoverageEdgesStore.readBoundSnapshot(client, { orgId: ORG_A, projectId: PROJECT_A }, NODE_A),
    );
    expect(bound.binding).toEqual({
      integrationNodeId: NODE_A,
      baseSha: "a".repeat(40),
      preparedHeadSha: "a".repeat(40),
      treeHash: "tree_rv4_a",
      memberKey: "b".repeat(64),
    });
    expect(bound.authorityFingerprint).toBe("");
    expect(bound.snapshot.orgId).toBe(ORG_A);
    expect(bound.snapshot.projectId).toBe(PROJECT_A);
  });

  it("does not leak project edges into a second project in the same org", async () => {
    const snapshot = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      BehaviorCoverageEdgesStore.readSnapshot(client, { orgId: ORG_A, projectId: PROJECT_A2 }),
    );
    expect(snapshot.behaviors.map((behavior) => behavior.behaviorRevisionId)).toEqual([ORG_BEHAVIOR_A]);
    expect(snapshot.behaviors[0]?.edges).toEqual([]);
  });

  it("denies cross-org and unscoped reads instead of returning foreign facts", async () => {
    const crossOrg = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      BehaviorCoverageEdgesStore.readSnapshot(client, { orgId: ORG_B, projectId: PROJECT_B }),
    );
    expect(crossOrg.behaviors).toEqual([]);

    const ownOrgB = await runWithOrgScope(runtimePool, ORG_B, (client) =>
      BehaviorCoverageEdgesStore.readSnapshot(client, { orgId: ORG_B, projectId: PROJECT_B }),
    );
    expect(ownOrgB.behaviors[0]?.edges[0]?.targetRef).toBe("src/login.ts");

    const unscoped = await BehaviorCoverageEdgesStore.readSnapshot(runtimePool, {
      orgId: ORG_A,
      projectId: PROJECT_A,
    });
    expect(unscoped.behaviors).toEqual([]);
  });

  it("rejects a cross-org edge insert through FORCE RLS WITH CHECK", async () => {
    await expect(
      runWithOrgScope(runtimePool, ORG_A, (client) =>
        client.query(
          `INSERT INTO behavior_coverage_edges
             (org_id, id, project_id, behavior_revision_id, edge_kind, target_ref)
           VALUES ($1, 'coverage_edge_cross_org', $2, $3, 'source', 'src/leak.ts')`,
          [ORG_B, PROJECT_B, BEHAVIOR_B],
        ),
      ),
    ).rejects.toThrow(/row-level security|policy/iu);
    const rows = await ownerPool.query("SELECT id FROM behavior_coverage_edges WHERE id = 'coverage_edge_cross_org'");
    expect(rows.rowCount).toBe(0);
  });
});

async function seedOrg(owner: Pool, orgId: string, projects: readonly string[]): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  for (const projectId of projects) {
    await owner.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id)
       VALUES ($1, $1, 'https://example.com/fixture.git', $2)`,
      [projectId, orgId],
    );
  }
}

async function seedIntegrationNode(owner: Pool, orgId: string, projectId: string, nodeId: string): Promise<void> {
  await owner.query(
    `INSERT INTO integration_nodes
       (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, members,
        member_key, head_sha, tree_hash, status)
     VALUES ($1, $2, $3, 'main', $4, 'refs/tanren/rv4', 'merge_batch', '[]'::jsonb,
             $5, $4, 'tree_rv4_a', 'ready')`,
    [nodeId, projectId, orgId, "a".repeat(40), "b".repeat(64)],
  );
}

async function seedBehavior(
  owner: Pool,
  orgId: string,
  projectId: string | null,
  personaId: string,
  behaviorRevisionId: BehaviorRevisionId,
): Promise<void> {
  const scope = projectId === null ? "org" : "project";
  await owner.query(
    `INSERT INTO persona_revisions
       (id, org_id, project_id, persona_id, scope, revision_number, name, description,
        content_digest, authoring_provenance)
     VALUES ($1, $2, $3, $1, $4, 1, $1, 'rv-4 proof', $5, '{}'::jsonb)`,
    [personaId, orgId, projectId, scope, `sha256:${"1".repeat(64)}`],
  );
  await owner.query(
    `INSERT INTO behavior_revisions
       (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title,
        given, "when", "then", content_digest, authoring_provenance)
     VALUES ($1, $2, $3, $1, $4, 1, $1, 'given', 'when', 'then', $5, '{}'::jsonb)`,
    [behaviorRevisionId, orgId, projectId, personaId, `sha256:${"2".repeat(64)}`],
  );
}
