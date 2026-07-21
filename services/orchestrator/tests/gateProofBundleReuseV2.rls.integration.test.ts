import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BatchAuthorityBinding } from "../src/engine/contracts/batchMergeCoordinator.js";
import { driveBatchThroughNode, type BatchNodeDriveFacts } from "../src/engine/merge/batchIntegrationNodeDrive.js";
import { PgGateProofBundleVerifier } from "../src/engine/merge/gateProofBundleVerifyPg.js";
import { PgEventStore, type AppendEventInput, type EventStore } from "../src/engine/eventStore.js";
import { buildCoverageAuthorityReadyNodeMaterializer } from "../src/engine/runtimeVerification/coverageAuthorityMaterializer.js";
import { activeQuarantineVersion, loadActiveQuarantine } from "../src/engine/workflow/ciQuarantine.js";
import { productionV2BatchDriveDeps } from "./helpers/behaviorCoverageProductionBatchDrive.js";
import {
  ReuseV2DiffSubstrate,
  requireReuseV2Pass,
  reuseV2Facts,
  reuseV2Target,
} from "./helpers/gateProofBundleReuseV2Drive.fixtures.js";
import { landReuseV2Binding } from "./helpers/gateProofBundleReuseV2Land.fixtures.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG = "org_gate_reuse_v2";
const PROJECT = "project_gate_reuse_v2";

function databaseName(): string {
  return `tanren_gate_reuse_v2_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function databaseUrl(url: string, database: string, role?: { user: string; password: string }): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (role !== undefined) {
    parsed.username = role.user;
    parsed.password = role.password;
  }
  return parsed.toString();
}

function events(pool: Pool): EventStore {
  return {
    async append(input: AppendEventInput): Promise<void> {
      await runWithOrgScope(pool, input.orgId, (client) => new PgEventStore(client).append(input));
    },
  };
}

describeDb("GateProofBundleV2 proof reuse — RLS fail-closed exactness", () => {
  const database = databaseName();
  const base = "1".repeat(40);
  const memberA = { specId: "spec_reuse_a", runId: "run_reuse_a", branch: "reuse-a", headSha: "2".repeat(40) };
  const memberB = { specId: "spec_reuse_b", runId: "run_reuse_b", branch: "reuse-b", headSha: "3".repeat(40) };
  let owner: Pool;
  let app: Pool;
  let diff: ReuseV2DiffSubstrate;
  let fullGateRuns = 0;
  let v2Deps: Awaited<ReturnType<typeof productionV2BatchDriveDeps>>;
  let drive: (input: BatchNodeDriveFacts) => ReturnType<typeof driveBatchThroughNode>;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: databaseUrl(ADMIN_URL, database) });
    await migrate(owner);
    app = new Pool({
      connectionString: databaseUrl(ADMIN_URL, database, { user: "tanren_app", password: APP_PASSWORD }),
    });
    await seed(owner);
    diff = new ReuseV2DiffSubstrate();
    v2Deps = await productionV2BatchDriveDeps(app, "tanren-local-batch-proof-reuse-v2");
    drive = async (input) =>
      driveBatchThroughNode(input, {
        ...v2Deps,
        eventStore: events(app),
        jjWorkspaceDeps: { ssh: diff } as never,
        gate: async (live) => {
          fullGateRuns += 1;
          return v2Deps.gate(live);
        },
        integrate: async (_deps, _input, continuation) => ({
          outcome: "integrated",
          value: await continuation({ target: reuseV2Target, workspacePath: "/workspace/gate-reuse-v2" } as never, {
            outcome: "integrated",
            localRef: "tanren-local-batch-proof-reuse-v2",
            baseSha: input.baseSha,
            headSha: input.headSha,
            treeHash: input.treeHash,
            memberHeadShas: Object.fromEntries(input.members.map((member) => [member.specId, member.headSha])),
          }),
        }),
        materializeReadyNode: buildCoverageAuthorityReadyNodeMaterializer(app),
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

  it("reuses only an exact sealed V2 proof, re-runs for every drift, and lands under the fresh proof", async () => {
    const quarantineV1 = await currentQuarantineVersion(app);
    const original = reuseV2Facts({
      baseSha: base,
      headSha: "4".repeat(40),
      treeHash: "5".repeat(40),
      members: [memberA, memberB],
      quarantineVersion: quarantineV1,
    });
    const first = await requireReuseV2Pass(drive(original));
    expect(fullGateRuns).toBe(1);
    const exact = await requireReuseV2Pass(drive(original));
    expect(fullGateRuns).toBe(1);
    expect(exact.proof.gateProofBundleId).toBe(first.proof.gateProofBundleId);
    const reused = await owner.query<{ payload: { gateProofBundleId: string } }>(
      "SELECT payload FROM events WHERE org_id = $1 AND event_type = 'integration.proof.reused'",
      [ORG],
    );
    expect(reused.rows.some((row) => row.payload.gateProofBundleId === first.proof.gateProofBundleId)).toBe(true);

    await bumpQuarantine(app);
    const quarantineV2 = await currentQuarantineVersion(app);
    expect(quarantineV2).not.toBe(quarantineV1);
    const quarantineDrift = await requireReuseV2Pass(drive({ ...original, quarantineVersion: quarantineV2 }));
    expect(fullGateRuns).toBe(2);
    expect(quarantineDrift.proof.proofBundleDigest).not.toBe(first.proof.proofBundleDigest);

    const baseDrift = await requireReuseV2Pass(
      drive(
        reuseV2Facts({
          baseSha: "6".repeat(40),
          headSha: "7".repeat(40),
          treeHash: "8".repeat(40),
          members: [memberA, memberB],
          quarantineVersion: quarantineV2,
        }),
      ),
    );
    expect(fullGateRuns).toBe(3);

    await changeOneSealedSectionDigest(app, quarantineDrift);
    const sectionDrift = await requireReuseV2Pass(drive({ ...original, quarantineVersion: quarantineV2 }));
    expect(fullGateRuns).toBe(4);
    expect(sectionDrift.proof.proofBundleDigest).not.toBe(quarantineDrift.proof.proofBundleDigest);

    const memberRemoved = await requireReuseV2Pass(
      drive(
        reuseV2Facts({
          baseSha: "6".repeat(40),
          headSha: "9".repeat(40),
          treeHash: "a".repeat(40),
          members: [memberA],
          quarantineVersion: quarantineV2,
        }),
      ),
    );
    expect(fullGateRuns).toBe(5);

    await landReuseV2Binding(app, memberRemoved, new PgGateProofBundleVerifier(app, v2Deps.proofSubstrate));
    const outcome = await owner.query<{
      gate_proof_bundle_id: string;
      proof_bundle_digest: string;
      quarantine_version: string;
      base_sha: string;
      head_sha: string;
    }>(
      `SELECT gate_proof_bundle_id, proof_bundle_digest, quarantine_version, base_sha, head_sha
         FROM merge_runtime_outcomes WHERE org_id = $1 AND result = 'landed'`,
      [ORG],
    );
    expect(outcome.rows).toEqual([
      expect.objectContaining({
        gate_proof_bundle_id: memberRemoved.proof.gateProofBundleId,
        proof_bundle_digest: memberRemoved.proof.proofBundleDigest,
        quarantine_version: memberRemoved.proof.keyInput.quarantineVersion,
        base_sha: memberRemoved.baseSha,
        head_sha: memberRemoved.headSha,
      }),
    ]);
    const runtimeEvent = await owner.query(
      "SELECT 1 FROM events WHERE org_id = $1 AND event_type = 'merge.runtime_outcome.recorded'",
      [ORG],
    );
    expect(runtimeEvent.rowCount).toBe(1);
    expect(baseDrift.proof.proofBundleDigest).not.toBe(memberRemoved.proof.proofBundleDigest);
  });
});

async function changeOneSealedSectionDigest(pool: Pool, binding: BatchAuthorityBinding): Promise<void> {
  await runWithOrgScope(pool, ORG, async (client) => {
    const changed = await client.query<{ proof_unit_digest: string }>(
      `SELECT bu.proof_unit_digest
         FROM proof_bundle_units bu
         JOIN proof_bundles b ON b.org_id = bu.org_id AND b.id = bu.bundle_id
        WHERE bu.org_id = $1 AND b.prepared_head_sha <> $2
        ORDER BY bu.bundle_id, bu.ordinal
        LIMIT 1`,
      [ORG, binding.headSha],
    );
    const digest = changed.rows[0]?.proof_unit_digest;
    if (digest === undefined) throw new Error("section-digest drift control has no alternate sealed proof unit");
    const current = await client.query<{ proof_bundle_id: string }>(
      "SELECT proof_bundle_id FROM gate_proof_bundles WHERE org_id = $1 AND id = $2",
      [ORG, binding.proof.gateProofBundleId],
    );
    const proofBundleId = current.rows[0]?.proof_bundle_id;
    if (proofBundleId === undefined) throw new Error("section-digest drift control has no current V2 proof bundle");
    await client.query(
      `INSERT INTO proof_bundle_units (org_id, id, project_id, bundle_id, proof_unit_digest, ordinal)
       VALUES ($1, $2, $3, $4, $5, 99)`,
      [ORG, `section-drift:${binding.proof.gateProofBundleId}`, PROJECT, proofBundleId, digest],
    );
    const updated = await client.query(
      `UPDATE gate_proof_bundle_sections
          SET proof_unit_digest = $3
        WHERE org_id = $1 AND gate_proof_bundle_id = $2 AND ordinal = 0`,
      [ORG, binding.proof.gateProofBundleId, digest],
    );
    if (updated.rowCount !== 1) throw new Error("section-digest drift control did not change exactly one V2 section");
  });
}

async function currentQuarantineVersion(pool: Pool): Promise<string> {
  return runWithOrgScope(pool, ORG, async (client) =>
    activeQuarantineVersion(await loadActiveQuarantine(client, PROJECT)),
  );
}

async function bumpQuarantine(pool: Pool): Promise<void> {
  await runWithOrgScope(pool, ORG, (client) =>
    client.query(
      `INSERT INTO quarantined_tests
         (id, project_id, check_name, test_id, toggled_sha_count, observation_count, evidence)
       VALUES ($1, $2, 'proof_reuse_v2', 'proof-reuse-v2-quarantine-bump', 1, 1, $3::jsonb)`,
      ["proof-reuse-v2-quarantine-bump", PROJECT, JSON.stringify({ reason: "V2 reuse negative control" })],
    ),
  );
}

async function seed(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [ORG],
  );
  await pool.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, 'gate reuse v2', 'https://example.test/tanren/gate-reuse-v2.git', 'main', 'runner:v0', $2, '{"version":1}'::jsonb)`,
    [PROJECT, ORG],
  );
  for (const member of [
    { ...memberASeed(), taskId: "task_merge_reuse_a" },
    { specId: "spec_reuse_b", runId: "run_reuse_b", taskId: "task_merge_reuse_b" },
  ]) {
    await pool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, acceptance_criteria, status)
       VALUES ($1, $2, $3, $1, 'gate-reuse v2', '[]'::jsonb, 'in_flight')`,
      [member.specId, PROJECT, ORG],
    );
    await pool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'cli', $2, 'completed')`,
      [member.runId, member.specId, PROJECT, ORG],
    );
    await pool.query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
       VALUES ($1, $2, $3, 'merge', 'merge', 'queued', 'answerer', 'test', 'test')`,
      [member.taskId, member.runId, ORG],
    );
  }
}

function memberASeed() {
  return { specId: "spec_reuse_a", runId: "run_reuse_a" };
}
