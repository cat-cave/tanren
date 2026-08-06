// gv-17 real-Postgres lineage: dual-write members, base-shift history, and the
// required negative control that a deleted/reordered member row fails closed so
// land revalidation never authorizes CodeHost.landAuthorizedIntegration.

import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memberKey } from "../src/engine/contracts/integrationNodes.js";
import type { IntegrationNodeMember } from "../src/engine/contracts/integrationNodes.js";
import { PgBaseShiftOperationStore } from "../src/engine/dag/baseShiftOperationsPg.js";
import { MemberLineageDivergenceError } from "../src/engine/dag/integrationNodeLineage.js";
import { PgIntegrationNodeModel, upsertIntegrationNodeOnClient } from "../src/engine/dag/integrationNodesPg.js";
import type { BatchAuthorityBinding } from "../src/engine/contracts/batchMergeCoordinator.js";
import type { LandBindingEnvelope } from "../src/engine/contracts/mergeAuthority.js";
import { IntegrationNodeMaterializer } from "../src/engine/merge/integrationNodeMaterializer.js";
import { PgExactBatchBindingRevalidator } from "../src/engine/merge/multiMemberAuthorityPgAuthority.js";
import { InMemoryWorkspaceVcsCore } from "./conformance/fakes/inMemoryWorkspaceVcsCore.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const adminUrl = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const appPassword = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG = "org_gv17_lineage";
const PROJECT = "project_gv17_lineage";
const BASE_SHA = "a".repeat(40);

function databaseName(): string {
  return `tanren_gv17_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
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

function sixMembers(): IntegrationNodeMember[] {
  return Array.from({ length: 6 }, (_, index) => {
    const n = index + 1;
    return {
      specId: `spec_gv17_${n}`,
      runId: `run_gv17_${n}`,
      branch: `feature/gv17-${n}`,
      headSha: String(n).repeat(40),
    };
  });
}

async function seedTenant(owner: Pool): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [ORG],
  );
  await owner.query(
    "INSERT INTO projects (project_id, name, repo_url, org_id) VALUES ($1, $1, 'https://example.test/gv17.git', $2)",
    [PROJECT, ORG],
  );
  for (const member of sixMembers()) {
    await owner.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, $1, $1, 'in_flight')`,
      [member.specId, PROJECT, ORG],
    );
    await owner.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'cli', $5, 'running')`,
      [member.runId, member.specId, PROJECT, ORG, member.branch],
    );
  }
}

describeDb("gv-17 authoritative integration-node lineage (real Postgres)", () => {
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
    await seedTenant(owner);
  }, 120_000);

  afterAll(async () => {
    await runtime?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: adminUrl });
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  });

  it("dual-writes six ordered members, records a base shift, and rejects deleted/reordered members (no land)", async () => {
    const members = sixMembers();
    const model = new PgIntegrationNodeModel(runtime);
    const key = memberKey(
      BASE_SHA,
      members.map((m) => m.headSha),
    );

    const nodeId = await model.upsertNode({
      orgId: ORG,
      projectId: PROJECT,
      baseBranch: "main",
      baseSha: BASE_SHA,
      ref: "tanren-local-gv17",
      purpose: "merge_batch",
      members,
      gateConfigHash: "gate-v1",
      policyVersion: "policy-v1",
      headSha: "f".repeat(40),
      treeHash: "e".repeat(40),
      status: "ready",
    });

    const loaded = await model.findByMemberKey(ORG, key);
    expect(loaded?.nodeId).toBe(nodeId);
    expect(loaded?.members.map((m) => m.runId)).toEqual(members.map((m) => m.runId));

    const rowCount = await runWithOrgScope(runtime, ORG, async (client) => {
      const result = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM integration_node_members WHERE node_id = $1`,
        [nodeId],
      );
      return Number(result.rows[0]?.n ?? 0);
    });
    expect(rowCount).toBe(6);

    // Base-shift history: ancestor lands → restack with a shortened member vector.
    const afterMembers = members.slice(1);
    const afterKey = memberKey(
      "b".repeat(40),
      afterMembers.map((m) => m.headSha),
    );
    const shifts = new PgBaseShiftOperationStore(runtime);
    await shifts.record({
      orgId: ORG,
      projectId: PROJECT,
      nodeId,
      dependentRunId: members[5]!.runId,
      dependentSpecId: members[5]!.specId,
      ancestorSpecId: members[0]!.specId,
      fromBaseSha: BASE_SHA,
      toBaseSha: "b".repeat(40),
      fromMemberKey: key,
      toMemberKey: afterKey,
      fromMembers: members,
      toMembers: afterMembers,
      decision: "rebased_clean",
      invalidationCause: "ancestor_landed",
    });
    const history = await shifts.listForDependentRun(ORG, members[5]!.runId);
    expect(history).toHaveLength(1);
    expect(history[0]?.fromMembers).toHaveLength(6);
    expect(history[0]?.toMembers).toHaveLength(5);
    expect(history[0]?.invalidationCause).toBe("ancestor_landed");

    // Negative control (1): delete one persisted member row → read fails closed.
    await runWithOrgScope(runtime, ORG, async (client) => {
      await client.query(`DELETE FROM integration_node_members WHERE node_id = $1 AND ordinal = 2`, [nodeId]);
    });
    await expect(model.findByMemberKey(ORG, key)).rejects.toBeInstanceOf(MemberLineageDivergenceError);

    // Restore + negative control (2): reorder ordinals → fail closed.
    await runWithOrgScope(runtime, ORG, async (client) => {
      await client.query(`DELETE FROM integration_node_members WHERE node_id = $1`, [nodeId]);
      for (const [ordinal, member] of members.entries()) {
        // Swap first two ordinals deliberately.
        const writeOrdinal = ordinal === 0 ? 1 : ordinal === 1 ? 0 : ordinal;
        await client.query(
          `INSERT INTO integration_node_members
             (org_id, project_id, node_id, ordinal, spec_id, run_id, branch, head_sha, included)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)`,
          [ORG, PROJECT, nodeId, writeOrdinal, member.specId, member.runId, member.branch, member.headSha],
        );
      }
    });
    await expect(model.findByMemberKey(ORG, key)).rejects.toBeInstanceOf(MemberLineageDivergenceError);

    // Restore authoritative rows for the land-revalidation negative control.
    await runWithOrgScope(runtime, ORG, async (client) => {
      await client.query(`DELETE FROM integration_node_members WHERE node_id = $1`, [nodeId]);
      for (const [ordinal, member] of members.entries()) {
        await client.query(
          `INSERT INTO integration_node_members
             (org_id, project_id, node_id, ordinal, spec_id, run_id, branch, head_sha, included)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)`,
          [ORG, PROJECT, nodeId, ordinal, member.specId, member.runId, member.branch, member.headSha],
        );
      }
    });

    // Present a proof for the pre-shift head while members still match — then
    // delete a member and prove revalidation blocks land (no host CAS).
    await runWithOrgScope(runtime, ORG, async (client) => {
      await client.query(`DELETE FROM integration_node_members WHERE node_id = $1 AND ordinal = 0`, [nodeId]);
    });

    // Land revalidation must fail closed on the diverged node (no host CAS path).
    const landCalls: string[] = [];
    const binding = {
      nodeId,
      baseSha: BASE_SHA,
      headSha: "f".repeat(40),
      treeHash: "e".repeat(40),
      memberSetHash: key,
      members,
      gateConfigHash: "gate-v1",
      policyVersion: "policy-v1",
      proof: {
        verdict: "passed",
        gateProofBundleId: "gpb_fake",
        proofBundleDigest: "sha256:" + "1".repeat(64),
        proofRoot: "sha256:" + "2".repeat(64),
        keyInput: {
          memberKey: key,
          gateConfigHash: "gate-v1",
          policyVersion: "policy-v1",
          runnerImage: "img",
          appEnvHash: "env",
          quarantineVersion: "q0",
        },
      },
    } as unknown as BatchAuthorityBinding;

    const envelope = {
      subject: { id: nodeId, kind: "integration_node" },
      headSha: binding.headSha,
      expectedMainSha: BASE_SHA,
      memberSetHash: key,
      policyVersion: "policy-v1",
      members,
    } as unknown as LandBindingEnvelope;

    const revalidator = new PgExactBatchBindingRevalidator({
      orgId: ORG,
      envelope,
      binding,
      host: {
        fetchRef: async () => BASE_SHA,
        landAuthorizedIntegration: async () => {
          landCalls.push("land");
          return { kind: "landed", mainSha: BASE_SHA };
        },
      } as never,
      repo: { owner: "o", name: "r" } as never,
      intoMain: "main",
      nodes: model,
      readQuarantineVersion: async () => "q0",
      readDecisionSignals: async () => ({
        gateVerdict: "passed",
        mergeability: "clean",
        conflicts: "resolved",
      }),
      verifyGateProof: async () => true,
    });

    const result = await revalidator.revalidate({
      subject: { id: nodeId, kind: "integration_node" },
      envelope,
    });
    expect(result.valid).toBe(false);
    expect(result.reason ?? "").toMatch(/member lineage|no longer matches|diverged/iu);
    // Revalidator itself never lands; prove the CAS hook was never invoked either.
    expect(landCalls).toEqual([]);
  });

  it("materializer dual-writes members; cross-org RLS sees zero rows", async () => {
    const members = sixMembers().slice(0, 2);
    const workspace = new InMemoryWorkspaceVcsCore();
    workspace.seedRemoteRef("main", BASE_SHA);
    for (const member of members) {
      workspace.seedRemoteRef(member.branch, member.headSha);
    }
    const materializer = new IntegrationNodeMaterializer(workspace, {
      async persistMaterialized(input) {
        return runWithOrgScope(runtime, input.orgId, (client) =>
          upsertIntegrationNodeOnClient(client, {
            orgId: input.orgId,
            projectId: input.projectId,
            baseBranch: input.baseBranch,
            baseSha: input.baseSha,
            ref: input.ref,
            purpose: input.purpose,
            members: input.members,
            gateConfigHash: input.gateConfigHash,
            policyVersion: input.policyVersion,
            headSha: input.headSha,
            treeHash: input.treeHash,
            status: input.status,
          }),
        );
      },
      async recordMaterializationFailure() {},
    });

    const result = await materializer.materialize({
      orgId: ORG,
      projectId: PROJECT,
      repoUrl: "https://example.test/gv17.git",
      baseBranch: "main",
      baseSha: BASE_SHA,
      members,
      localRef: "tanren-local-mat",
      workspacePath: "/tmp/gv17",
      purpose: "merge_batch",
    });
    expect(result.kind).toBe("materialized");
    if (result.kind !== "materialized") return;

    // Cross-org: other tenant GUC sees zero member rows (FORCE RLS).
    const otherOrgCount = await runWithOrgScope(runtime, "org_other_missing", async (client) => {
      const r = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM integration_node_members WHERE node_id = $1`,
        [result.nodeId],
      );
      return Number(r.rows[0]?.n ?? 0);
    });
    expect(otherOrgCount).toBe(0);
  });
});
