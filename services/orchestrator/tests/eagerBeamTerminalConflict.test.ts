import { describe, expect, it } from "vitest";
import { createEagerBeamPlan } from "../src/engine/contracts/eagerBeamPlan.js";
import { EagerBeamPlanDigestCollisionError, PgEagerBeamStore } from "../src/engine/merge/eagerBeamStore.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const TREE_HASH = "c".repeat(40);
const DIGEST = `sha256:${"d".repeat(64)}`;

type PriorBeam = {
  project_id: string;
  frontier_run_id: string;
  frontier_spec_id: string;
  state: "building" | "ready" | "stale" | "held";
};

class ConflictPool {
  public revived = false;

  public constructor(private readonly prior: PriorBeam) {}

  public async connect(): Promise<this> {
    return this;
  }

  public release(): void {}

  public async query(sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.includes("SELECT run_id FROM runs")) return { rows: [{ run_id: "run_frontier" }], rowCount: 1 };
    if (sql.includes("SELECT 1 FROM merge_eager_beams")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO integration_nodes")) return { rows: [{ node_id: "node_retry" }], rowCount: 1 };
    if (sql.includes("INSERT INTO integration_node_members")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM integration_node_members")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO merge_eager_beams")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT project_id, frontier_run_id, frontier_spec_id, state")) {
      return { rows: [this.prior], rowCount: 1 };
    }
    if (sql.includes("UPDATE merge_eager_beams") && sql.includes("integration_node_id")) {
      this.revived = true;
      return { rows: [{ id: "beam_retry", generation: 2 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

describe("EAGER content-addressed terminal conflicts", () => {
  it("revives a stale row for the exact same frontier/spec coordinate", async () => {
    const pool = new ConflictPool({
      project_id: "project_eager",
      frontier_run_id: "run_frontier",
      frontier_spec_id: "spec_frontier",
      state: "stale",
    });

    await expect(new PgEagerBeamStore(pool as never).persistMaterialized(input())).resolves.toEqual({
      nodeId: "node_retry",
      beamId: "beam_retry",
      generation: 2,
    });
    expect(pool.revived).toBe(true);
  });

  it("keeps a digest collision from another frontier fail-closed", async () => {
    const pool = new ConflictPool({
      project_id: "project_eager",
      frontier_run_id: "other_frontier",
      frontier_spec_id: "other_spec",
      state: "stale",
    });

    await expect(new PgEagerBeamStore(pool as never).persistMaterialized(input())).rejects.toBeInstanceOf(
      EagerBeamPlanDigestCollisionError,
    );
    expect(pool.revived).toBe(false);
  });
});

function input() {
  const record = {
    orgId: "org_eager",
    projectId: "project_eager",
    baseBranch: "main",
    baseSha: BASE_SHA,
    ref: "tanren/eager/retry",
    purpose: "eager_beam" as const,
    members: [],
    memberKey: "f".repeat(64),
    headSha: HEAD_SHA,
    treeHash: TREE_HASH,
    status: "building" as const,
  };
  return {
    record,
    plan: createEagerBeamPlan({
      beamWidth: 1,
      rank: 1,
      orgId: "org_eager",
      projectId: "project_eager",
      frontierRunId: "run_frontier",
      frontierSpecId: "spec_frontier",
      baseBranch: "main",
      baseSha: BASE_SHA,
      ancestorStack: [],
      frontier: { specId: "spec_frontier", runId: "run_frontier", branch: "feature/frontier", headSha: HEAD_SHA },
      proofReuseInput: {
        memberKey: record.memberKey,
        gateConfigHash: "1".repeat(64),
        policyVersion: "policy.v1",
        runnerImage: "runner@sha256:test",
        appEnvHash: "2".repeat(64),
        quarantineVersion: "none",
      },
      integration: { ref: record.ref, headSha: HEAD_SHA, treeHash: TREE_HASH },
      fragmentEvidenceDigest: `sha256:${"e".repeat(64)}`,
    }),
    planDigest: DIGEST,
  };
}
