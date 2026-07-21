import { describe, expect, it, vi } from "vitest";
import { parseDigest } from "../src/engine/contracts/cas.js";
import type { GateProofBundleV2 } from "../src/engine/contracts/gateProof.js";
import { type IntegrationNode, memberKey } from "../src/engine/contracts/integrationNodes.js";
import type { BatchCheckVerdict } from "../src/engine/contracts/batchMergeCoordinator.js";
import type { AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import {
  type BatchNodeDriveDeps,
  type BatchNodeDriveFacts,
  type BatchNodeStore,
  batchLocalIntegrationRef,
  driveBatchThroughNode,
} from "../src/engine/merge/batchIntegrationNodeDrive.js";
import type { JjLocalIntegrationResult } from "../src/engine/dag/jjLocalIntegration.js";
import type { CoverageAuthorityReadyNodeInput } from "../src/engine/runtimeVerification/coverageAuthorityMaterializer.js";
import type { GateProofBundleInput, GateProofBundleSealer } from "../src/engine/merge/gateProofBundleTypes.js";

type GateFn = () => Promise<{ verdict: BatchCheckVerdict; passed: boolean }>;

class FakeGateBundles implements GateProofBundleSealer {
  private readonly bundles = new Map<string, GateProofBundleV2>();
  private readonly sealedSectionDigests = new Map<string, readonly string[]>();
  private sequence = 0;
  includeRuntimeBehavior = false;

  async seal(input: GateProofBundleInput): Promise<GateProofBundleV2> {
    const sequence = ++this.sequence;
    const sectionDigest = parseDigest(`sha256:${sequence.toString(16).padStart(64, "0")}`);
    const bundle: GateProofBundleV2 = {
      gateProofBundleId: `gate_proof_bundle:${input.nodeId}:${sequence}`,
      proofBundleDigest: parseDigest(`sha256:${(sequence + 10).toString(16).padStart(64, "0")}`),
      proofRoot: parseDigest(`sha256:${(sequence + 20).toString(16).padStart(64, "0")}`),
      integrationNodeId: input.nodeId,
      proofKeyInput: input.proofKeyInput,
      plan: {
        required: {
          native_ci: true,
          runtime_behavior: this.includeRuntimeBehavior,
          design_render: false,
          artifact_provenance: false,
        },
      },
      sections: [
        {
          kind: "native_ci",
          required: true,
          verdict: input.nativeCi.verdict,
          unitDigests: [sectionDigest],
        },
        ...(this.includeRuntimeBehavior
          ? [
              {
                kind: "runtime_behavior" as const,
                required: true,
                verdict: "passed" as const,
                unitDigests: [parseDigest(`sha256:${"e".repeat(64)}`)],
              },
            ]
          : []),
      ],
      gateVerdict: input.nativeCi.verdict,
    };
    const key = bundleKey(input);
    this.bundles.set(key, bundle);
    this.sealedSectionDigests.set(key, sectionDigests(bundle));
    return bundle;
  }

  async findExact(input: Omit<GateProofBundleInput, "nativeCi">): Promise<GateProofBundleV2 | undefined> {
    const key = bundleKey(input);
    const bundle = this.bundles.get(key);
    return bundle !== undefined && sameStrings(sectionDigests(bundle), this.sealedSectionDigests.get(key))
      ? bundle
      : undefined;
  }

  corruptSection(input: Omit<GateProofBundleInput, "nativeCi">): void {
    const key = bundleKey(input);
    const bundle = this.bundles.get(key);
    if (bundle === undefined) throw new Error("cannot corrupt a missing fake V2 bundle");
    this.bundles.set(key, {
      ...bundle,
      sections: bundle.sections.map((section, index) =>
        index === 0 ? { ...section, unitDigests: [parseDigest(`sha256:${"f".repeat(64)}`)] } : section,
      ),
    });
  }
}

function bundleKey(input: Omit<GateProofBundleInput, "nativeCi">): string {
  return JSON.stringify({
    orgId: input.orgId,
    projectId: input.projectId,
    nodeId: input.nodeId,
    baseSha: input.baseSha,
    headSha: input.headSha,
    treeHash: input.treeHash,
    memberSetHash: input.memberSetHash,
    members: input.members,
    gateConfigHash: input.gateConfigHash,
    policyVersion: input.policyVersion,
    proofKeyInput: input.proofKeyInput,
  });
}

function sectionDigests(bundle: GateProofBundleV2): string[] {
  return bundle.sections.flatMap((section) => section.unitDigests).sort();
}

function sameStrings(left: readonly string[], right: readonly string[] | undefined): boolean {
  return right !== undefined && left.length === right.length && left.every((value, index) => value === right[index]);
}

class FakeNodeStore implements BatchNodeStore {
  readonly nodes = new Map<string, IntegrationNode>();
  readonly gateBundles = new FakeGateBundles();
  hostRefsWritten: string[] = [];

  async materializeReadyNode(input: CoverageAuthorityReadyNodeInput): Promise<string> {
    const key = memberKey(
      input.baseSha,
      input.members.map((m) => m.headSha),
    );
    const nodeId = `inode_${key.slice(0, 8)}`;
    this.nodes.set(key, {
      nodeId,
      baseBranch: input.baseBranch,
      baseSha: input.baseSha,
      ref: input.ref,
      purpose: input.purpose,
      members: input.members,
      memberKey: key,
      gateConfigHash: input.gateConfigHash ?? "",
      policyVersion: input.policyVersion ?? "",
      affectedFingerprint: "rv4-test-authority",
      headSha: input.headSha,
      treeHash: input.treeHash,
      status: "ready",
    });
    return nodeId;
  }

  async findByMemberKey(_orgId: string, key: string): Promise<IntegrationNode | undefined> {
    return this.nodes.get(key);
  }
}

class RecordingEventStore {
  readonly appended: Array<{ eventType: EventName; payload: unknown }> = [];
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.appended.push({ eventType: input.eventType, payload: input.payload });
  }
}

const FACTS: BatchNodeDriveFacts = {
  orgId: "org_1",
  projectId: "project_1",
  baseBranch: "main",
  baseSha: "0".repeat(40),
  repoUrl: "https://github.com/acme/app.git",
  runnerImage: "ghcr.io/tanren/runner:latest",
  tailSpecId: "spec_tail",
  members: [
    { specId: "spec_a", runId: "run_a", branch: "tanren/spec_a" },
    { specId: "spec_b", runId: "run_b", branch: "tanren/spec_b" },
  ],
  policyVersion: "1",
  quarantineVersion: "1",
};

const MEMBER_HEAD_SHAS = { spec_a: "a".repeat(40), spec_b: "b".repeat(40) };
const INTEGRATED_HEAD = "c".repeat(40);

function fakeIntegratePort(store: FakeNodeStore, baseSha = FACTS.baseSha): BatchNodeDriveDeps["integrate"] {
  return async (_workspaceDeps, input, onIntegrated) => {
    expect(input.localRef).toBe(batchLocalIntegrationRef(FACTS.tailSpecId));
    expect(input.localRef.startsWith("tanren/integ")).toBe(false);
    expect(input.localRef.startsWith("tanren/batch")).toBe(false);
    store.hostRefsWritten = [];
    const integrated: Extract<JjLocalIntegrationResult, { outcome: "integrated" }> = {
      outcome: "integrated",
      localRef: input.localRef,
      baseSha,
      headSha: INTEGRATED_HEAD,
      treeHash: "tree-deadbeef",
      memberHeadShas: MEMBER_HEAD_SHAS,
    };
    const value = await onIntegrated({ target: {} as never, workspacePath: "/workspace" } as never, integrated);
    return { outcome: "integrated", value };
  };
}

function deps(
  store: FakeNodeStore,
  events: RecordingEventStore,
  gateSpy: ReturnType<typeof vi.fn>,
  integratedBaseSha = FACTS.baseSha,
): BatchNodeDriveDeps {
  return {
    nodes: store,
    gateBundles: store.gateBundles,
    eventStore: events as never,
    jjWorkspaceDeps: { ssh: {} as never } as never,
    integrate: fakeIntegratePort(store, integratedBaseSha),
    resolveConfig: async () =>
      ({
        version: 1,
        tiers: { fast: [{ name: "t", run: "x" }], slow: [{ name: "s", run: "y" }] },
        when: { fast: ["pre_merge"], slow: ["pre_merge"] },
      }) as never,
    gate: async () => {
      const result = await gateSpy();
      return {
        ...result,
        nativeCi: {
          gateConfigHash: "fake-config-hash",
          tiers: ["fast", "slow"],
          steps: [{ name: "t", tier: "fast", passed: result.passed }],
          junit: { total: 1, failures: result.passed ? 0 : 1, skipped: 0 },
          verdict: result.passed ? "passed" : "failed",
        },
      };
    },
    materializeReadyNode: (input) => store.materializeReadyNode(input),
  };
}

describe("driveBatchThroughNode — §3 proof reuse at the batch verdict site", () => {
  it("RECOMPUTE on a cache miss runs the gate + records a passing proof; the SECOND check REUSES (gate NOT called)", async () => {
    const store = new FakeNodeStore();
    const events = new RecordingEventStore();
    const gate = vi.fn<GateFn>(async () => ({
      verdict: { result: "pass" as const, integrationBranch: "x" },
      passed: true,
    }));

    // First check: cache miss → the gate RUNS.
    const first = await driveBatchThroughNode(FACTS, deps(store, events, gate));
    expect(first.result).toBe("pass");
    if (first.result !== "pass") throw new Error("expected a passing exact-node verdict");
    const authorityBinding = first.authorityBinding;
    expect(authorityBinding).toBeDefined();
    if (authorityBinding === undefined) throw new Error("passing node verdict omitted its proof binding");
    expect(authorityBinding).toMatchObject({
      baseSha: FACTS.baseSha,
      headSha: INTEGRATED_HEAD,
      members: [
        { specId: "spec_a", runId: "run_a", headSha: MEMBER_HEAD_SHAS.spec_a },
        { specId: "spec_b", runId: "run_b", headSha: MEMBER_HEAD_SHAS.spec_b },
      ],
      proof: { verdict: "passed" },
    });
    expect(authorityBinding.proof).toMatchObject({
      gateProofBundleId: `gate_proof_bundle:${authorityBinding.nodeId}:1`,
      proofRoot: `sha256:${"15".padStart(64, "0")}`,
    });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(events.appended).toContainEqual({
      eventType: "integration.proof.recorded",
      payload: expect.objectContaining({ nodeId: authorityBinding.nodeId, verdict: "passed" }),
    });

    // The node's memberKey is `hash(baseSha + ordered member HEAD shas)` — the SAME the
    // server build would key (member-key equality / "same landable content").
    const expectedKey = memberKey(FACTS.baseSha, [MEMBER_HEAD_SHAS.spec_a, MEMBER_HEAD_SHAS.spec_b]);
    expect(store.nodes.has(expectedKey)).toBe(true);
    expect(store.nodes.get(expectedKey)?.headSha).toBe(INTEGRATED_HEAD);
    // NO host ref was written by the jj-local integration.
    expect(store.hostRefsWritten).toEqual([]);

    // Second check: SAME six components → the recorded passing proof short-circuits the
    // gate. THE proof-reuse-SKIPS-a-re-gate assertion: the gate spy is NOT called again.
    const gate2 = vi.fn<GateFn>(async () => ({
      verdict: { result: "pass" as const, integrationBranch: "x" },
      passed: true,
    }));
    const events2 = new RecordingEventStore();
    const d2 = deps(store, events2, gate2);
    const second = await driveBatchThroughNode(FACTS, d2);
    expect(second.result).toBe("pass");
    expect(gate2).not.toHaveBeenCalled();
    expect(events2.appended).toContainEqual({
      eventType: "integration.proof.reused",
      payload: expect.objectContaining({
        gateProofBundleId: authorityBinding.proof.gateProofBundleId,
        proofBundleDigest: authorityBinding.proof.proofBundleDigest,
        baseSha: FACTS.baseSha,
        headSha: INTEGRATED_HEAD,
      }),
    });
  });

  it("a fresh seal with a behavior-proof section emits bound, never reused", async () => {
    const store = new FakeNodeStore();
    store.gateBundles.includeRuntimeBehavior = true;
    const events = new RecordingEventStore();
    const gate = vi.fn<GateFn>(async () => ({
      verdict: { result: "pass" as const, integrationBranch: "x" },
      passed: true,
    }));

    await expect(driveBatchThroughNode(FACTS, deps(store, events, gate))).resolves.toMatchObject({ result: "pass" });
    expect(events.appended).toContainEqual({
      eventType: "gate.behavior_proof.bound",
      payload: expect.objectContaining({ requiredBehaviorRevisionCount: 1 }),
    });
    expect(events.appended.some((event) => event.eventType === "integration.proof.reused")).toBe(false);
  });

  it("DRIFT (a changed runnerImage) forces the gate to RUN — no stale reuse", async () => {
    const store = new FakeNodeStore();
    const gate = vi.fn<GateFn>(async () => ({
      verdict: { result: "pass" as const, integrationBranch: "x" },
      passed: true,
    }));
    await driveBatchThroughNode(FACTS, deps(store, new RecordingEventStore(), gate));
    expect(gate).toHaveBeenCalledTimes(1);

    const gate2 = vi.fn<GateFn>(async () => ({
      verdict: { result: "fail" as const, message: "drift" },
      passed: false,
    }));
    const driftFacts: BatchNodeDriveFacts = { ...FACTS, runnerImage: "ghcr.io/tanren/runner:OTHER" };
    const drifted = await driveBatchThroughNode(driftFacts, deps(store, new RecordingEventStore(), gate2));
    expect(drifted.result).toBe("fail");
    expect(gate2).toHaveBeenCalledTimes(1);
  });

  it("a NON-PASSING recompute records a failed proof; the next identical key RECOMPUTES (never reuses a fail)", async () => {
    const store = new FakeNodeStore();
    const failGate = vi.fn<GateFn>(async () => ({
      verdict: { result: "fail" as const, message: "boom" },
      passed: false,
    }));
    const first = await driveBatchThroughNode(FACTS, deps(store, new RecordingEventStore(), failGate));
    expect(first.result).toBe("fail");
    expect(failGate).toHaveBeenCalledTimes(1);

    // reuse). OBSERVABLE OUTCOME: the recompute's fresh PASS verdict flows back (a reuse
    // of the stale FAILED proof would instead have returned without running gate2).
    const gate2 = vi.fn<GateFn>(async () => ({
      verdict: { result: "pass" as const, integrationBranch: "x" },
      passed: true,
    }));
    const second = await driveBatchThroughNode(FACTS, deps(store, new RecordingEventStore(), gate2));
    expect(second.result).toBe("pass");
    expect(gate2).toHaveBeenCalledTimes(1);
  });

  it("holds for re-drive when the cloned base differs from the pre-clone host read", async () => {
    const store = new FakeNodeStore();
    const gate = vi.fn<GateFn>();
    const verdict = await driveBatchThroughNode(FACTS, deps(store, new RecordingEventStore(), gate, "9".repeat(40)));
    expect(verdict).toMatchObject({ result: "infra-error", retriable: true });
    expect(store.nodes.size).toBe(0);
    expect(gate).not.toHaveBeenCalled();
  });

  it("maps a resolver exception to a full-gate fallback observation instead of allowing evidence to bypass the gate", async () => {
    const store = new FakeNodeStore();
    const gate = vi.fn<GateFn>(async () => ({
      verdict: { result: "fail" as const, message: "native gate still failed" },
      passed: false,
    }));
    const driven = deps(store, new RecordingEventStore(), gate);
    driven.resolveFragmentEvidence = async () => {
      throw new Error("manifest transport failed");
    };

    await expect(driveBatchThroughNode(FACTS, driven)).resolves.toEqual({
      result: "fail",
      message: "native gate still failed",
    });
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it("preserves a passing native-gate verdict when best-effort evidence capture throws", async () => {
    const store = new FakeNodeStore();
    const capture = vi.fn<() => Promise<void>>(async () => {
      throw new Error("CAS unavailable");
    });
    const gate = vi.fn<GateFn>(async () => ({
      verdict: { result: "pass" as const, integrationBranch: "x" },
      passed: true,
    }));
    const driven = deps(store, new RecordingEventStore(), gate);
    driven.resolveFragmentEvidence = async () =>
      ({
        kind: "selected",
        selector: { path: ".tanren/test-selector.json", format: "json", tests: ["tests/changed.test.ts"] },
        behaviorManifest: {
          path: ".tanren/behavior-manifest.json",
          format: "json",
          behaviors: ["changed behavior"],
        },
        artifactDigest: "sha256:" + "a".repeat(64),
        inputHash: "sha256:" + "b".repeat(64),
        manifest: {},
      }) as never;
    driven.captureFragmentEvidence = capture;

    await expect(driveBatchThroughNode(FACTS, driven)).resolves.toMatchObject({ result: "pass" });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("keeps a jj-reported conflict typed as a conflict instead of attempting a gate", async () => {
    const store = new FakeNodeStore();
    const gate = vi.fn<GateFn>();
    const driven = deps(store, new RecordingEventStore(), gate);
    driven.integrate = async () =>
      ({
        outcome: "conflict",
        message: "spec_a conflicts with main",
        conflictBetween: { specId: "spec_a", otherSpecId: "main" },
      }) as never;

    await expect(driveBatchThroughNode(FACTS, driven)).resolves.toEqual({
      result: "conflict",
      message: "spec_a conflicts with main",
      conflictsWithBase: true,
      conflictBetween: { specId: "spec_a", otherSpecId: "main" },
    });
    expect(gate).not.toHaveBeenCalled();
  });

  it("runs the full gate if the materialized node cannot be read back under its exact member key", async () => {
    const store = new FakeNodeStore();
    store.findByMemberKey = async () => {};
    const gate = vi.fn<GateFn>(async () => ({
      verdict: { result: "fail" as const, message: "node read-back requires a re-gate" },
      passed: false,
    }));

    await expect(driveBatchThroughNode(FACTS, deps(store, new RecordingEventStore(), gate))).resolves.toEqual({
      result: "fail",
      message: "node read-back requires a re-gate",
    });
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it("runs the full gate when a proof-key identity component is absent", async () => {
    const store = new FakeNodeStore();
    const gate = vi.fn<GateFn>(async () => ({
      verdict: { result: "fail" as const, message: "policy identity is unresolved" },
      passed: false,
    }));

    await expect(
      driveBatchThroughNode({ ...FACTS, policyVersion: undefined }, deps(store, new RecordingEventStore(), gate)),
    ).resolves.toEqual({ result: "fail", message: "policy identity is unresolved" });
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a sealed V2 section digest is changed: it re-runs the full gate", async () => {
    const store = new FakeNodeStore();
    const firstGate = vi.fn<GateFn>(async () => ({
      verdict: { result: "pass", integrationBranch: "x" },
      passed: true,
    }));
    const first = await driveBatchThroughNode(FACTS, deps(store, new RecordingEventStore(), firstGate));
    if (first.result !== "pass" || first.authorityBinding === undefined) throw new Error("expected V2 proof");
    const binding = first.authorityBinding;
    store.gateBundles.corruptSection({
      orgId: FACTS.orgId,
      projectId: FACTS.projectId,
      nodeId: binding.nodeId,
      baseSha: binding.baseSha,
      headSha: binding.headSha,
      treeHash: binding.treeHash,
      memberSetHash: binding.memberSetHash,
      members: binding.members,
      gateConfigHash: binding.gateConfigHash,
      policyVersion: binding.policyVersion,
      proofKeyInput: binding.proof.keyInput,
    });
    const rerun = vi.fn<GateFn>(async () => ({ verdict: { result: "fail", message: "seal changed" }, passed: false }));
    await expect(driveBatchThroughNode(FACTS, deps(store, new RecordingEventStore(), rerun))).resolves.toEqual({
      result: "fail",
      message: "seal changed",
    });
    expect(rerun).toHaveBeenCalledTimes(1);
  });

  it("negative control: an excluded changed test records only a fallback observation, runs the full gate, and cannot return a mergeable pass", async () => {
    const store = new FakeNodeStore();
    const gate = vi.fn<GateFn>(async () => ({
      verdict: { result: "fail" as const, message: "unselected changed test failed" },
      passed: false,
    }));
    const driven = deps(store, new RecordingEventStore(), gate);
    driven.resolveFragmentEvidence = async () => ({ kind: "fallback", reason: "selector_set_mismatch" });

    const verdict = await driveBatchThroughNode(FACTS, driven);

    expect(verdict).toEqual({ result: "fail", message: "unselected changed test failed" });
    expect(gate).toHaveBeenCalledTimes(1);
  });
});
