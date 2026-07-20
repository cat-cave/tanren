import { describe, expect, it, vi } from "vitest";
import { composeProofRoot, IntegrationProofUnitGraph } from "../src/engine/dag/integrationProofUnits.js";
import type { AppendEventInput, EventStore } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import type { IntegrationProofUnit } from "../src/engine/repositories/integrationProofUnits.js";
import { createInMemoryIntegrationProofUnitStore } from "./conformance/fakes/inMemoryMergeQueue.js";

const hash = (letter: string): string => `sha256:${letter.repeat(64)}`;
type TestRun = () => Promise<{ verdict: "pass" | "fail"; artifactHash?: string }>;

class RecordingEvents implements EventStore {
  readonly events: Array<{ type: EventName; payload: unknown }> = [];
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.events.push({ type: input.eventType, payload: input.payload });
  }
}

function bySubject(
  units: ReadonlyArray<{ readonly subjectId: string; readonly reused: boolean; readonly proofUnitId: string }>,
): Map<string, { readonly reused: boolean; readonly proofUnitId: string }> {
  return new Map(units.map((unit) => [unit.subjectId, { reused: unit.reused, proofUnitId: unit.proofUnitId }]));
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

function proofUnit(proofUnitId: string): IntegrationProofUnit {
  return {
    orgId: "org_a",
    projectId: "project_a",
    proofUnitId,
    kind: "eager_materialization",
    subjectId: proofUnitId,
    inputHash: hash("a"),
    verdict: "pass",
    quarantineEpoch: 0,
  };
}

describe("MQ-6 integration proof units", () => {
  it("fails closed for malformed EAGER proof work and proof graphs", async () => {
    const store = createInMemoryIntegrationProofUnitStore();
    seedNode(store, "inode_fail_closed");
    const graph = new IntegrationProofUnitGraph(store, new RecordingEvents());
    const input = {
      orgId: "org_a",
      projectId: "project_a",
      nodeId: "inode_fail_closed",
      evaluationId: "eval_fail_closed",
      quarantineEpoch: 0,
      toolchainHash: hash("b"),
      designContractVersion: "design-v1",
      behaviorManifestHash: hash("c"),
    };
    const work = {
      key: "exact",
      kind: "eager_materialization",
      subjectId: "frontier",
      inputHash: hash("d"),
      run: async () => ({ verdict: "pass" as const }),
    };

    await expect(graph.evaluate({ ...input, units: [work, work] })).rejects.toThrow("duplicate proof-unit work key");
    await expect(
      graph.evaluate({ ...input, units: [{ ...work, dependsOn: ["missing_exact_member"] }] }),
    ).rejects.toThrow("depends on unknown missing_exact_member");
    expect(composeProofRoot([], [])).toMatch(/^sha256:/u);
    expect(() => composeProofRoot([proofUnit("one")], [{ parentUnitId: "one", childUnitId: "absent" }])).toThrow(
      "outside the evaluation",
    );
    expect(() => composeProofRoot([proofUnit("one")], [{ parentUnitId: "one", childUnitId: "one" }])).toThrow(
      "no root",
    );
    expect(() =>
      composeProofRoot(
        [proofUnit("root"), proofUnit("left"), proofUnit("right")],
        [
          { parentUnitId: "left", childUnitId: "right" },
          { parentUnitId: "right", childUnitId: "left" },
        ],
      ),
    ).toThrow("disconnected cycle");
    expect(() =>
      composeProofRoot(
        [proofUnit("root"), proofUnit("left"), proofUnit("right")],
        [
          { parentUnitId: "root", childUnitId: "left" },
          { parentUnitId: "left", childUnitId: "right" },
          { parentUnitId: "right", childUnitId: "left" },
        ],
      ),
    ).toThrow("contains a cycle");
    expect(
      composeProofRoot(
        [proofUnit("root_a"), proofUnit("root_b"), proofUnit("shared")],
        [
          { parentUnitId: "root_a", childUnitId: "shared" },
          { parentUnitId: "root_b", childUnitId: "shared" },
        ],
      ),
    ).toMatch(/^sha256:/u);
  });

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

  // MQ-6 follow-up (#26): PIN per-unit isolation in a MULTI-unit batch. The reuse key binds
  // each unit's real content/stamp digest independently, so a changed unit must be re-proven
  // while an UNCHANGED sibling reuses — in the SAME evaluation. No cross-unit contamination:
  // the changed unit never inherits the sibling's proof, and the reused unit returns the exact
  // prior evidence row rather than a fresh record.
  it("re-proves only the digest-changed unit and reuses the unchanged sibling in a multi-unit batch", async () => {
    const store = createInMemoryIntegrationProofUnitStore();
    const events = new RecordingEvents();
    seedNode(store, "inode_multi_1");
    seedNode(store, "inode_multi_2");
    seedNode(store, "inode_multi_3");
    const graph = new IntegrationProofUnitGraph(store, events);
    const stamp = {
      quarantineEpoch: 0,
      toolchainHash: hash("e"),
      designContractVersion: "design-v1",
      behaviorManifestHash: hash("f"),
    } as const;

    // Prove both units once. `tier` = subject pre_merge; `step` = subject typecheck (depends on tier).
    const tier1 = vi.fn<TestRun>(async () => ({ verdict: "pass", artifactHash: hash("a") }));
    const step1 = vi.fn<TestRun>(async () => ({ verdict: "pass", artifactHash: hash("b") }));
    const first = await graph.evaluate({
      orgId: "org_a",
      projectId: "project_a",
      nodeId: "inode_multi_1",
      evaluationId: "eval_multi_1",
      ...stamp,
      units: [
        { key: "tier", kind: "native_ci_tier", subjectId: "pre_merge", inputHash: hash("c"), run: tier1 },
        {
          key: "step",
          kind: "native_ci_step",
          subjectId: "typecheck",
          inputHash: hash("d"),
          dependsOn: ["tier"],
          run: step1,
        },
      ],
    });
    expect(tier1).toHaveBeenCalledTimes(1);
    expect(step1).toHaveBeenCalledTimes(1);
    const firstBySubject = bySubject(first.units);

    // Re-run: ONLY `tier`'s input digest changes. `step` is byte-identical. A `step` run here would
    // return `fail`, corrupting the recomposed root — so its non-invocation is load-bearing proof of
    // isolation. The changed `tier` MUST re-prove; the unchanged `step` MUST reuse its exact row.
    const tier2 = vi.fn<TestRun>(async () => ({ verdict: "pass", artifactHash: hash("9") }));
    const step2 = vi.fn<TestRun>(async () => ({ verdict: "fail" }));
    const tierChanged = await graph.evaluate({
      orgId: "org_a",
      projectId: "project_a",
      nodeId: "inode_multi_2",
      evaluationId: "eval_multi_2",
      ...stamp,
      units: [
        { key: "tier", kind: "native_ci_tier", subjectId: "pre_merge", inputHash: hash("8"), run: tier2 },
        {
          key: "step",
          kind: "native_ci_step",
          subjectId: "typecheck",
          inputHash: hash("d"),
          dependsOn: ["tier"],
          run: step2,
        },
      ],
    });
    expect(tier2).toHaveBeenCalledTimes(1);
    expect(step2).not.toHaveBeenCalled();
    const tierChangedBySubject = bySubject(tierChanged.units);
    expect(tierChangedBySubject.get("pre_merge")?.reused).toBe(false);
    expect(tierChangedBySubject.get("typecheck")?.reused).toBe(true);
    // No cross-contamination: the changed unit gets a FRESH row; the reused sibling returns the
    // EXACT prior evidence row (not a re-record, not the sibling's proof).
    expect(tierChangedBySubject.get("pre_merge")?.proofUnitId).not.toBe(firstBySubject.get("pre_merge")?.proofUnitId);
    expect(tierChangedBySubject.get("typecheck")?.proofUnitId).toBe(firstBySubject.get("typecheck")?.proofUnitId);
    // A changed unit shifts the composed root; a false reuse of the sibling would have kept it equal.
    expect(tierChanged.proofRoot).not.toBe(first.proofRoot);

    // The symmetric direction: ONLY `step`'s digest changes; `tier` is unchanged and MUST reuse.
    const tier3 = vi.fn<TestRun>(async () => ({ verdict: "fail" }));
    const step3 = vi.fn<TestRun>(async () => ({ verdict: "pass", artifactHash: hash("7") }));
    const stepChanged = await graph.evaluate({
      orgId: "org_a",
      projectId: "project_a",
      nodeId: "inode_multi_3",
      evaluationId: "eval_multi_3",
      ...stamp,
      units: [
        { key: "tier", kind: "native_ci_tier", subjectId: "pre_merge", inputHash: hash("c"), run: tier3 },
        {
          key: "step",
          kind: "native_ci_step",
          subjectId: "typecheck",
          inputHash: hash("6"),
          dependsOn: ["tier"],
          run: step3,
        },
      ],
    });
    expect(tier3).not.toHaveBeenCalled();
    expect(step3).toHaveBeenCalledTimes(1);
    const stepChangedBySubject = bySubject(stepChanged.units);
    expect(stepChangedBySubject.get("pre_merge")?.reused).toBe(true);
    expect(stepChangedBySubject.get("typecheck")?.reused).toBe(false);
    // The reused `tier` returns the original row; the changed `step` is a fresh, distinct record.
    expect(stepChangedBySubject.get("pre_merge")?.proofUnitId).toBe(firstBySubject.get("pre_merge")?.proofUnitId);
    expect(stepChangedBySubject.get("typecheck")?.proofUnitId).not.toBe(firstBySubject.get("typecheck")?.proofUnitId);
  });
});
