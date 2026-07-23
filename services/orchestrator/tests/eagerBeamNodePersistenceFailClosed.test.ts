import { describe, expect, it } from "vitest";
import { createEagerBeamPlan } from "../src/engine/contracts/eagerBeamPlan.js";
import { memberKey } from "../src/engine/contracts/integrationNodes.js";
import {
  observeRunAsIntegrationNode,
  PgIntegrationNodeModel,
  upsertIntegrationNodeOnClient,
} from "../src/engine/dag/integrationNodesPg.js";
import { EagerBeamMaterializationPersistence } from "../src/engine/merge/eagerBeamMaterializationPersistence.js";
import { PgEagerBeamStore } from "../src/engine/merge/eagerBeamStore.js";

const BASE_SHA = "a".repeat(40);
const MEMBER_SHA = "b".repeat(40);

class RecordingClient {
  public readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  private memberRows: Array<{
    ordinal: number;
    spec_id: string;
    run_id: string;
    branch: string;
    head_sha: string;
    included: boolean;
  }> = [];

  public constructor(
    private readonly orgId: string | null,
    private readonly nodeWrite: "persist" | "empty" | "throw" = "persist",
  ) {}

  public async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    this.queries.push({ sql, params });
    if (sql.startsWith("SELECT org_id FROM runs"))
      return this.orgId === null ? { rows: [], rowCount: 0 } : { rows: [{ org_id: this.orgId }], rowCount: 1 };
    if (sql.includes("INSERT INTO integration_nodes")) {
      if (this.nodeWrite === "throw") throw new Error("simulated node write failure");
      return this.nodeWrite === "empty"
        ? { rows: [], rowCount: 0 }
        : { rows: [{ node_id: "inode_eager" }], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM integration_node_members")) {
      this.memberRows = [];
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO integration_node_members")) {
      this.memberRows.push({
        ordinal: params[3] as number,
        spec_id: params[4] as string,
        run_id: params[5] as string,
        branch: params[6] as string,
        head_sha: params[7] as string,
        included: true,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM integration_node_members")) {
      return {
        rows: [...this.memberRows].sort((a, b) => a.ordinal - b.ordinal),
        rowCount: this.memberRows.length,
      };
    }
    return { rows: [], rowCount: 1 };
  }
}

class ModelPool {
  public nodeRow: unknown = undefined;
  public proofRow: unknown = undefined;
  public projectOrg: string | null = "org_eager";
  public speculativeRows: unknown[] = [];
  public memberRows: Array<{
    ordinal: number;
    spec_id: string;
    run_id: string;
    branch: string;
    head_sha: string;
    included: boolean;
  }> = [];

  public async connect(): Promise<this> {
    return this;
  }

  public release(): void {}

  public async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.includes("SELECT org_id FROM projects"))
      return this.projectOrg === null
        ? { rows: [], rowCount: 0 }
        : { rows: [{ org_id: this.projectOrg }], rowCount: 1 };
    if (sql.includes("SELECT node_id, base_branch"))
      return this.nodeRow === undefined ? { rows: [], rowCount: 0 } : { rows: [this.nodeRow], rowCount: 1 };
    if (sql.includes("INSERT INTO integration_nodes")) return { rows: [{ node_id: "inode_eager" }], rowCount: 1 };
    if (sql.includes("DELETE FROM integration_node_members")) {
      this.memberRows = [];
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO integration_node_members")) {
      this.memberRows.push({
        ordinal: params[3] as number,
        spec_id: params[4] as string,
        run_id: params[5] as string,
        branch: params[6] as string,
        head_sha: params[7] as string,
        included: true,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM integration_node_members")) {
      return {
        rows: [...this.memberRows].sort((a, b) => a.ordinal - b.ordinal),
        rowCount: this.memberRows.length,
      };
    }
    if (sql.includes("INSERT INTO integration_proofs")) return { rows: [], rowCount: 1 };
    if (sql.includes("SELECT node_id, verdict FROM integration_proofs"))
      return this.proofRow === undefined ? { rows: [], rowCount: 0 } : { rows: [this.proofRow], rowCount: 1 };
    if (sql.includes("SELECT DISTINCT ON (r.spec_id)"))
      return { rows: this.speculativeRows, rowCount: this.speculativeRows.length };
    if (sql.includes("SELECT 1 FROM merge_eager_beams")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  }

  public asPgPool(): never {
    return this as never;
  }
}

const run = {
  runId: "run_frontier",
  specId: "spec_frontier",
  branch: "feature/frontier",
  projectId: "project_eager",
  project: { defaultBranch: "main" },
};

describe("EAGER integration-node persistence fail closed", () => {
  it("refuses unfrozen or non-durable beam coordinates before evidence can be admitted", async () => {
    const pool = new ModelPool();
    const store = new PgEagerBeamStore(pool.asPgPool());
    const record = {
      orgId: "org_eager",
      projectId: "project_eager",
      baseBranch: "main",
      baseSha: BASE_SHA,
      ref: "tanren-local-eager",
      purpose: "eager_beam" as const,
      members: [{ specId: "spec_frontier", runId: "run_frontier", branch: "feature/frontier", headSha: MEMBER_SHA }],
      memberKey: memberKey(BASE_SHA, [MEMBER_SHA]),
      headSha: MEMBER_SHA,
      treeHash: "tree_eager",
      status: "building" as const,
    };
    const candidate = {
      runId: "run_frontier",
      specId: "spec_frontier",
      branch: "feature/frontier",
      ancestorStack: [],
      priority: "P0",
      createdAt: "2026-07-20T00:00:00.000Z",
    };
    const frozen = new EagerBeamMaterializationPersistence(store, candidate, 1, () => {});
    const plan = createEagerBeamPlan({
      beamWidth: 1,
      rank: 1,
      orgId: "org_eager",
      projectId: "project_eager",
      frontierRunId: "run_frontier",
      frontierSpecId: "spec_frontier",
      baseBranch: "main",
      baseSha: BASE_SHA,
      ancestorStack: [],
      frontier: record.members[0]!,
      proofReuseInput: {
        memberKey: record.memberKey,
        gateConfigHash: "e".repeat(64),
        policyVersion: "policy.v1",
        runnerImage: "runner@sha256:test",
        appEnvHash: "f".repeat(64),
        quarantineVersion: "none",
      },
      integration: { ref: "tanren/eager/run_frontier", headSha: "c".repeat(40), treeHash: "e".repeat(40) },
      fragmentEvidenceDigest: `sha256:${"f".repeat(64)}`,
    });

    await expect(frozen.persistMaterialized(record)).rejects.toThrow("missing a frozen plan");
    await expect(store.persistMaterialized({ record, plan, planDigest: `sha256:${"d".repeat(64)}` })).rejects.toThrow(
      "plan digest collides outside its frontier",
    );
    await expect(
      store.hold({
        orgId: "org_eager",
        projectId: "project_eager",
        frontierRunId: "run_frontier",
        frontierSpecId: "spec_frontier",
        rank: 1,
        reason: "ancestor_head_changed",
      }),
    ).rejects.toThrow("hold was not durably recorded");
  });

  it("fail-closed: partial/corrupt members diverge; exact rows + JSON agree for proof lookup", async () => {
    const pool = new ModelPool();
    const model = new PgIntegrationNodeModel(pool.asPgPool());
    const completeMember = { specId: "spec", runId: "run", branch: "branch", headSha: MEMBER_SHA };
    const completeRow = {
      node_id: "inode_eager",
      base_branch: "main",
      base_sha: BASE_SHA,
      ref: "tanren-local-eager",
      purpose: "eager_beam",
      members: [completeMember],
      member_key: memberKey(BASE_SHA, [MEMBER_SHA]),
      gate_config_hash: "gate",
      policy_version: "policy.v1",
      affected_fingerprint: "",
      head_sha: null,
      tree_hash: null,
      status: "building",
    };
    pool.nodeRow = completeRow;
    pool.memberRows = [
      {
        ordinal: 0,
        spec_id: completeMember.specId,
        run_id: completeMember.runId,
        branch: completeMember.branch,
        head_sha: completeMember.headSha,
        included: true,
      },
    ];

    await expect(model.findByMemberKey("org_eager", completeRow.member_key)).resolves.toMatchObject({
      purpose: "eager_beam",
      members: [completeMember],
    });
    // gv-17: partial/corrupt JSON is a loud divergence, not a silent empty vector.
    pool.nodeRow = {
      ...completeRow,
      members: [null, { specId: "partial" }, completeMember],
    };
    await expect(model.findByMemberKey("org_eager", completeRow.member_key)).rejects.toThrow(
      /member lineage diverged/u,
    );
    pool.nodeRow = { ...completeRow, members: "corrupt-jsonb-members" };
    await expect(model.findByMemberKey("org_eager", completeRow.member_key)).rejects.toThrow(
      /member lineage diverged/u,
    );

    await expect(
      model.upsertNode({
        orgId: "org_eager",
        projectId: "project_eager",
        baseBranch: "main",
        baseSha: BASE_SHA,
        ref: "tanren-local-eager",
        purpose: "eager_beam",
        members: [],
      }),
    ).resolves.toBe("inode_eager");
    const proofKey = await model.recordProof({
      orgId: "org_eager",
      projectId: "project_eager",
      nodeId: "inode_eager",
      keyInput: {
        memberKey: memberKey(BASE_SHA, [MEMBER_SHA]),
        gateConfigHash: "gate",
        policyVersion: "policy.v1",
        runnerImage: "runner@sha256:test",
        appEnvHash: "env",
        quarantineVersion: "none",
      },
      verdict: "pass",
    });
    await expect(model.findProof("org_eager", proofKey)).resolves.toBeUndefined();
    pool.proofRow = { node_id: "inode_eager", verdict: "pass" };
    await expect(model.findProof("org_eager", proofKey)).resolves.toEqual({ nodeId: "inode_eager", verdict: "pass" });
  });

  it("projects only an org-resolved speculative base and fails loud when that ownership is missing", async () => {
    const pool = new ModelPool();
    pool.speculativeRows = [
      {
        run_id: "run_frontier",
        spec_id: "spec_frontier",
        branch: "feature/frontier",
        ancestor_stack: [
          { specId: "spec_ancestor", runId: "run_ancestor", branch: "feature/ancestor", headSha: MEMBER_SHA },
        ],
      },
    ];
    const model = new PgIntegrationNodeModel(pool.asPgPool());

    await expect(model.projectSpeculativeRunsAsNodes("project_eager")).resolves.toMatchObject([
      { baseSha: "feature/ancestor", members: [{ headSha: MEMBER_SHA }] },
    ]);
    pool.projectOrg = null;
    await expect(model.projectSpeculativeRunsAsNodes("project_missing_org")).rejects.toThrow("has no org");
  });

  it("rejects a member-key collision that did not return its exact project row", async () => {
    const client = new RecordingClient("org_eager", "empty");

    await expect(
      upsertIntegrationNodeOnClient(client as never, {
        orgId: "org_eager",
        projectId: "project_eager",
        baseBranch: "main",
        baseSha: BASE_SHA,
        ref: "tanren-local-eager",
        purpose: "eager_beam",
        members: [{ specId: "spec_frontier", runId: "run_frontier", branch: "feature/frontier", headSha: MEMBER_SHA }],
        status: "building",
      }),
    ).rejects.toThrow("collides outside project project_eager");

    const insert = client.queries.find(({ sql }) => sql.includes("INSERT INTO integration_nodes"));
    expect(insert?.params[8]).toBe(memberKey(BASE_SHA, [MEMBER_SHA]));
  });

  it("normalizes a speculative stack before its advisory node is persisted", async () => {
    const client = new RecordingClient("org_eager");

    await observeRunAsIntegrationNode(client as never, run, {
      ancestorStack: [{ specId: "spec_ancestor", runId: "", branch: "", headSha: MEMBER_SHA }],
    });

    const insert = client.queries.find(({ sql }) => sql.includes("INSERT INTO integration_nodes"));
    expect(JSON.parse(String(insert?.params[7]))).toEqual([
      { specId: "spec_ancestor", runId: run.runId, branch: "spec_ancestor", headSha: MEMBER_SHA },
    ]);
    expect(client.queries.map(({ sql }) => sql)).toContain("RELEASE SAVEPOINT obs_node");
  });

  it("contains an advisory node-write error behind its savepoint", async () => {
    const client = new RecordingClient("org_eager", "throw");

    await expect(observeRunAsIntegrationNode(client as never, run, {})).resolves.toBeUndefined();

    expect(client.queries.map(({ sql }) => sql)).toEqual(
      expect.arrayContaining(["SAVEPOINT obs_node", "ROLLBACK TO SAVEPOINT obs_node", "RELEASE SAVEPOINT obs_node"]),
    );
  });

  it("does not create an unscoped node when the run has no organization", async () => {
    const client = new RecordingClient(null);

    await observeRunAsIntegrationNode(client as never, run, {});

    expect(client.queries.some(({ sql }) => sql.includes("INSERT INTO integration_nodes"))).toBe(false);
    expect(client.queries.at(-1)?.sql).toBe("RELEASE SAVEPOINT obs_node");
  });
});
