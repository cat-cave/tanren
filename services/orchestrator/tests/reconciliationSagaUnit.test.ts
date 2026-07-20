// in-11 — the durable reconciliation saga orchestration proofs, against faithful
// in-memory fakes of the control-plane write seam (in-4) + the queue read seam. The
// real-Postgres end-to-end lives in `reconciliationSaga.rls.integration.test.ts`;
// this proves the orchestration wiring (claim → observe → decide → settle), the
// progress-based unbounded retry, the durable resume from persisted history, the
// fail-closed state_unknown, and the derived capability-node advance — no DB.

import { beforeEach, describe, expect, it } from "vitest";
import type {
  ClaimIntegrationReconciliationInput,
  ClaimedIntegrationReconciliation,
  CompleteIntegrationReconciliationInput,
  HeartbeatIntegrationReconciliationInput,
  IntegrationStateWriter,
  MarkIntegrationReconciliationStateUnknownInput,
} from "../src/engine/contracts/integrationStateWriter.js";
import type {
  ClaimedReconciliationRow,
  ReconciliationClaimSource,
} from "../src/engine/integrations/reconciliationClaimSource.js";
import { ReconciliationSagaDriver } from "../src/engine/integrations/reconciliationSaga.js";
import type {
  ReconcileContext,
  ReconcileObservation,
  ReconcileProbe,
} from "../src/engine/integrations/reconcileProbe.js";

const ORG = "org_a";
const PROJECT = "project_a";
const REQUIREMENT = "requirement_a";
const FINGERPRINT = `sha256:${"a".repeat(64)}`;

interface MemReconciliation {
  id: string;
  status: string;
  attempt: number;
  claimOwner: string | null;
  claimExpiresAtMs: number | null;
  retryAfterMs: number | null;
  compensationState: unknown;
  observedState: unknown;
  progressSignature: string | null;
  failureClassification: string | null;
}

interface MemNode {
  requirementId: string;
  desiredStateHash: string;
  status: string;
}

/** Shared in-memory lifecycle state the fake writer + fake read-source both operate on. */
class MemStore {
  readonly reconciliations = new Map<string, MemReconciliation>();
  readonly nodes: MemNode[] = [];

  seedReconciliation(id: string, over: Partial<MemReconciliation> = {}): void {
    this.reconciliations.set(id, {
      id,
      status: "pending",
      attempt: 0,
      claimOwner: null,
      claimExpiresAtMs: null,
      retryAfterMs: null,
      compensationState: {},
      observedState: {},
      progressSignature: null,
      failureClassification: null,
      ...over,
    });
  }

  seedNode(status: string): void {
    this.nodes.push({ requirementId: REQUIREMENT, desiredStateHash: FINGERPRINT, status });
  }
}

/** A faithful in-memory `IntegrationStateWriter` mirroring the DB writer's CAS semantics. */
class MemStateWriter implements IntegrationStateWriter {
  constructor(private readonly store: MemStore) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async claim(input: ClaimIntegrationReconciliationInput): Promise<ClaimedIntegrationReconciliation | undefined> {
    const row = this.store.reconciliations.get(input.reconciliationId);
    const now = Date.now();
    const claimable =
      row !== undefined &&
      (((row.status === "pending" || row.status === "retry_scheduled") &&
        (row.retryAfterMs === null || row.retryAfterMs <= now)) ||
        (row.status === "claimed" && row.claimExpiresAtMs !== null && row.claimExpiresAtMs <= now));
    if (row === undefined || !claimable) return;
    row.status = "claimed";
    row.claimOwner = input.claimOwner;
    row.claimExpiresAtMs = now + input.leaseMs;
    row.retryAfterMs = null;
    row.attempt += 1;
    return { projectId: PROJECT, requirementId: REQUIREMENT, phase: "discover", attempt: row.attempt };
  }

  heartbeat(_input: HeartbeatIntegrationReconciliationInput): Promise<boolean> {
    return Promise.resolve(true);
  }

  complete(input: CompleteIntegrationReconciliationInput): Promise<boolean> {
    const row = this.store.reconciliations.get(input.reconciliationId);
    if (!this.owns(row, input.claimOwner)) return Promise.resolve(false);
    row!.status = input.status;
    row!.claimOwner = null;
    row!.claimExpiresAtMs = null;
    row!.retryAfterMs = input.retryAfterMs === undefined ? null : Date.now() + input.retryAfterMs;
    if (input.progressSignature !== undefined) row!.progressSignature = input.progressSignature;
    row!.failureClassification = input.failureClassification ?? null;
    if (input.compensationState !== undefined) row!.compensationState = input.compensationState;
    if (input.observedState !== undefined) row!.observedState = input.observedState;
    return Promise.resolve(true);
  }

  stateUnknown(input: MarkIntegrationReconciliationStateUnknownInput): Promise<boolean> {
    const row = this.store.reconciliations.get(input.reconciliationId);
    if (!this.owns(row, input.claimOwner)) return Promise.resolve(false);
    this.applyUnknown(row!, input);
    return Promise.resolve(true);
  }

  stateUnknownAfterClaimLost(input: MarkIntegrationReconciliationStateUnknownInput): Promise<boolean> {
    const row = this.store.reconciliations.get(input.reconciliationId);
    if (row === undefined || row.status !== "claimed") return Promise.resolve(false);
    this.applyUnknown(row, input);
    return Promise.resolve(true);
  }

  private applyUnknown(row: MemReconciliation, input: MarkIntegrationReconciliationStateUnknownInput): void {
    row.status = "state_unknown";
    row.claimOwner = null;
    row.claimExpiresAtMs = null;
    row.failureClassification = input.failureClassification;
    if (input.observedState !== undefined) row.observedState = input.observedState;
  }

  private owns(row: MemReconciliation | undefined, owner: string): row is MemReconciliation {
    return (
      row !== undefined &&
      row.status === "claimed" &&
      row.claimOwner === owner &&
      row.claimExpiresAtMs !== null &&
      row.claimExpiresAtMs > Date.now()
    );
  }
}

/** The fake read seam over the same store. */
class MemClaimSource implements ReconciliationClaimSource {
  constructor(private readonly store: MemStore) {}

  selectClaimable(_orgId: string, _projectId: string): Promise<string[]> {
    const now = Date.now();
    const ids = [...this.store.reconciliations.values()]
      .filter(
        (r) =>
          ((r.status === "pending" || r.status === "retry_scheduled") &&
            (r.retryAfterMs === null || r.retryAfterMs <= now)) ||
          (r.status === "claimed" && r.claimExpiresAtMs !== null && r.claimExpiresAtMs <= now),
      )
      .map((r) => r.id)
      .sort();
    return Promise.resolve(ids);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async readClaimed(_orgId: string, reconciliationId: string): Promise<ClaimedReconciliationRow | undefined> {
    const row = this.store.reconciliations.get(reconciliationId);
    if (row === undefined) return;
    return {
      projectId: PROJECT,
      requirementId: REQUIREMENT,
      phase: "discover",
      attempt: row.attempt,
      requestFingerprint: FINGERPRINT,
      bindingId: null,
      bindingGeneration: null,
      compensationState: row.compensationState,
    };
  }

  settleReadyCapabilityNodes(_orgId: string, _projectId: string): Promise<number> {
    let readied = 0;
    for (const node of this.store.nodes) {
      if (node.status !== "enqueued") continue;
      // The real join is (requirement, desiredStateHash==requestFingerprint); in the
      // fake all rows share the single requirement/fingerprint, so any fixed_point
      // reconciliation converges the node.
      const converged = [...this.store.reconciliations.values()].some((r) => r.status === "fixed_point");
      if (converged && node.requirementId === REQUIREMENT && node.desiredStateHash === FINGERPRINT) {
        node.status = "ready";
        readied += 1;
      }
    }
    return Promise.resolve(readied);
  }

  resolveOrgOrThrow(_projectId: string): Promise<string> {
    return Promise.resolve(ORG);
  }
}

/** A scripted probe: returns the next observation each call (last one repeats). */
class ScriptedProbe implements ReconcileProbe {
  readonly contexts: ReconcileContext[] = [];
  private index = 0;
  constructor(private readonly script: readonly (ReconcileObservation | "throw")[]) {}

  observe(context: ReconcileContext): Promise<ReconcileObservation> {
    this.contexts.push(context);
    const step = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    if (step === "throw") throw new Error("provider 504");
    return Promise.resolve(step);
  }
}

function progressing(signal: string): ReconcileObservation {
  return { kind: "progressing", signal, observedState: { signal } };
}

describe("ReconciliationSagaDriver", () => {
  let store: MemStore;
  function driver(script: readonly (ReconcileObservation | "throw")[]): ReconciliationSagaDriver {
    return new ReconciliationSagaDriver({} as never, {
      stateWriter: new MemStateWriter(store),
      claimSource: new MemClaimSource(store),
      probe: new ScriptedProbe(script),
      leaseMs: 30_000,
      retrySpacingMs: 1_000,
    });
  }

  beforeEach(() => {
    store = new MemStore();
  });

  it("advances a confirmed reconcile to fixed_point and readies the capability node", async () => {
    store.seedReconciliation("rec1");
    store.seedNode("enqueued");
    const summary = await driver([
      { kind: "converged", observedStateHash: `sha256:${"c".repeat(64)}`, observedState: {} },
    ]).drive(PROJECT);
    expect(summary.fixedPoint).toBe(1);
    expect(summary.readied).toBe(1);
    expect(store.reconciliations.get("rec1")?.status).toBe("fixed_point");
    expect(store.nodes[0]?.status).toBe("ready");
  });

  it("fail-closes an unconfirmable external state to state_unknown WITHOUT advancing the node", async () => {
    store.seedReconciliation("rec1");
    store.seedNode("enqueued");
    const summary = await driver([
      { kind: "unconfirmable", classification: "provider_response_ambiguous", observedState: {} },
    ]).driveForOrg(ORG, PROJECT);
    expect(summary.stateUnknown).toBe(1);
    expect(summary.readied).toBe(0);
    expect(store.reconciliations.get("rec1")?.status).toBe("state_unknown");
    expect(store.nodes[0]?.status).toBe("enqueued");
  });

  it("treats a thrown probe as fail-closed unconfirmable (the provider-504 path)", async () => {
    store.seedReconciliation("rec1");
    const summary = await driver(["throw"]).driveForOrg(ORG, PROJECT);
    expect(summary.stateUnknown).toBe(1);
    expect(store.reconciliations.get("rec1")?.status).toBe("state_unknown");
    expect(store.reconciliations.get("rec1")?.failureClassification).toBe("provider_observation_error");
  });

  it("retries UNBOUNDED across many walks while the observation keeps advancing — no cap", async () => {
    store.seedReconciliation("rec1");
    // Re-drive 50 times, each walk observing a NEW signal (genuine progress).
    const probe = new ScriptedProbe(Array.from({ length: 50 }, (_v, i) => progressing(`sig-${i}`)));
    const withProbe = new ReconciliationSagaDriver({} as never, {
      stateWriter: new MemStateWriter(store),
      claimSource: new MemClaimSource(store),
      probe,
      leaseMs: 30_000,
      retrySpacingMs: 0,
    });
    for (let walk = 0; walk < 50; walk += 1) {
      const summary = await withProbe.driveForOrg(ORG, PROJECT);
      expect(summary.retryScheduled).toBe(1);
      expect(summary.needsAttention).toBe(0);
    }
    expect(store.reconciliations.get("rec1")?.status).toBe("retry_scheduled");
    expect(store.reconciliations.get("rec1")?.attempt).toBe(50);
  });

  it("escalates a proven stall (identical observation) to needs_attention", async () => {
    store.seedReconciliation("rec1");
    // A single scripted observation repeats on every call — a genuine stall.
    const probe = new ScriptedProbe([progressing("stuck")]);
    const d = new ReconciliationSagaDriver({} as never, {
      stateWriter: new MemStateWriter(store),
      claimSource: new MemClaimSource(store),
      probe,
      leaseMs: 30_000,
      retrySpacingMs: 0,
    });
    expect((await d.driveForOrg(ORG, PROJECT)).retryScheduled).toBe(1);
    expect((await d.driveForOrg(ORG, PROJECT)).needsAttention).toBe(1);
    expect(store.reconciliations.get("rec1")?.status).toBe("needs_attention");
  });

  it("resumes a crashed mid-flight reconciliation from its DURABLE history", async () => {
    // A worker made progress (persisted [sig-1]) then crashed holding an expired claim.
    store.seedReconciliation("rec1", {
      status: "claimed",
      claimOwner: "dead-worker",
      claimExpiresAtMs: Date.now() - 1_000,
      attempt: 3,
      compensationState: { attemptHistory: [{ failureSignature: "progressing", workSignature: "sig-1" }] },
    });
    const summary = await driver([progressing("sig-2")]).driveForOrg(ORG, PROJECT);
    expect(summary.retryScheduled).toBe(1);
    const row = store.reconciliations.get("rec1")!;
    expect(row.status).toBe("retry_scheduled");
    // Re-claimed the expired lease; attempt advanced.
    expect(row.attempt).toBe(4);
    const history = (row.compensationState as { attemptHistory: unknown[] }).attemptHistory;
    expect(history).toEqual([
      { failureSignature: "progressing", workSignature: "sig-1" },
      { failureSignature: "progressing", workSignature: "sig-2" },
    ]);
  });

  it("routes a confirmed definite failure to needs_attention", async () => {
    store.seedReconciliation("rec1");
    const summary = await driver([
      { kind: "failed", classification: "resource_conflict", observedState: {} },
    ]).driveForOrg(ORG, PROJECT);
    expect(summary.needsAttention).toBe(1);
    expect(store.reconciliations.get("rec1")?.failureClassification).toBe("resource_conflict");
  });

  it("is a no-op sweep when nothing is claimable", async () => {
    store.seedReconciliation("rec1", { status: "fixed_point" });
    const summary = await driver([progressing("x")]).driveForOrg(ORG, PROJECT);
    expect(summary).toMatchObject({ claimable: 0, fixedPoint: 0, retryScheduled: 0, skipped: 0 });
  });

  it("falls back to stateUnknownAfterClaimLost when the live claim was lost mid-observation", async () => {
    store.seedReconciliation("rec1");
    // A writer whose primary stateUnknown always misses forces the claim-lost fallback.
    const inner = new MemStateWriter(store);
    const lossyWriter: IntegrationStateWriter = {
      claim: (i) => inner.claim(i),
      heartbeat: (i) => inner.heartbeat(i),
      complete: (i) => inner.complete(i),
      stateUnknown: () => Promise.resolve(false),
      stateUnknownAfterClaimLost: (i) => inner.stateUnknownAfterClaimLost(i),
    };
    const d = new ReconciliationSagaDriver({} as never, {
      stateWriter: lossyWriter,
      claimSource: new MemClaimSource(store),
      probe: new ScriptedProbe([{ kind: "unconfirmable", classification: "amb", observedState: {} }]),
      leaseMs: 30_000,
    });
    const summary = await d.driveForOrg(ORG, PROJECT);
    expect(summary.stateUnknown).toBe(1);
    expect(store.reconciliations.get("rec1")?.status).toBe("state_unknown");
  });
});
