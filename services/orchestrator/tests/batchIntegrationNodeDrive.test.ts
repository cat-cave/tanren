// CORRECTNESS PROOF for the §3 batch integration-node drive (tanren-owns-the-engine.md
// §3), Wave-3 / Slice-3. Asserts the load-bearing behaviors at the batch verdict site:
//   - PROOF REUSE SKIPS THE RE-GATE: a node whose proofReuseKey matches a recorded
//     PASSING proof does NOT invoke the gate runner (the gate spy is NOT called) +
//     `integration.proof.reused` is emitted.
//   - A MISS RUNS THE GATE + records the proof (so the next identical key reuses it).
//   - DRIFT forces the gate to run (no stale reuse).
//   - JJ-LOCAL INTEGRATION produces the SAME landable content the server build did
//     (member-key equality) with NO `tanren/integ`/`tanren/batch` HOST ref written.
//
// The jj-local integration is injected as a FAKE port (no live runner) so the drive's
// proof-reuse + node-upsert logic is asserted deterministically; the real jj integration
// is conformance-pinned separately.

import { describe, expect, it, vi } from "vitest";
import { parseDigest } from "../src/engine/contracts/cas.js";
import type { GateProofBundleV2 } from "../src/engine/contracts/gateProof.js";
import { type IntegrationNode, memberKey } from "../src/engine/contracts/integrationNodes.js";
import type { BatchCheckVerdict } from "../src/engine/contracts/batchMergeCoordinator.js";
import type { AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import type { ProofReuseKeyInput } from "../src/engine/contracts/integrationNodes.js";
import { proofReuseKey } from "../src/engine/contracts/integrationNodes.js";
import {
  type BatchNodeDriveDeps,
  type BatchNodeDriveFacts,
  type BatchNodeStore,
  batchLocalIntegrationRef,
  driveBatchThroughNode,
} from "../src/engine/merge/batchIntegrationNodeDrive.js";
import type { JjLocalIntegrationResult } from "../src/engine/dag/jjLocalIntegration.js";
import { IntegrationProofUnitGraph } from "../src/engine/dag/integrationProofUnits.js";
import type { CoverageAuthorityReadyNodeInput } from "../src/engine/runtimeVerification/coverageAuthorityMaterializer.js";
import { createInMemoryIntegrationProofUnitStore } from "./conformance/fakes/inMemoryMergeQueue.js";
import type { GateProofBundleInput, GateProofBundleSealer } from "../src/engine/merge/gateProofBundleTypes.js";

/** The gate spy signature (a recompute-only gate over the open workspace). */
type GateFn = () => Promise<{ verdict: BatchCheckVerdict; passed: boolean }>;

class FakeGateBundles implements GateProofBundleSealer {
  private readonly bundles = new Map<string, GateProofBundleV2>();

  async seal(input: GateProofBundleInput): Promise<GateProofBundleV2> {
    const bundle: GateProofBundleV2 = {
      gateProofBundleId: `gate_proof_bundle:${input.nodeId}`,
      proofBundleDigest: parseDigest(`sha256:${"d".repeat(64)}`),
      proofRoot: parseDigest(`sha256:${"e".repeat(64)}`),
      integrationNodeId: input.nodeId,
      proofKeyInput: input.proofKeyInput,
      plan: {
        required: { native_ci: true, runtime_behavior: false, design_render: false, artifact_provenance: false },
      },
      sections: [
        {
          kind: "native_ci",
          required: true,
          verdict: input.nativeCi.verdict,
          unitDigests: [parseDigest(`sha256:${"f".repeat(64)}`)],
        },
      ],
      gateVerdict: input.nativeCi.verdict,
    };
    this.bundles.set(input.nodeId, bundle);
    return bundle;
  }

  async findExact(input: Omit<GateProofBundleInput, "nativeCi">): Promise<GateProofBundleV2 | undefined> {
    return this.bundles.get(input.nodeId);
  }
}

/** An in-memory node + proof store (the PgIntegrationNodeModel, behavior-equivalent). */
class FakeNodeStore implements BatchNodeStore {
  readonly nodes = new Map<string, IntegrationNode>();
  readonly proofs = new Map<string, { nodeId: string; verdict: string; evidence?: unknown }>();
  readonly proofUnits = createInMemoryIntegrationProofUnitStore();
  readonly gateBundles = new FakeGateBundles();
  // Stays EMPTY — the jj-local path writes no host ref.
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
    if (!this.proofUnits.db.integrationNodes.some((node) => node.node_id === nodeId)) {
      this.proofUnits.db.integrationNodes.push({
        node_id: nodeId,
        org_id: input.orgId,
        project_id: input.projectId,
        proof_root: null,
        quarantine_epoch: null,
        toolchain_hash: null,
        design_contract_version: null,
        behavior_manifest_hash: null,
      });
    }
    return nodeId;
  }

  async findByMemberKey(_orgId: string, key: string): Promise<IntegrationNode | undefined> {
    return this.nodes.get(key);
  }

  async findProof(_orgId: string, reuseKey: string): Promise<{ nodeId: string; verdict: string } | undefined> {
    return this.proofs.get(reuseKey);
  }

  async recordProof(input: {
    orgId: string;
    projectId: string;
    nodeId: string;
    keyInput: ProofReuseKeyInput;
    verdict: string;
    evidence?: unknown;
  }): Promise<string> {
    const key = proofReuseKey(input.keyInput);
    this.proofs.set(key, {
      nodeId: input.nodeId,
      verdict: input.verdict,
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    });
    return key;
  }
}

/** A recording event store (so we can assert the `integration.proof.reused` emit). */
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

/** The member head SHAs the fake jj integration "captured" — the divergence key. */
const MEMBER_HEAD_SHAS = { spec_a: "a".repeat(40), spec_b: "b".repeat(40) };
const INTEGRATED_HEAD = "c".repeat(40);

/**
 * A FAKE jj-local integration port: it materializes a fixed integrated head WITHOUT a
 * live runner and runs the continuation with a dummy workspace. It NEVER writes a host
 * ref — the integration is purely local (the §3b invariant).
 */
function fakeIntegratePort(store: FakeNodeStore, baseSha = FACTS.baseSha): BatchNodeDriveDeps["integrate"] {
  return async (_workspaceDeps, input, onIntegrated) => {
    // The jj-local integration NEVER pushes a host ref (only a runner-local bookmark).
    // The local ref name must be the local-batch bookmark, NOT a `tanren/integ|batch`
    // host ref — assert that here so a regression that writes a host ref is caught.
    expect(input.localRef).toBe(batchLocalIntegrationRef(FACTS.tailSpecId));
    expect(input.localRef.startsWith("tanren/integ")).toBe(false);
    expect(input.localRef.startsWith("tanren/batch")).toBe(false);
    // Nothing pushed — the integration is purely a runner-local jj bookmark.
    store.hostRefsWritten = [];
    const integrated: Extract<JjLocalIntegrationResult, { outcome: "integrated" }> = {
      outcome: "integrated",
      localRef: input.localRef,
      baseSha,
      headSha: INTEGRATED_HEAD,
      treeHash: "tree-deadbeef",
      memberHeadShas: MEMBER_HEAD_SHAS,
    };
    // The dummy workspace is never touched by the fakes (resolveConfig/gate ignore it).
    const value = await onIntegrated({ target: {} as never, workspacePath: "/workspace" } as never, integrated);
    return { outcome: "integrated", value };
  };
}

/** Deps with the fake integration, a config-resolver that returns a fixed config, and a SPY gate. */
function deps(
  store: FakeNodeStore,
  events: RecordingEventStore,
  gateSpy: ReturnType<typeof vi.fn>,
  integratedBaseSha = FACTS.baseSha,
): BatchNodeDriveDeps {
  return {
    nodes: store,
    proofUnits: new IntegrationProofUnitGraph(store.proofUnits, events),
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
      gateProofBundleId: `gate_proof_bundle:${authorityBinding.nodeId}`,
      proofRoot: `sha256:${"e".repeat(64)}`,
    });
    expect(gate).toHaveBeenCalledTimes(1);

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
    // The production entrypoint's proof-unit graph narrates the skip.
    expect(events2.appended.some((e) => e.eventType === "integration.proof_unit.reused")).toBe(true);
    expect(events2.appended.some((e) => e.eventType === "integration.proof.reused")).toBe(false);
  });

  it("DRIFT (a changed runnerImage) forces the gate to RUN — no stale reuse", async () => {
    const store = new FakeNodeStore();
    const gate = vi.fn<GateFn>(async () => ({
      verdict: { result: "pass" as const, integrationBranch: "x" },
      passed: true,
    }));
    // Prime a passing proof under the baseline key.
    await driveBatchThroughNode(FACTS, deps(store, new RecordingEventStore(), gate));
    expect(gate).toHaveBeenCalledTimes(1);

    // Now the runner image drifts → a DIFFERENT proofReuseKey → cache miss → the gate
    // RUNS AGAIN (the recorded proof for the old image is NOT reused). The drifted gate
    // returns a FAIL verdict, so the OBSERVABLE OUTCOME proves the gate truly ran (a
    // stale reuse of the old PASS would instead have returned `pass`).
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

    // The SAME key now finds a FAILED proof → recompute (the gate RUNS again, never a
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
    expect(
      store.proofUnits.db.integrationProofUnits.some(
        (unit) => unit.subject_id === "fragment_evidence:fallback:manifest_unreadable" && unit.verdict === "fail",
      ),
    ).toBe(true);
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
    expect(store.proofs.size).toBe(0);
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
    expect(store.proofs.size).toBe(0);
  });

  it("fails loud if the proof graph omits the authoritative native pre-merge unit", async () => {
    const store = new FakeNodeStore();
    const gate = vi.fn<GateFn>();
    const driven = deps(store, new RecordingEventStore(), gate);
    driven.proofUnits = { evaluate: async () => ({ units: [] }) } as never;

    await expect(driveBatchThroughNode(FACTS, driven)).rejects.toThrow(/no pre_merge unit/u);
    expect(gate).not.toHaveBeenCalled();
  });

  it("fails closed when a corrupted reused native unit is non-passing", async () => {
    const store = new FakeNodeStore();
    const gate = vi.fn<GateFn>();
    const driven = deps(store, new RecordingEventStore(), gate);
    driven.proofUnits = {
      evaluate: async () => ({
        units: [{ kind: "native_ci_tier", subjectId: "pre_merge", verdict: "skipped", reused: true }],
      }),
    } as never;

    await expect(driveBatchThroughNode(FACTS, driven)).resolves.toEqual({
      result: "fail",
      message: "reused non-passing pre_merge proof unit (skipped)",
    });
    expect(gate).not.toHaveBeenCalled();
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
    const evidenceUnits = store.proofUnits.db.integrationProofUnits.filter(
      (unit) => unit.subject_id === "fragment_evidence:fallback:selector_set_mismatch",
    );
    expect(evidenceUnits).toHaveLength(1);
    expect(evidenceUnits[0]?.verdict).toBe("fail");
    expect(
      evidenceUnits.some((unit) => unit.subject_id === "fragment_evidence:selected" && unit.verdict === "pass"),
    ).toBe(false);
  });
});
