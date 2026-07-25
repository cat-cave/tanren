import { createEagerBeamPlan, type EagerBeamPlanV1 } from "../src/engine/contracts/eagerBeamPlan.js";
import { PgEagerBeamStore } from "../src/engine/merge/eagerBeamStore.js";
import { describe, expect, it } from "vitest";

const DIGEST = `sha256:${"d".repeat(64)}`;
const WINNER_ROOT = `sha256:${"b".repeat(64)}`;
const rows = (present = true, row: unknown = {}) => ({ rows: present ? [row] : [], rowCount: present ? 1 : 0 });

class RacePool {
  public readonly events: string[] = [];
  public readonly proofRows: string[] = [];
  public winnerReady = false;
  public nodeProofRoot: string | undefined;
  public ownershipParams: unknown[] = [];
  private checkpoint: { events: number; proofRows: number } | undefined;

  public connect = async (): Promise<this> => this;
  public release(): void {}

  public async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql === "BEGIN") {
      this.checkpoint = { events: this.events.length, proofRows: this.proofRows.length };
    } else if (sql === "ROLLBACK") {
      if (this.checkpoint !== undefined) {
        this.events.length = this.checkpoint.events;
        this.proofRows.length = this.checkpoint.proofRows;
      }
      this.checkpoint = undefined;
    } else if (sql === "TEST INSERT PROOF") {
      this.proofRows.push(String(params[0]));
    } else if (sql.includes("event_type, payload)")) {
      this.events.push(String(params[5]));
    } else if (sql.includes("FROM merge_eager_beams b")) {
      this.ownershipParams = params;
      return rows(!this.winnerReady);
    } else if (sql.includes("SELECT 1 FROM merge_eager_beams")) {
      return rows(this.winnerReady);
    } else if (sql.includes("SET state = 'stale'")) {
      return rows(true, { id: "beam_a", frontier_run_id: "run_frontier", plan_digest: DIGEST });
    } else if (sql.includes("SET proof_root")) {
      this.nodeProofRoot = String(params[2]);
    }
    return rows();
  }
}

describe("EAGER exact-attempt race fencing", () => {
  it("NEGATIVE CONTROL — old A cannot disturb ready B on resumed stage or genuine-error hold", async () => {
    const pool = new RacePool();
    const store = new PgEagerBeamStore(pool as never);
    pool.winnerReady = true;
    pool.nodeProofRoot = WINNER_ROOT;
    let evaluations = 0;

    await expect(store.persistMaterialized(attempt())).rejects.toThrow("lost its exact building coordinate");
    await expect(
      store.markReady(attempt(), async () => {
        evaluations += 1;
        await pool.query("TEST INSERT PROOF", ["punit_a"]);
        throw new Error("stale A evaluation ran");
      }),
    ).rejects.toThrow("lost its exact building coordinate");
    await store.hold({
      orgId: "org_eager",
      projectId: "project_eager",
      frontierRunId: "run_frontier",
      frontierSpecId: "spec_frontier",
      rank: 1,
      reason: "genuine_a_failure",
      planDigest: DIGEST,
    });

    expect(evaluations).toBe(0);
    expect(pool.nodeProofRoot).toBe(WINNER_ROOT);
    expect(pool.proofRows).toEqual([]);
    expect(pool.events).toEqual(["merge.beam.stale"]);
    const coordinate = plan().integration;
    expect(pool.ownershipParams.slice(4, 7)).toEqual([coordinate.ref, coordinate.headSha, coordinate.treeHash]);
  });

  it("rolls back A proof rows and events when its genuine evaluation error prevents ready", async () => {
    const pool = new RacePool();
    const store = new PgEagerBeamStore(pool as never);
    await expect(
      store.markReady(attempt(), async () => {
        await pool.query("TEST INSERT PROOF", ["punit_a"]);
        pool.events.push("integration.proof_unit.recorded");
        throw new Error("genuine A proof failure");
      }),
    ).rejects.toThrow("genuine A proof failure");
    expect(pool.proofRows).toEqual([]);
    expect(pool.events).toEqual([]);
    expect(pool.nodeProofRoot).toBeUndefined();
  });
});

function attempt() {
  return {
    orgId: "org_eager",
    projectId: "project_eager",
    planDigest: DIGEST,
    nodeId: "node_a",
    plan: plan(),
    record: {
      orgId: "org_eager",
      projectId: "project_eager",
      baseBranch: "main",
      baseSha: "a".repeat(40),
      ref: "tanren/eager/a",
      purpose: "eager_beam" as const,
      members: [],
      memberKey: "f".repeat(64),
      headSha: "b".repeat(40),
      treeHash: "c".repeat(40),
      status: "building" as const,
    },
  };
}

function plan(): EagerBeamPlanV1 {
  return createEagerBeamPlan({
    beamWidth: 1,
    rank: 1,
    orgId: "org_eager",
    projectId: "project_eager",
    frontierRunId: "run_frontier",
    frontierSpecId: "spec_frontier",
    baseBranch: "main",
    baseSha: "a".repeat(40),
    ancestorStack: [],
    frontier: { specId: "spec_frontier", runId: "run_frontier", branch: "feature/a", headSha: "b".repeat(40) },
    proofReuseInput: {
      memberKey: "f".repeat(64),
      gateConfigHash: "1".repeat(64),
      policyVersion: "policy.v1",
      runnerImage: "runner@sha256:test",
      appEnvHash: "2".repeat(64),
      quarantineVersion: "none",
    },
    integration: { ref: "tanren/eager/a", headSha: "b".repeat(40), treeHash: "c".repeat(40) },
    fragmentEvidenceDigest: `sha256:${"3".repeat(64)}`,
  });
}
