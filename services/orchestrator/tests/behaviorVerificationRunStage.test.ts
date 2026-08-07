import { describe, expect, it, vi } from "vitest";
import {
  BehaviorVerificationReceiptReplayError,
  startBehaviorVerificationRunStage,
  writeBehaviorVerificationRunStage,
  type WriteBehaviorVerificationRunStageInput,
} from "../src/engine/verification/behaviorVerificationRunStage.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

const INPUT: WriteBehaviorVerificationRunStageInput = {
  orgId: "org_a",
  id: "verification_run_a",
  projectId: "project_a",
  purpose: "post_merge_production",
  runId: "workflow_run_a",
  specId: "spec_a",
  integrationNodeId: "node_a",
  environmentId: "environment_a",
  preparedHeadSha: "a".repeat(40),
  jjTreeId: "tree_a",
  planSetHash: DIGEST,
  runtimeBehaviorContextHash: DIGEST,
  artifactDigest: DIGEST,
  policy: { mode: "active_causal", version: 1 },
  stage: "production",
  resolutionJobId: "resolution_job_a",
  classification: "product_resolved",
};

type StoredReceipt = Record<string, unknown>;

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

describe("startBehaviorVerificationRunStage", () => {
  it("returns an exact completed terminal receipt without a second effect", async () => {
    const stored = storedReceipt(INPUT, "completed");
    const snapshot = clone(stored);
    const harness = receiptHarness(stored);
    const runtime = vi.fn<() => void>();
    const settlement = vi.fn<() => void>();

    const started = await startBehaviorVerificationRunStage(harness.client as never, INPUT);

    expect(started).toMatchObject({
      id: INPUT.id,
      status: "completed",
      classification: "product_resolved",
      shouldRun: false,
    });
    expect(runtime).not.toHaveBeenCalled();
    expect(settlement).not.toHaveBeenCalled();
    expect(harness.queries).toHaveLength(2);
    expect(harness.queries[0]?.sql).toContain("ON CONFLICT DO NOTHING");
    expect(harness.queries[0]?.sql).not.toContain("DO UPDATE");
    expect(harness.queries[1]?.sql).toContain("purpose");
    expect(harness.queries[1]?.sql).toContain("classification");
    expect(stored).toEqual(snapshot);
  });

  it("reuses an exact retryable receipt without rewriting its state", async () => {
    const retryInput = { ...INPUT, classification: "infra_failure" as const };
    const stored = storedReceipt(retryInput, "failed");
    const harness = receiptHarness(stored);

    await expect(startBehaviorVerificationRunStage(harness.client as never, retryInput)).resolves.toMatchObject({
      id: retryInput.id,
      status: "failed",
      classification: "infra_failure",
      shouldRun: true,
    });
    expect(harness.queries.filter(({ sql }) => /UPDATE|DO UPDATE/u.test(sql))).toHaveLength(0);
    expect(stored).toEqual(storedReceipt(retryInput, "failed"));
  });

  const mutations: ReadonlyArray<{
    readonly name: string;
    readonly mutate: (input: WriteBehaviorVerificationRunStageInput) => WriteBehaviorVerificationRunStageInput;
  }> = [
    { name: "org", mutate: (input) => ({ ...input, orgId: "org_other" }) },
    { name: "project", mutate: (input) => ({ ...input, projectId: "project_other" }) },
    { name: "run identity", mutate: (input) => ({ ...input, id: "verification_run_other" }) },
    { name: "workflow run", mutate: (input) => ({ ...input, runId: "workflow_run_other" }) },
    { name: "spec", mutate: (input) => ({ ...input, specId: "spec_other" }) },
    { name: "integration node", mutate: (input) => ({ ...input, integrationNodeId: "node_other" }) },
    { name: "resolution job", mutate: (input) => ({ ...input, resolutionJobId: "resolution_job_other" }) },
    { name: "stage", mutate: (input) => ({ ...input, stage: "baseline" }) },
    { name: "purpose", mutate: (input) => ({ ...input, purpose: "pre_merge" }) },
    { name: "environment", mutate: (input) => ({ ...input, environmentId: "environment_other" }) },
    { name: "prepared head", mutate: (input) => ({ ...input, preparedHeadSha: "b".repeat(40) }) },
    { name: "tree", mutate: (input) => ({ ...input, jjTreeId: "tree_other" }) },
    { name: "plan", mutate: (input) => ({ ...input, planSetHash: `sha256:${"b".repeat(64)}` }) },
    {
      name: "runtime context",
      mutate: (input) => ({ ...input, runtimeBehaviorContextHash: `sha256:${"b".repeat(64)}` }),
    },
    { name: "artifact", mutate: (input) => ({ ...input, artifactDigest: `sha256:${"b".repeat(64)}` }) },
    { name: "policy", mutate: (input) => ({ ...input, policy: { mode: "forged", version: 1 } }) },
    {
      name: "terminal classification and outcome",
      mutate: (input) => ({ ...input, classification: "product_failure" }),
    },
  ];

  it.each(mutations)(
    "rejects a $name mutation before a second runtime or settlement effect and preserves the row",
    async ({ mutate }) => {
      const stored = storedReceipt(INPUT, "completed");
      const snapshot = clone(stored);
      const harness = receiptHarness(stored);
      const runtime = vi.fn<() => void>();
      const settlement = vi.fn<() => void>();

      await expect(resume(harness.client, mutate(INPUT), runtime, settlement)).rejects.toBeInstanceOf(
        BehaviorVerificationReceiptReplayError,
      );
      expect(runtime).not.toHaveBeenCalled();
      expect(settlement).not.toHaveBeenCalled();
      expect(harness.queries.filter(({ sql }) => /UPDATE|DO UPDATE/u.test(sql))).toHaveLength(0);
      expect(stored).toEqual(snapshot);
    },
  );

  it("does not turn a mismatched failed receipt into retryable state", async () => {
    const retryInput = { ...INPUT, classification: "infra_failure" as const };
    const stored = storedReceipt(retryInput, "failed");
    const snapshot = clone(stored);
    const harness = receiptHarness(stored);
    const runtime = vi.fn<() => void>();
    const settlement = vi.fn<() => void>();

    await expect(
      resume(harness.client, { ...retryInput, artifactDigest: `sha256:${"b".repeat(64)}` }, runtime, settlement),
    ).rejects.toBeInstanceOf(BehaviorVerificationReceiptReplayError);
    expect(runtime).not.toHaveBeenCalled();
    expect(settlement).not.toHaveBeenCalled();
    expect(stored).toEqual(snapshot);
    expect(harness.queries.filter(({ sql }) => /UPDATE|DO UPDATE/u.test(sql))).toHaveLength(0);
  });
});

function storedReceipt(
  input: WriteBehaviorVerificationRunStageInput,
  status: BehaviorVerificationRunStageInput["status"],
): StoredReceipt {
  return {
    org_id: input.orgId,
    id: input.id,
    project_id: input.projectId,
    purpose: input.purpose,
    run_id: input.runId ?? null,
    spec_id: input.specId ?? null,
    integration_node_id: input.integrationNodeId ?? null,
    environment_id: input.environmentId,
    prepared_head_sha: input.preparedHeadSha,
    jj_tree_id: input.jjTreeId,
    plan_set_hash: input.planSetHash,
    runtime_behavior_context_hash: input.runtimeBehaviorContextHash,
    artifact_digest: input.artifactDigest,
    policy: clone(input.policy),
    stage: input.stage,
    resolution_job_id: input.resolutionJobId,
    classification: input.classification,
    status: status ?? "running",
  };
}

type BehaviorVerificationRunStageInput = WriteBehaviorVerificationRunStageInput;

function receiptHarness(initial: StoredReceipt | undefined) {
  let stored = initial;
  const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, params: readonly unknown[]) {
      queries.push({ sql, params });
      if (sql.startsWith("INSERT")) {
        if (stored === undefined) {
          stored = {
            org_id: params[0],
            id: params[1],
            project_id: params[2],
            purpose: params[3],
            run_id: params[4],
            spec_id: params[5],
            integration_node_id: params[6],
            environment_id: params[7],
            prepared_head_sha: params[8],
            jj_tree_id: params[9],
            plan_set_hash: params[10],
            runtime_behavior_context_hash: params[11],
            artifact_digest: params[12],
            status: params[13],
            policy: JSON.parse(String(params[14])) as unknown,
            stage: params[15],
            resolution_job_id: params[16],
            classification: params[17],
          };
          return { rows: [clone(stored)], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      return { rows: stored === undefined ? [] : [clone(stored)], rowCount: stored === undefined ? 0 : 1 };
    },
  };
  return { client, queries };
}

async function resume(
  client: unknown,
  input: WriteBehaviorVerificationRunStageInput,
  runtime: () => void,
  settlement: () => void,
) {
  const started = await startBehaviorVerificationRunStage(client as never, input);
  if (started.shouldRun) runtime();
  if (!started.shouldRun) settlement();
  return started;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
