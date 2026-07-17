import { describe, expect, it } from "vitest";
import { writeBehaviorVerificationRunStage } from "../src/engine/verification/behaviorVerificationRunStage.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("writeBehaviorVerificationRunStage", () => {
  it("writes the runtime row with stage, resolution job, and classification lineage", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const client = {
      async query(sql: string, params: readonly unknown[]) {
        calls.push({ sql, params });
        return { rows: [{ id: "vrun_resolution_1" }], rowCount: 1 };
      },
    };

    await expect(
      writeBehaviorVerificationRunStage(client as never, {
        orgId: "org_a",
        id: "vrun_resolution_1",
        projectId: "project_a",
        purpose: "post_merge_production",
        environmentId: "env_a",
        preparedHeadSha: "a".repeat(40),
        jjTreeId: "tree_a",
        planSetHash: DIGEST,
        runtimeBehaviorContextHash: DIGEST,
        artifactDigest: DIGEST,
        policy: { mode: "active_causal" },
        stage: "production",
        resolutionJobId: "rjob_a",
        classification: "product_failure",
      }),
    ).resolves.toBe("vrun_resolution_1");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("stage, resolution_job_id, classification");
    expect(calls[0]?.params.slice(-3)).toEqual(["production", "rjob_a", "product_failure"]);
  });
});
