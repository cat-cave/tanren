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
  it("(a) an eager dependent's node member_key === memberKey(immediateAncestorBranch, [ancestorHeadSha])", () => {
    // jj-local: the immediate-ancestor PR-head branch is the base identity (the stacked base).
    const ancestorBranch = "tanren/spec_ancestor";
    const ancestorHeadSha = "f".repeat(40);
    const node = speculativeRunToNode({
      runId: "run_dep",
      branch: "tanren/dep",
      ancestorStack: [{ specId: "spec_ancestor", runId: "run_anc", branch: ancestorBranch, headSha: ancestorHeadSha }],
    });
    expect(node.members).toHaveLength(1);
    expect(node.members[0]?.headSha).toBe(ancestorHeadSha);
    expect(node.memberKey).toBe(memberKey(ancestorBranch, [ancestorHeadSha]));
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
    // The ordered ancestor_stack is the member source (DAG order is load-bearing); the
    // immediate-ancestor (LAST) branch is the node base.
    const node = speculativeRunToNode({
      runId: "run_dep2",
      branch: "tanren/dep2",
      ancestorStack: [
        { specId: "spec_a", runId: "run_a", branch: "tanren/run_a", headSha: "1".repeat(40) },
        { specId: "spec_b", runId: "run_b", branch: "tanren/run_b", headSha: "2".repeat(40) },
      ],
    });
    expect(node.members.map((m) => m.specId)).toEqual(["spec_a", "spec_b"]);
    expect(node.members.map((m) => m.headSha)).toEqual(["1".repeat(40), "2".repeat(40)]);
    // The base is the immediate (last) ancestor's PR-head branch.
    expect(node.baseBranch).toBe("tanren/run_b");
    expect(node.memberKey).toBe(memberKey("tanren/run_b", ["1".repeat(40), "2".repeat(40)]));
    // A reordering of the SAME members is a DIFFERENT key (order is load-bearing).
    expect(node.memberKey).not.toBe(memberKey("tanren/run_b", ["2".repeat(40), "1".repeat(40)]));
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
const PROJECT_OTHER = `proj_other_${ORG}`;
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

// A query-intercepting wrapper: forces the observe write's `INSERT INTO
// integration_nodes` to error MID-STATEMENT (a real Postgres error that poisons the
// tx), while every other statement passes through untouched. Used to prove the
// SAVEPOINT un-poisons the run-create tx.
function failingNodeWriteClient(real: { query: (...args: never[]) => Promise<unknown> }) {
  return {
    async query(text: unknown, ...rest: never[]): Promise<unknown> {
      if (typeof text === "string" && text.includes("INSERT INTO integration_nodes")) {
        // A guaranteed mid-tx statement error (undefined column) — the poisoning trigger.
        return real.query("INSERT INTO integration_nodes (no_such_column) VALUES (1)" as never);
      }
      return real.query(text as never, ...rest);
    },
  };
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
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
       VALUES ($1, 'p-other', 'https://example.test/other', 'main', 'runner:v0', $2, '{"version":1}'::jsonb)`,
      [PROJECT_OTHER, ORG],
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
        JSON.stringify([{ specId: SPEC_ANCESTOR, runId: "run_anc", branch: "tanren/run_anc", headSha: ANCESTOR_HEAD }]),
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

  it("preserves an authority stamp only for an exact unchanged binding and clears it on drift", async () => {
    const baseSha = "3".repeat(40);
    const memberSha = "4".repeat(40);
    const headSha = "5".repeat(40);
    const treeHash = "6".repeat(40);
    const input = {
      projectId: PROJECT,
      orgId: ORG,
      baseBranch: "main",
      baseSha,
      ref: "tanren/authority-preservation",
      purpose: "merge_batch" as const,
      members: [{ specId: SPEC_ANCESTOR, runId: RUN_DEP, branch: "stamp", headSha: memberSha }],
      headSha,
      treeHash,
      status: "ready" as const,
    };
    const key = memberKey(baseSha, [memberSha]);

    await model.upsertNode({ ...input, affectedFingerprint: "sealed-generation-a" });
    await model.upsertNode(input);
    expect((await model.findByMemberKey(ORG, key))?.affectedFingerprint).toBe("sealed-generation-a");

    // Same member key but another prepared product identity: never carry the prior seal.
    await model.upsertNode({ ...input, headSha: "7".repeat(40) });
    expect((await model.findByMemberKey(ORG, key))?.affectedFingerprint).toBe("");

    // A producer may restore authority only by explicitly recomputing a new stamp.
    await model.upsertNode({ ...input, headSha: "7".repeat(40), affectedFingerprint: "sealed-generation-b" });
    expect((await model.findByMemberKey(ORG, key))?.affectedFingerprint).toBe("sealed-generation-b");
  });

  it("fails closed instead of mutating another project's colliding org/member identity", async () => {
    const input = {
      orgId: ORG,
      baseBranch: "main",
      baseSha: "8".repeat(40),
      ref: "tanren/project-collision",
      purpose: "merge_batch" as const,
      members: [{ specId: SPEC_ANCESTOR, runId: RUN_DEP, branch: "collision", headSha: "9".repeat(40) }],
      headSha: "a".repeat(40),
      treeHash: "b".repeat(40),
      status: "ready" as const,
    };
    await model.upsertNode({ ...input, projectId: PROJECT, affectedFingerprint: "project-a-seal" });
    await expect(model.upsertNode({ ...input, projectId: PROJECT_OTHER })).rejects.toThrow("collides outside project");
    const row = await ownerPool.query<{ project_id: string; affected_fingerprint: string }>(
      "SELECT project_id, affected_fingerprint FROM integration_nodes WHERE org_id = $1 AND member_key = $2",
      [ORG, memberKey(input.baseSha, [input.members[0]!.headSha])],
    );
    expect(row.rows[0]).toEqual({ project_id: PROJECT, affected_fingerprint: "project-a-seal" });
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
      // Distinct run identities per member (unique (org,node,run) + exact multiset).
      members: memberShas.map((s, i) => ({
        specId: i === 0 ? SPEC_ANCESTOR : SPEC_DEP,
        runId: i === 0 ? `${RUN_DEP}_m0` : RUN_DEP,
        branch: `b${i}`,
        headSha: s,
      })),
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
    // jj-local: the base is the immediate-ancestor PR-head branch from the ancestor_stack.
    expect(dep?.baseBranch).toBe("tanren/run_anc");
    expect(dep?.members.map((m) => m.headSha)).toEqual(["f".repeat(40)]);
    expect(dep?.memberKey).toBe(memberKey("tanren/run_anc", ["f".repeat(40)]));
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
          {
            ancestorStack: [
              { specId: SPEC_ANCESTOR, runId: "run_anc", branch: "tanren/run_anc", headSha: "f".repeat(40) },
            ],
          },
        );
      });
    });
    // The observe-at-create node bases on `default_branch` (the assembly's real history root).
    const key = memberKey("main", ["f".repeat(40)]);
    const found = await model.findByMemberKey(ORG, key);
    expect(found).toBeDefined();
    expect(found?.purpose).toBe("eager_base");
  });

  it("a FAILING observe write is SAVEPOINT-isolated: surrounding writes in the same tx still COMMIT (no poisoning)", async () => {
    // Reproduce the exact run-create flow: a real write BEFORE the observe hook, a
    // FORCED node-write failure inside it, then a real write AFTER — all in ONE tx.
    // The SAVEPOINT must un-poison the tx so the after-write succeeds and the tx
    // commits. WITHOUT the savepoint, the forced error aborts the tx and the
    // after-write (and the whole run) fails — this test would then throw.
    const RUN_BEFORE = `run_savepoint_before_${ORG}`;
    const RUN_AFTER = `run_savepoint_after_${ORG}`;

    await runWithJobOrgId(ORG, async () => {
      await runWithOrgScope(appPool, ORG, async (client) => {
        // BEFORE: a real tenant write in this tx.
        await client.query(
          `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
           VALUES ($1, $2, $3, $4, 'cli', 'tanren/before', 'queued')`,
          [RUN_BEFORE, SPEC_DEP, PROJECT, ORG],
        );
        // The observe write FORCED to fail mid-statement (poisons the tx unless the
        // savepoint rolls it back). The hook must swallow it without throwing.
        await observeRunAsIntegrationNode(
          failingNodeWriteClient(client) as never,
          {
            runId: RUN_DEP,
            specId: SPEC_DEP,
            branch: "tanren/dep",
            projectId: PROJECT,
            project: { defaultBranch: "main" },
          },
          {
            ancestorStack: [
              { specId: SPEC_ANCESTOR, runId: "run_anc", branch: "tanren/run_anc", headSha: "a".repeat(40) },
            ],
          },
        );
        // AFTER: another real tenant write. WITHOUT the savepoint fix this throws
        // "current transaction is aborted"; WITH it, it succeeds and the tx commits.
        await client.query(
          `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
           VALUES ($1, $2, $3, $4, 'cli', 'tanren/after', 'queued')`,
          [RUN_AFTER, SPEC_DEP, PROJECT, ORG],
        );
      });
    });

    // Both surrounding writes COMMITTED (the tx was not poisoned).
    const committed = await runWithOrgScope(appPool, ORG, async (client) => {
      const r = await client.query<{ run_id: string }>(
        "SELECT run_id FROM runs WHERE run_id = ANY($1::text[]) ORDER BY run_id",
        [[RUN_BEFORE, RUN_AFTER]],
      );
      return r.rows.map((row) => row.run_id);
    });
    expect(committed).toEqual([RUN_AFTER, RUN_BEFORE]);
  });
});
