// Behavior tests for the `integration_nodes` persistence model (tanren-owns-the-
// engine.md §3, Wave 2 / Slice S0 — OBSERVE-ONLY). Two layers:
//
//   PURE layer (always-on, runs in `just fast-check`): the load-bearing identity +
//   projection logic WITHOUT a DB — the member-key an eager dependent derives, the
//   proof-reuse cache hit/miss, and the §8 compatibility read-model projecting an
//   old speculative run row into the FROZEN `IntegrationNode` shape.
//
//   DB layer (gated behind TANREN_RLS_DB_TEST=1 + an owner DATABASE_URL, like the
//   other RLS-cohort tests): the REAL pg UPSERT + lookup + proof record/reuse +
//   compat read-model against an ephemeral migrated DB on the ENFORCED `tanren_app`
//   role, proving the writes/reads land under fail-closed RLS. No jj/git process is
//   touched (this is pure DB), so there is no host-repo-cwd hazard to isolate.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSystemPool, migrate, runWithJobOrgId, runWithOrgScope, setSystemPool } from "@tanren/db";
import { memberKey, proofReuseKey, type ProofReuseKeyInput } from "../src/engine/contracts/integrationNodes.js";
import {
  observeRunAsIntegrationNode,
  PgIntegrationNodeModel,
  speculativeRunToNode,
} from "../src/engine/dag/integrationNodesPg.js";

const SYSTEM_ROLE = "tanren_system";
const SYSTEM_PASSWORD = process.env["TANREN_SYSTEM_DB_PASSWORD"] ?? "tanren_system";

// ===========================================================================
// PURE layer — the identity/projection logic, no DB. Always runs.
// ===========================================================================

describe("integration-nodes persistence (pure logic)", () => {
  // (a) an eager dependent vs `main + ancestor` derives a node whose member_key
  //     === memberKey(baseSha, [ancestorHeadSha]). The compat projection IS the
  //     same derivation the observe-only hook + the DB UPSERT compute, so projecting
  //     a one-ancestor speculative run and re-deriving the key must agree.
  it("(a) an eager dependent's node member_key === memberKey(baseSha, [ancestorHeadSha])", () => {
    // The speculative base ref is the base identity in the old model.
    const baseSha = "spec/integration-ancestorX";
    const ancestorHeadSha = "f".repeat(40);
    const node = speculativeRunToNode({
      runId: "run_dep",
      specId: "spec_dep",
      branch: "tanren/dep",
      speculativeBase: baseSha,
      integratedAncestorShas: { spec_ancestor: ancestorHeadSha },
    });
    expect(node.members).toHaveLength(1);
    expect(node.members[0]?.headSha).toBe(ancestorHeadSha);
    expect(node.memberKey).toBe(memberKey(baseSha, [ancestorHeadSha]));
    expect(node.purpose).toBe("eager_base");
  });

  // (b) PROOF-REUSE: the same base + ordered members → identical proofReuseKey (a
  //     cache HIT); changing ONE member sha → a different key (a cache MISS, forcing
  //     a recompute). This is the cache guarantee the Wave-3 proof reuse rides on.
  it("(b) proof-reuse: identical base+ordered members → same key (hit); one member sha changes → key differs (miss)", () => {
    const baseSha = "a".repeat(40);
    const memberShas = ["b".repeat(40), "c".repeat(40)];
    const proofInputFor = (shas: string[]): ProofReuseKeyInput => ({
      memberKey: memberKey(baseSha, shas),
      gateConfigHash: "gc",
      policyVersion: "pv",
      runnerImage: "ri",
      appEnvHash: "ae",
      quarantineVersion: "qv",
    });

    // Build a node + record a proof keyed by proofReuseKey; rebuild the SAME base +
    // ordered members → proofReuseKey identical (the cache HIT).
    const recorded = proofReuseKey(proofInputFor(memberShas));
    const rebuilt = proofReuseKey(proofInputFor([...memberShas]));
    expect(rebuilt).toBe(recorded);

    // Change one member sha → the member_key changes → the proof key differs (MISS).
    const drifted = proofReuseKey(proofInputFor([memberShas[0]!, "d".repeat(40)]));
    expect(drifted).not.toBe(recorded);
  });

  // (c) the §8 compatibility read-model projects an old speculative run row into the
  //     right IntegrationNode shape (ordered, total, deterministic key).
  it("(c) compat read-model projects a speculative run into the right IntegrationNode", () => {
    const node = speculativeRunToNode({
      runId: "run_dep2",
      specId: "spec_dep2",
      branch: "tanren/dep2",
      speculativeBase: "tanren/integration-dep2",
      // unordered map; the projection must ORDER by ancestor spec id deterministically.
      integratedAncestorShas: { spec_b: "2".repeat(40), spec_a: "1".repeat(40) },
    });
    expect(node.members.map((m) => m.specId)).toEqual(["spec_a", "spec_b"]);
    expect(node.members.map((m) => m.headSha)).toEqual(["1".repeat(40), "2".repeat(40)]);
    expect(node.baseBranch).toBe("tanren/integration-dep2");
    expect(node.memberKey).toBe(memberKey("tanren/integration-dep2", ["1".repeat(40), "2".repeat(40)]));
    // A reordering of the SAME members is a DIFFERENT key (order is load-bearing).
    expect(node.memberKey).not.toBe(memberKey("tanren/integration-dep2", ["2".repeat(40), "1".repeat(40)]));
  });
});

// ===========================================================================
// DB layer — the REAL pg UPSERT + RLS, gated behind a real owner DB.
// ===========================================================================

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG = "org_inodes";
const PROJECT = `proj_${ORG}`;
const SPEC_ANCESTOR = `spec_ancestor_${ORG}`;
const SPEC_DEP = `spec_dep_${ORG}`;
const RUN_DEP = `run_dep_${ORG}`;

function dbName(): string {
  return `tanren_inodes_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withRole(url: string, role: string, password: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = password;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

describeDb("integration-nodes persistence (real DB + fail-closed RLS)", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;
  let model: PgIntegrationNodeModel;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    // The real migration enables RLS + the policies + creates the roles.
    await migrate(ownerPool);
    appPool = new Pool({ connectionString: withRole(ADMIN_URL, APP_ROLE, APP_PASSWORD, database) });
    // The compat read-model resolves a project's org cross-tenant via the BYPASSRLS
    // system pool (mirrors prod `resolveProjectOrg`); set it to the `tanren_system`
    // role so the org resolve succeeds while every org-scoped node/proof write/read
    // still runs on the enforced NOBYPASSRLS app role under fail-closed RLS.
    setSystemPool(new Pool({ connectionString: withRole(ADMIN_URL, SYSTEM_ROLE, SYSTEM_PASSWORD, database) }));
    model = new PgIntegrationNodeModel(appPool);

    // Seed org/project/specs/run (the dependent speculative run carries a base +
    // ancestor head sha — the OLD model the compat read-model projects).
    const ANCESTOR_HEAD = "f".repeat(40);
    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [ORG],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
       VALUES ($1, 'p', 'https://example.test/r', 'main', 'runner:v0', $2, '{"version":1}'::jsonb)`,
      [PROJECT, ORG],
    );
    for (const sid of [SPEC_ANCESTOR, SPEC_DEP]) {
      await ownerPool.query(
        `INSERT INTO specs (spec_id, project_id, org_id, title, description, acceptance_criteria, status)
         VALUES ($1, $2, $3, 't', 'd', '[]'::jsonb, 'in_flight')`,
        [sid, PROJECT, ORG],
      );
    }
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status,
                         speculative_base, integrated_ancestor_shas)
       VALUES ($1, $2, $3, $4, 'cli', 'tanren/dep', 'running', $5, $6::jsonb)`,
      [RUN_DEP, SPEC_DEP, PROJECT, ORG, "tanren/integration-dep", JSON.stringify({ [SPEC_ANCESTOR]: ANCESTOR_HEAD })],
    );
  }, 60_000);

  afterAll(async () => {
    await getSystemPool()?.end();
    setSystemPool(undefined);
    await appPool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("(a) UPSERTs a node whose member_key === memberKey(baseSha, [ancestorHeadSha]) + is org-scoped under RLS", async () => {
    const baseSha = "1".repeat(40);
    const ancestorHeadSha = "f".repeat(40);
    const nodeId = await model.upsertNode({
      projectId: PROJECT,
      orgId: ORG,
      baseBranch: "main",
      baseSha,
      ref: "tanren/integration-dep",
      purpose: "eager_base",
      members: [{ specId: SPEC_ANCESTOR, runId: RUN_DEP, branch: "tanren/ancestor", headSha: ancestorHeadSha }],
    });
    expect(nodeId).toMatch(/^inode_/u);

    const expectedKey = memberKey(baseSha, [ancestorHeadSha]);
    const found = await model.findByMemberKey(ORG, expectedKey);
    expect(found?.memberKey).toBe(expectedKey);
    expect(found?.members).toHaveLength(1);
    expect(found?.members[0]?.headSha).toBe(ancestorHeadSha);

    // RLS fail-closed: a DIFFERENT org sees ZERO rows for the same key.
    const otherOrg = await runWithOrgScope(appPool, "org_other_inodes", async (client) => {
      const r = await client.query("SELECT node_id FROM integration_nodes WHERE member_key = $1", [expectedKey]);
      return r.rowCount ?? 0;
    });
    expect(otherOrg).toBe(0);

    // Idempotent UPSERT: re-upserting the SAME base + members refreshes, not duplicates.
    await model.upsertNode({
      projectId: PROJECT,
      orgId: ORG,
      baseBranch: "main",
      baseSha,
      ref: "tanren/integration-dep",
      purpose: "eager_base",
      members: [{ specId: SPEC_ANCESTOR, runId: RUN_DEP, branch: "tanren/ancestor", headSha: ancestorHeadSha }],
      status: "ready",
    });
    const count = await runWithOrgScope(appPool, ORG, async (client) => {
      const r = await client.query("SELECT count(*)::int AS c FROM integration_nodes WHERE member_key = $1", [
        expectedKey,
      ]);
      return r.rows[0]?.c as number;
    });
    expect(count).toBe(1);
  });

  it("(b) records a proof keyed by proofReuseKey: same base+members → cache HIT; one member sha changes → MISS", async () => {
    const baseSha = "2".repeat(40);
    const memberShas = ["b".repeat(40), "c".repeat(40)];
    const nodeId = await model.upsertNode({
      projectId: PROJECT,
      orgId: ORG,
      baseBranch: "main",
      baseSha,
      ref: "tanren/batch",
      purpose: "merge_batch",
      members: memberShas.map((s, i) => ({ specId: `m${i}`, runId: RUN_DEP, branch: `b${i}`, headSha: s })),
    });
    const keyInput = (shas: string[]): ProofReuseKeyInput => ({
      memberKey: memberKey(baseSha, shas),
      gateConfigHash: "gc",
      policyVersion: "pv",
      runnerImage: "ri",
      appEnvHash: "ae",
      quarantineVersion: "qv",
    });
    const recordedKey = await model.recordProof({
      orgId: ORG,
      projectId: PROJECT,
      nodeId,
      keyInput: keyInput(memberShas),
      verdict: "passed",
    });

    // Rebuild the SAME base + ordered members → the SAME reuse key → a cache HIT.
    const hit = await model.findProof(ORG, proofReuseKey(keyInput([...memberShas])));
    expect(proofReuseKey(keyInput([...memberShas]))).toBe(recordedKey);
    expect(hit?.verdict).toBe("passed");

    // Change one member sha → a different reuse key → a cache MISS (no stale reuse).
    const miss = await model.findProof(ORG, proofReuseKey(keyInput([memberShas[0]!, "d".repeat(40)])));
    expect(miss).toBeUndefined();
  });

  it("(c) the compat read-model projects the fixture speculative run into the right IntegrationNode", async () => {
    const nodes = await model.projectSpeculativeRunsAsNodes(PROJECT);
    const dep = nodes.find((n) => n.members.some((m) => m.specId === SPEC_ANCESTOR));
    expect(dep).toBeDefined();
    expect(dep?.baseBranch).toBe("tanren/integration-dep");
    expect(dep?.members.map((m) => m.headSha)).toEqual(["f".repeat(40)]);
    expect(dep?.memberKey).toBe(memberKey("tanren/integration-dep", ["f".repeat(40)]));
  });

  it("the observe-only hook UPSERTs a node ALONGSIDE a run insert and never throws", async () => {
    // Drive the hook directly on an org-scoped client (the run-create path's shape).
    await runWithJobOrgId(ORG, async () => {
      await runWithOrgScope(appPool, ORG, async (client) => {
        await observeRunAsIntegrationNode(
          client,
          {
            runId: RUN_DEP,
            specId: SPEC_DEP,
            branch: "tanren/dep",
            projectId: PROJECT,
            project: { defaultBranch: "main" },
          },
          { speculativeBase: "tanren/integration-dep", integratedAncestorShas: { [SPEC_ANCESTOR]: "f".repeat(40) } },
        );
      });
    });
    const key = memberKey("tanren/integration-dep", ["f".repeat(40)]);
    const found = await model.findByMemberKey(ORG, key);
    expect(found).toBeDefined();
    expect(found?.purpose).toBe("eager_base");
  });
});
