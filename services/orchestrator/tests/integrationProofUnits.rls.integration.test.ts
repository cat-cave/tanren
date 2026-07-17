import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IntegrationProofUnitGraph } from "../src/engine/dag/integrationProofUnits.js";
import { PgEventStore, type AppendEventInput, type EventStore } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import {
  PgIntegrationProofUnitRepository,
  proofUnitReuseInputHash,
} from "../src/engine/repositories/integrationProofUnits.js";
import { createInMemoryIntegrationProofUnitStore } from "./conformance/fakes/inMemoryMergeQueue.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const adminUrl = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const appPassword = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_mq6_a";
const ORG_B = "org_mq6_b";
const PROJECT_A = "project_mq6_a";
const PROJECT_B = "project_mq6_b";
const hash = (letter: string): string => `sha256:${letter.repeat(64)}`;
type ReusedUnitRun = () => Promise<{ verdict: "fail" }>;

class ScopedEvents implements EventStore {
  constructor(private readonly pool: Pool) {}
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, (client) => new PgEventStore(client).append(input));
  }
}

function databaseName(): string {
  return `tanren_mq6_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
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

async function seed(owner: Pool, orgId: string, projectId: string, nodeId: string): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await owner.query(
    "INSERT INTO projects (project_id, name, repo_url, org_id) VALUES ($1, $1, 'https://example.test/mq6.git', $2)",
    [projectId, orgId],
  );
  await owner.query(
    `INSERT INTO integration_nodes
       (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, members, member_key,
        gate_config_hash, policy_version, affected_fingerprint, status)
     VALUES ($1,$2,$3,'main',$4,'tanren-local-mq6','merge_batch','[]'::jsonb,$5,'gate','policy','affected','ready')`,
    [nodeId, projectId, orgId, "a".repeat(40), `${orgId}_member_key`],
  );
}

describeDb("MQ-6 integration proof units — tanren_app RLS", () => {
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
    await seed(owner, ORG_A, PROJECT_A, "inode_mq6_a");
    await seed(owner, ORG_B, PROJECT_B, "inode_mq6_b");
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

  it("records immutable per-unit evidence, composes a root, and hides all proof rows from another org", async () => {
    const graph = new IntegrationProofUnitGraph(
      new PgIntegrationProofUnitRepository(runtime),
      new ScopedEvents(runtime),
    );
    const result = await graph.evaluate({
      orgId: ORG_A,
      projectId: PROJECT_A,
      nodeId: "inode_mq6_a",
      evaluationId: "eval_mq6_a",
      quarantineEpoch: 4,
      toolchainHash: hash("a"),
      designContractVersion: "design-v4",
      behaviorManifestHash: hash("b"),
      units: [
        {
          key: "tier",
          kind: "native_ci_tier",
          subjectId: "pre_merge",
          inputHash: hash("c"),
          run: async () => ({ verdict: "pass", artifactHash: hash("d") }),
        },
        {
          key: "step",
          kind: "native_ci_step",
          subjectId: "typecheck",
          inputHash: hash("e"),
          dependsOn: ["tier"],
          run: async () => ({ verdict: "pass" }),
        },
      ],
    });
    expect(result.units).toHaveLength(2);

    const reusedTierRun = vi.fn<ReusedUnitRun>(async () => ({ verdict: "fail" }));
    const reusedStepRun = vi.fn<ReusedUnitRun>(async () => ({ verdict: "fail" }));
    const reused = await graph.evaluate({
      orgId: ORG_A,
      projectId: PROJECT_A,
      nodeId: "inode_mq6_a",
      evaluationId: "eval_mq6_a_reuse",
      quarantineEpoch: 4,
      toolchainHash: hash("a"),
      designContractVersion: "design-v4",
      behaviorManifestHash: hash("b"),
      units: [
        {
          key: "tier",
          kind: "native_ci_tier",
          subjectId: "pre_merge",
          inputHash: hash("c"),
          run: reusedTierRun,
        },
        {
          key: "step",
          kind: "native_ci_step",
          subjectId: "typecheck",
          inputHash: hash("e"),
          dependsOn: ["tier"],
          run: reusedStepRun,
        },
      ],
    });
    expect(reusedTierRun).not.toHaveBeenCalled();
    expect(reusedStepRun).not.toHaveBeenCalled();
    expect(reused.units.every((unit) => unit.reused)).toBe(true);

    const invalidated = await graph.evaluate({
      orgId: ORG_A,
      projectId: PROJECT_A,
      nodeId: "inode_mq6_a",
      evaluationId: "eval_mq6_a_epoch_5",
      quarantineEpoch: 5,
      toolchainHash: hash("a"),
      designContractVersion: "design-v4",
      behaviorManifestHash: hash("b"),
      units: [
        {
          key: "tier",
          kind: "native_ci_tier",
          subjectId: "pre_merge",
          inputHash: hash("c"),
          run: async () => ({ verdict: "pass" as const, artifactHash: hash("d") }),
        },
      ],
    });

    await runWithOrgScope(runtime, ORG_A, async (client) => {
      const role = await client.query<{ current_user: string }>("SELECT current_user");
      expect(role.rows[0]?.current_user).toBe("tanren_app");
      const units = await client.query("SELECT proof_unit_id FROM integration_proof_units WHERE project_id = $1", [
        PROJECT_A,
      ]);
      const edges = await client.query("SELECT parent_unit_id FROM integration_proof_edges WHERE project_id = $1", [
        PROJECT_A,
      ]);
      const node = await client.query<{ proof_root: string; quarantine_epoch: number }>(
        "SELECT proof_root, quarantine_epoch FROM integration_nodes WHERE node_id = $1",
        ["inode_mq6_a"],
      );
      const events = await client.query<{ event_type: string }>(
        "SELECT event_type FROM events WHERE project_id = $1 ORDER BY id",
        [PROJECT_A],
      );
      expect(units.rowCount).toBe(3);
      expect(edges.rowCount).toBe(1);
      expect(node.rows).toEqual([{ proof_root: invalidated.proofRoot, quarantine_epoch: 5 }]);
      expect(events.rows.map((row) => row.event_type)).toEqual(
        expect.arrayContaining([
          "integration.proof_unit.recorded",
          "integration.proof_unit.reused",
          "integration.proof_root.composed",
          "integration.proof.invalidated",
        ]),
      );
    });
    await runWithOrgScope(runtime, ORG_A, async (client) => {
      await expect(
        client.query("UPDATE integration_proof_units SET verdict = 'fail' WHERE project_id = $1", [PROJECT_A]),
      ).rejects.toThrow(/immutable/u);
    });
    await runWithOrgScope(runtime, ORG_A, async (client) => {
      await expect(
        client.query("DELETE FROM integration_proof_edges WHERE project_id = $1", [PROJECT_A]),
      ).rejects.toThrow(/immutable/u);
    });
    await runWithOrgScope(runtime, ORG_A, async (client) => {
      await expect(
        client.query("UPDATE integration_evaluation_proofs SET evaluation_id = 'mutated' WHERE project_id = $1", [
          PROJECT_A,
        ]),
      ).rejects.toThrow(/immutable/u);
    });
    await runWithOrgScope(runtime, ORG_A, async (client) => {
      await expect(
        client.query("DELETE FROM integration_evaluation_proofs WHERE project_id = $1", [PROJECT_A]),
      ).rejects.toThrow(/immutable/u);
    });
    await runWithOrgScope(runtime, ORG_B, async (client) => {
      const units = await client.query("SELECT proof_unit_id FROM integration_proof_units WHERE project_id = $1", [
        PROJECT_A,
      ]);
      const edges = await client.query("SELECT parent_unit_id FROM integration_proof_edges WHERE project_id = $1", [
        PROJECT_A,
      ]);
      const evaluations = await client.query(
        "SELECT evaluation_id FROM integration_evaluation_proofs WHERE project_id = $1",
        [PROJECT_A],
      );
      const events = await client.query("SELECT id FROM events WHERE project_id = $1", [PROJECT_A]);
      expect(units.rows).toEqual([]);
      expect(edges.rows).toEqual([]);
      expect(evaluations.rows).toEqual([]);
      expect(events.rows).toEqual([]);
    });
  });

  it("matches the in-memory repository's newest reusable proof-unit selection and SQL tie-break", async () => {
    const input = {
      orgId: ORG_A,
      projectId: PROJECT_A,
      kind: "native_ci_tier",
      subjectId: "conformance",
      inputHash: hash("f"),
      quarantineEpoch: 9,
      toolchainHash: hash("a"),
      designContractVersion: "design-v4",
      behaviorManifestHash: hash("b"),
    };
    const reuseInputHash = proofUnitReuseInputHash(input);
    const fake = createInMemoryIntegrationProofUnitStore();
    const rows = [
      { proofUnitId: "punit_a", createdAt: new Date("2026-01-02T00:00:00.000Z") },
      { proofUnitId: "punit_z", createdAt: new Date("2026-01-02T00:00:00.000Z") },
    ];
    for (const row of rows) {
      fake.db.integrationProofUnits.push({
        org_id: ORG_A,
        project_id: PROJECT_A,
        proof_unit_id: row.proofUnitId,
        kind: input.kind,
        subject_id: input.subjectId,
        input_hash: reuseInputHash,
        verdict: "pass",
        artifact_hash: null,
        source_node_id: null,
        quarantine_epoch: input.quarantineEpoch,
        expires_at: null,
        created_at: row.createdAt,
      });
      await runWithOrgScope(runtime, ORG_A, (client) =>
        client.query(
          `INSERT INTO integration_proof_units
             (org_id, project_id, proof_unit_id, kind, subject_id, input_hash, verdict, quarantine_epoch, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,'pass',$7,$8)`,
          [
            ORG_A,
            PROJECT_A,
            row.proofUnitId,
            input.kind,
            input.subjectId,
            reuseInputHash,
            input.quarantineEpoch,
            row.createdAt,
          ],
        ),
      );
    }
    const real = new PgIntegrationProofUnitRepository(runtime);
    const [realResult, fakeResult] = await Promise.all([real.findReusable(input), fake.findReusable(input)]);
    expect(realResult?.proofUnitId).toBe("punit_z");
    expect(fakeResult?.proofUnitId).toBe("punit_z");
  });
});
