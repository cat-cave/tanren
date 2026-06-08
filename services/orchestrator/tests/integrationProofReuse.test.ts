// CORRECTNESS PROOF for §3a proof reuse (tanren-owns-the-engine.md §3), Wave-3 /
// Slice-3. The safety invariant is the point: a proof is reused ONLY when ALL SIX
// `proofReuseKey` components match a recorded PASSING proof EXACTLY; ANY drift, a
// non-passing recorded verdict, or an unresolvable key component forces a RECOMPUTE —
// never a stale reuse that merges UNPROVEN code. These tests drive the pure decision
// (`decideProofReuse`) + the post-gate record (`recordProofVerdict`) over an in-memory
// proof store + spies, asserting the gate is or is NOT invoked.

import { describe, expect, it, vi } from "vitest";
import {
  type IntegrationNode,
  type ProofReuseKeyInput,
  proofReuseKey,
} from "../src/engine/contracts/integrationNodes.js";
import {
  type LiveProofKeyComponents,
  type ProofStorePort,
  decideProofReuse,
  recordProofVerdict,
  resolvedComponent,
  unresolvableComponent,
} from "../src/engine/dag/integrationProofReuse.js";

/** An in-memory proof store (the pg model's findProof/recordProof, behavior-equivalent). */
class InMemoryProofStore implements ProofStorePort {
  private readonly proofs = new Map<string, { nodeId: string; verdict: string }>();

  async findProof(_orgId: string, reuseKey: string): Promise<{ nodeId: string; verdict: string } | undefined> {
    return this.proofs.get(reuseKey);
  }

  async recordProof(input: {
    orgId: string;
    projectId: string;
    nodeId: string;
    keyInput: ProofReuseKeyInput;
    verdict: string;
  }): Promise<string> {
    const key = proofReuseKey(input.keyInput);
    this.proofs.set(key, { nodeId: input.nodeId, verdict: input.verdict });
    return key;
  }

  /** Seed a recorded proof directly (the prior run that produced it). */
  seed(keyInput: ProofReuseKeyInput, verdict: string, nodeId = "inode_prior"): void {
    this.proofs.set(proofReuseKey(keyInput), { nodeId, verdict });
  }
}

const NODE: IntegrationNode = {
  nodeId: "inode_current",
  baseBranch: "main",
  baseSha: "base1",
  ref: "tanren-local-batch-x",
  purpose: "merge_batch",
  members: [],
  memberKey: "MK",
  gateConfigHash: "",
  policyVersion: "",
  affectedFingerprint: "",
  status: "ready",
};

/** The six live components, all resolved to the same tokens a recorded proof would carry. */
function liveComponents(overrides: Partial<Record<keyof LiveProofKeyComponents, string>> = {}): LiveProofKeyComponents {
  return {
    gateConfigHash: resolvedComponent(overrides.gateConfigHash ?? "GC"),
    policyVersion: resolvedComponent(overrides.policyVersion ?? "PV"),
    runnerImage: resolvedComponent(overrides.runnerImage ?? "RI"),
    appEnvHash: resolvedComponent(overrides.appEnvHash ?? "AE"),
    quarantineVersion: resolvedComponent(overrides.quarantineVersion ?? "QV"),
  };
}

/** The recorded proof's key input — the six tokens the proof was produced under. */
function recordedKeyInput(): ProofReuseKeyInput {
  return {
    memberKey: NODE.memberKey,
    gateConfigHash: "GC",
    policyVersion: "PV",
    runnerImage: "RI",
    appEnvHash: "AE",
    quarantineVersion: "QV",
  };
}

describe("decideProofReuse — the §3a safety invariant", () => {
  it("REUSES a passing proof on an exact six-component match (skips the gate, emits the event)", async () => {
    const store = new InMemoryProofStore();
    store.seed(recordedKeyInput(), "passed", "inode_prior");
    const emit = vi.fn<() => Promise<void>>(async () => {});

    const decision = await decideProofReuse({
      orgId: "org_1",
      node: NODE,
      components: liveComponents(),
      store,
      emit,
    });

    expect(decision.kind).toBe("reuse");
    // The reuse narrates the skip (the `integration.proof.reused` payload) — exactly once.
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: NODE.nodeId, recordedOnNodeId: "inode_prior", memberKey: NODE.memberKey }),
    );
  });

  // THE drift safety test: change EACH of the six key components in turn → a cache MISS →
  // RECOMPUTE (the gate re-runs). No drift may ever reuse the stale proof.
  const driftCases: ReadonlyArray<{ name: string; mutate: () => Parameters<typeof decideProofReuse>[0] }> = [
    {
      name: "gateConfigHash",
      mutate: () => ({ orgId: "o", node: NODE, components: liveComponents({ gateConfigHash: "GC2" }) }) as never,
    },
    {
      name: "runnerImage",
      mutate: () => ({ orgId: "o", node: NODE, components: liveComponents({ runnerImage: "RI2" }) }) as never,
    },
    {
      name: "appEnvHash",
      mutate: () => ({ orgId: "o", node: NODE, components: liveComponents({ appEnvHash: "AE2" }) }) as never,
    },
    {
      name: "quarantineVersion",
      mutate: () => ({ orgId: "o", node: NODE, components: liveComponents({ quarantineVersion: "QV2" }) }) as never,
    },
    {
      name: "policyVersion",
      mutate: () => ({ orgId: "o", node: NODE, components: liveComponents({ policyVersion: "PV2" }) }) as never,
    },
    {
      name: "memberKey (a member sha changed)",
      mutate: () => ({ orgId: "o", node: { ...NODE, memberKey: "MK2" }, components: liveComponents() }) as never,
    },
  ];

  for (const { name, mutate } of driftCases) {
    it(`RECOMPUTES (no stale reuse) when ${name} drifts`, async () => {
      const store = new InMemoryProofStore();
      store.seed(recordedKeyInput(), "passed", "inode_prior");
      const emit = vi.fn<() => Promise<void>>(async () => {});
      const args = mutate();

      const decision = await decideProofReuse({ ...args, store, emit });

      expect(decision.kind).toBe("recompute");
      // A recompute NEVER emits the reuse event (the gate must run).
      expect(emit).not.toHaveBeenCalled();
    });
  }

  it("RECOMPUTES on an unresolvable key component (fail-closed: never reuse on an unknown key)", async () => {
    const store = new InMemoryProofStore();
    store.seed(recordedKeyInput(), "passed");
    const emit = vi.fn<() => Promise<void>>(async () => {});
    const components = liveComponents();
    components.runnerImage = unresolvableComponent("runner image blank");

    const decision = await decideProofReuse({ orgId: "o", node: NODE, components, store, emit });

    expect(decision.kind).toBe("recompute");
    // An unknown key carries NO keyInput — the post-gate recorder records nothing under a
    // half-known key (never persists a proof on an unsound key).
    expect(decision.kind === "recompute" ? decision.keyInput : "n/a").toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });

  it("does NOT reuse a recorded NON-PASSING proof (only a passing verdict short-circuits)", async () => {
    const store = new InMemoryProofStore();
    store.seed(recordedKeyInput(), "failed");
    const emit = vi.fn<() => Promise<void>>(async () => {});

    const decision = await decideProofReuse({ orgId: "o", node: NODE, components: liveComponents(), store, emit });

    expect(decision.kind).toBe("recompute");
    expect(emit).not.toHaveBeenCalled();
  });

  it("RECOMPUTES on a cache MISS (no recorded proof for this key)", async () => {
    const store = new InMemoryProofStore();
    const emit = vi.fn<() => Promise<void>>(async () => {});

    const decision = await decideProofReuse({ orgId: "o", node: NODE, components: liveComponents(), store, emit });

    expect(decision.kind).toBe("recompute");
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("recordProofVerdict — what a recompute persists", () => {
  it("records a PASSING proof after a recompute that passed (so a later reuse can short-circuit)", async () => {
    const store = new InMemoryProofStore();
    const emit = vi.fn<() => Promise<void>>(async () => {});
    // First pass: cache miss → recompute, gate passes, record.
    const decision = await decideProofReuse({ orgId: "o", node: NODE, components: liveComponents(), store, emit });
    expect(decision.kind).toBe("recompute");
    await recordProofVerdict({ decision, store, orgId: "o", projectId: "p", node: NODE, passed: true });

    // Second pass: the SAME components now HIT the just-recorded passing proof → reuse.
    const second = await decideProofReuse({ orgId: "o", node: NODE, components: liveComponents(), store, emit });
    expect(second.kind).toBe("reuse");
  });

  it("records a FAILED proof after a recompute that failed (a later identical key recomputes, never reuses a fail)", async () => {
    const store = new InMemoryProofStore();
    const emit = vi.fn<() => Promise<void>>(async () => {});
    const decision = await decideProofReuse({ orgId: "o", node: NODE, components: liveComponents(), store, emit });
    await recordProofVerdict({ decision, store, orgId: "o", projectId: "p", node: NODE, passed: false });

    const second = await decideProofReuse({ orgId: "o", node: NODE, components: liveComponents(), store, emit });
    // A recorded FAILED verdict is never reused — the gate re-runs.
    expect(second.kind).toBe("recompute");
  });

  it("records NOTHING when the recompute carried no sound key (an unresolvable component)", async () => {
    const store = new InMemoryProofStore();
    const components = liveComponents();
    components.policyVersion = unresolvableComponent("policy version absent");
    const decision = await decideProofReuse({
      orgId: "o",
      node: NODE,
      components,
      store,
      emit: vi.fn<() => Promise<void>>(async () => {}),
    });
    await recordProofVerdict({ decision, store, orgId: "o", projectId: "p", node: NODE, passed: true });
    // OBSERVABLE OUTCOME: a SECOND decision over the SAME (still-unresolvable) inputs
    // still RECOMPUTES — nothing was persisted to reuse (a half-known key never seeds a
    // proof). Even resolving the component afterward finds no proof (the prior recompute
    // recorded none).
    const reResolved = liveComponents();
    const second = await decideProofReuse({
      orgId: "o",
      node: NODE,
      components: reResolved,
      store,
      emit: vi.fn<() => Promise<void>>(async () => {}),
    });
    expect(second.kind).toBe("recompute");
  });
});
