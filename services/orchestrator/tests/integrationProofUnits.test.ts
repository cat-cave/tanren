import { describe, expect, it, vi } from "vitest";
import { composeProofRoot, IntegrationProofUnitGraph } from "../src/engine/dag/integrationProofUnits.js";
import type { AppendEventInput, EventStore } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import { createInMemoryIntegrationProofUnitStore } from "./conformance/fakes/inMemoryMergeQueue.js";

const hash = (letter: string): string => `sha256:${letter.repeat(64)}`;
type TestRun = () => Promise<{ verdict: "pass" | "fail"; artifactHash?: string }>;

class RecordingEvents implements EventStore {
  readonly events: Array<{ type: EventName; payload: unknown }> = [];
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.events.push({ type: input.eventType, payload: input.payload });
  }
}

function seedNode(store: ReturnType<typeof createInMemoryIntegrationProofUnitStore>, nodeId: string): void {
  store.db.integrationNodes.push({
    node_id: nodeId,
    org_id: "org_a",
    project_id: "project_a",
    proof_root: null,
    quarantine_epoch: null,
    toolchain_hash: null,
    design_contract_version: null,
    behavior_manifest_hash: null,
  });
}

describe("MQ-6 integration proof units", () => {
  it("records a unit DAG, composes its root, and reuses each identical unit without recomputing", async () => {
    const store = createInMemoryIntegrationProofUnitStore();
    const events = new RecordingEvents();
    seedNode(store, "inode_a");
    seedNode(store, "inode_b");
    const graph = new IntegrationProofUnitGraph(store, events);
    const tierRun = vi.fn<TestRun>(async () => ({ verdict: "pass", artifactHash: hash("a") }));
    const stepRun = vi.fn<TestRun>(async () => ({ verdict: "pass", artifactHash: hash("b") }));
    const units = [
      { key: "tier", kind: "native_ci_tier", subjectId: "pre_merge", inputHash: hash("c"), run: tierRun },
      {
        key: "step",
        kind: "native_ci_step",
        subjectId: "typecheck",
        inputHash: hash("d"),
        dependsOn: ["tier"],
        run: stepRun,
      },
    ];
    const first = await graph.evaluate({
      orgId: "org_a",
      projectId: "project_a",
      nodeId: "inode_a",
      evaluationId: "eval_a",
      quarantineEpoch: 0,
      toolchainHash: hash("e"),
      designContractVersion: "design-v1",
      behaviorManifestHash: hash("f"),
      units,
    });
    expect(tierRun).toHaveBeenCalledTimes(1);
    expect(stepRun).toHaveBeenCalledTimes(1);
    expect(events.events.map((event) => event.type)).toContain("integration.proof_unit.recorded");
    expect(events.events.map((event) => event.type)).toContain("integration.proof_root.composed");
    const persisted = await store.evaluationGraph({ orgId: "org_a", projectId: "project_a", evaluationId: "eval_a" });
    expect(persisted.edges).toHaveLength(1);
    expect(first.proofRoot).toBe(composeProofRoot(persisted.units, persisted.edges));
    expect(store.db.integrationNodes[0]).toMatchObject({
      proof_root: first.proofRoot,
      quarantine_epoch: 0,
      toolchain_hash: hash("e"),
      design_contract_version: "design-v1",
      behavior_manifest_hash: hash("f"),
    });

    const reuseTier = vi.fn<TestRun>(async () => ({ verdict: "fail" }));
    const reuseStep = vi.fn<TestRun>(async () => ({ verdict: "fail" }));
    const second = await graph.evaluate({
      orgId: "org_a",
      projectId: "project_a",
      nodeId: "inode_b",
      evaluationId: "eval_b",
      quarantineEpoch: 0,
      toolchainHash: hash("e"),
      designContractVersion: "design-v1",
      behaviorManifestHash: hash("f"),
      units: [
        { key: "tier", kind: "native_ci_tier", subjectId: "pre_merge", inputHash: hash("c"), run: reuseTier },
        {
          key: "step",
          kind: "native_ci_step",
          subjectId: "typecheck",
          inputHash: hash("d"),
          dependsOn: ["tier"],
          run: reuseStep,
        },
      ],
    });
    expect(reuseTier).not.toHaveBeenCalled();
    expect(reuseStep).not.toHaveBeenCalled();
    expect(second.units.every((unit) => unit.reused)).toBe(true);
    expect(second.proofRoot).toBe(first.proofRoot);
    expect(events.events.filter((event) => event.type === "integration.proof_unit.reused")).toHaveLength(2);

    const changed = vi.fn<TestRun>(async () => ({ verdict: "pass" }));
    await graph.evaluate({
      orgId: "org_a",
      projectId: "project_a",
      nodeId: "inode_b",
      evaluationId: "eval_c",
      quarantineEpoch: 0,
      toolchainHash: hash("e"),
      designContractVersion: "design-v1",
      behaviorManifestHash: hash("f"),
      units: [{ key: "tier", kind: "native_ci_tier", subjectId: "pre_merge", inputHash: hash("9"), run: changed }],
    });
    expect(changed).toHaveBeenCalledTimes(1);

    const epochBump = vi.fn<TestRun>(async () => ({ verdict: "pass" }));
    await graph.evaluate({
      orgId: "org_a",
      projectId: "project_a",
      nodeId: "inode_b",
      evaluationId: "eval_d",
      quarantineEpoch: 1,
      toolchainHash: hash("e"),
      designContractVersion: "design-v1",
      behaviorManifestHash: hash("f"),
      units: [{ key: "tier", kind: "native_ci_tier", subjectId: "pre_merge", inputHash: hash("c"), run: epochBump }],
    });
    expect(epochBump).toHaveBeenCalledTimes(1);
    expect(events.events.map((event) => event.type)).toContain("integration.proof.invalidated");

    const changedStamp = vi.fn<TestRun>(async () => ({ verdict: "pass" }));
    const changedStampResult = await graph.evaluate({
      orgId: "org_a",
      projectId: "project_a",
      nodeId: "inode_b",
      evaluationId: "eval_e",
      quarantineEpoch: 1,
      toolchainHash: hash("z"),
      designContractVersion: "design-v1",
      behaviorManifestHash: hash("f"),
      units: [{ key: "tier", kind: "native_ci_tier", subjectId: "pre_merge", inputHash: hash("c"), run: changedStamp }],
    });
    expect(changedStamp).toHaveBeenCalledTimes(1);
    expect(changedStampResult.units[0]?.reused).toBe(false);
  });
});
