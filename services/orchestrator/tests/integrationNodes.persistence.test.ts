// Behavior tests for the `integration_nodes` persistence model (tanren-owns-the-
// engine.md §3, Wave 2 / Slice S0 — OBSERVE-ONLY). Two layers:
//
//   PURE layer (always-on, runs in `just fast-check`): load-bearing member/proof
//   identity plus the canonical policy/gate persistence boundary.
//
//   DB layer (gated behind TANREN_RLS_DB_TEST=1 + an owner DATABASE_URL, like the
//   other RLS-cohort tests): the REAL pg UPSERT + lookup + proof record/reuse +
//   canonical eager-node read against an ephemeral migrated DB on the ENFORCED `tanren_app`
//   role, proving the writes/reads land under fail-closed RLS. No jj/git process is
//   touched (this is pure DB), so there is no host-repo-cwd hazard to isolate.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getSystemPool, migrate, runWithOrgScope, setSystemPool } from "@tanren/db";
import { memberKey, proofReuseKey, type ProofReuseKeyInput } from "../src/engine/contracts/integrationNodes.js";
import { PgIntegrationNodeModel, upsertIntegrationNodeOnClient } from "../src/engine/dag/integrationNodesPg.js";

const GATE_HASH = "a".repeat(64);
const POLICY_HASH = "b".repeat(64);

const SYSTEM_ROLE = "tanren_system";
const SYSTEM_PASSWORD = process.env["TANREN_SYSTEM_DB_PASSWORD"] ?? "tanren_system";

// ===========================================================================
// PURE layer — the identity/projection logic, no DB. Always runs.
// ===========================================================================

describe("integration-nodes persistence (pure logic)", () => {
  it("(a) an eager dependent's member key binds base plus ordered ancestor heads", () => {
    const base = "tanren/spec_ancestor";
    const head = "f".repeat(40);
    expect(memberKey(base, [head])).not.toBe(memberKey(base, ["e".repeat(40)]));
  });

  // (b) PROOF-REUSE: the same base + ordered members → identical proofReuseKey (a
  //     cache HIT); changing ONE member sha → a different key (a cache MISS, forcing
  //     a recompute). This is the cache guarantee the Wave-3 proof reuse rides on.
  it("(b) proof-reuse: identical base+ordered members → same key (hit); one member sha changes → key differs (miss)", () => {
    const baseSha = "a".repeat(40);
    const memberShas = ["b".repeat(40), "c".repeat(40)];
    const proofInputFor = (shas: string[]): ProofReuseKeyInput => ({
      memberKey: memberKey(baseSha, shas),
      gateConfigHash: GATE_HASH,
      policyVersion: POLICY_HASH,
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

  it("(c) persists exact canonical hashes atomically and rejects former defaults before SQL", async () => {
    const query = vi.fn<
      (statement: string, params?: readonly unknown[]) => Promise<{ rows: Array<{ node_id: string }> }>
    >(async () => ({ rows: [{ node_id: "inode_exact" }] }));
    const input = {
      projectId: "project_1",
      orgId: "org_1",
      baseBranch: "main",
      baseSha: "0".repeat(40),
      ref: "tanren/local",
      purpose: "merge_batch" as const,
      members: [{ specId: "spec_1", runId: "run_1", branch: "tanren/spec_1", headSha: "1".repeat(40) }],
      gateConfigHash: GATE_HASH,
      policyVersion: POLICY_HASH,
    };

    await expect(upsertIntegrationNodeOnClient({ query } as never, input)).resolves.toBe("inode_exact");
    const params = query.mock.calls[0]?.[1] as unknown[];
    expect(params[9]).toBe(GATE_HASH);
    expect(params[10]).toBe(POLICY_HASH);

    await expect(upsertIntegrationNodeOnClient({ query } as never, { ...input, policyVersion: "1" })).rejects.toThrow(
      /policyVersion.*canonical lowercase 64-hex/iu,
    );
    await expect(upsertIntegrationNodeOnClient({ query } as never, { ...input, gateConfigHash: "" })).rejects.toThrow(
      /gateConfigHash.*canonical lowercase 64-hex/iu,
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("(d) fails closed when a legacy persisted row carries an empty identity", async () => {
    const row = {
      node_id: "inode_legacy",
      base_branch: "main",
      base_sha: "0".repeat(40),
      ref: "tanren/legacy",
      purpose: "merge_batch",
      members: [],
      member_key: "legacy-key",
      gate_config_hash: GATE_HASH,
      policy_version: POLICY_HASH,
      affected_fingerprint: "",
      head_sha: null,
      tree_hash: null,
      status: "ready",
    };

    for (const invalidRow of [
      { ...row, gate_config_hash: "" },
      { ...row, policy_version: "" },
    ]) {
      const query = vi.fn<(statement: string) => Promise<{ rows: (typeof invalidRow)[] }>>(async (statement) => ({
        rows: statement.includes("SELECT node_id") ? [invalidRow] : [],
      }));
      const release = vi.fn<() => void>();
      const model = new PgIntegrationNodeModel({
        connect: async () => ({ query, release }),
      } as never);

      await expect(model.findByMemberKey("org_1", "legacy-key")).rejects.toThrow(
        /integration_nodes\.(?:gate_config_hash|policy_version).*canonical lowercase 64-hex/iu,
      );
      expect(query).toHaveBeenCalledWith("ROLLBACK");
      expect(release).toHaveBeenCalledOnce();
    }
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
    // The canonical node reader resolves a project's org cross-tenant via the BYPASSRLS
    // system pool (mirrors prod `resolveProjectOrg`); set it to the `tanren_system`
    // role so the org resolve succeeds while every org-scoped node/proof write/read
    // still runs on the enforced NOBYPASSRLS app role under fail-closed RLS.
    setSystemPool(new Pool({ connectionString: withRole(ADMIN_URL, SYSTEM_ROLE, SYSTEM_PASSWORD, database) }));
    model = new PgIntegrationNodeModel(appPool);

    // Seed org/project/specs/run; integration nodes are persisted explicitly below.
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
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status, ancestor_stack)
       VALUES ($1, $2, $3, $4, 'cli', 'tanren/dep', 'running', $5::jsonb)`,
      [
        RUN_DEP,
        SPEC_DEP,
        PROJECT,
        ORG,
        JSON.stringify([
          { specId: SPEC_ANCESTOR, runId: "run_anc", branch: "tanren/run_anc", headSha: "f".repeat(40) },
        ]),
      ],
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
      gateConfigHash: GATE_HASH,
      policyVersion: POLICY_HASH,
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
      gateConfigHash: GATE_HASH,
      policyVersion: POLICY_HASH,
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
      gateConfigHash: GATE_HASH,
      policyVersion: POLICY_HASH,
    });
    const keyInput = (shas: string[]): ProofReuseKeyInput => ({
      memberKey: memberKey(baseSha, shas),
      gateConfigHash: GATE_HASH,
      policyVersion: POLICY_HASH,
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

  it("(c) reads only real persisted eager nodes with their exact identities", async () => {
    const headSha = "9".repeat(40);
    await model.upsertNode({
      projectId: PROJECT,
      orgId: ORG,
      baseBranch: "main",
      baseSha: "8".repeat(40),
      ref: "tanren/eager-canonical",
      purpose: "eager_base",
      members: [{ specId: SPEC_ANCESTOR, runId: RUN_DEP, branch: "tanren/run_anc", headSha }],
      gateConfigHash: GATE_HASH,
      policyVersion: POLICY_HASH,
      status: "ready",
    });

    const nodes = await model.findEagerBaseNodes(PROJECT);
    const dep = nodes.find((node) => node.ref === "tanren/eager-canonical");
    expect(dep?.gateConfigHash).toBe(GATE_HASH);
    expect(dep?.policyVersion).toBe(POLICY_HASH);
    expect(dep?.members.map((member) => member.headSha)).toEqual([headSha]);
  });
});
