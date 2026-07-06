// Per-implementation invocation of the DagWalker conformance suite. The
// PRODUCTION `EventEmittingDagWalker` is driven against in-memory seams (a
// mutable DAG read model + a recording enqueuer + a recording event emitter) —
// so the suite exercises the REAL scheduling logic (the pure planDagTick core +
// the walk loop + event emission), not a fake walker. The in-memory seams are
// test fixtures (they live HERE, under tests/, never in src/): the enqueuer
// records each createQueuedRunFromSpec-equivalent call and CLAIMS the spec in the
// read model (pending → in_flight), exactly as the real atomic claim does, so the
// idempotency contract is observable through the public surface.
//
// The pg-backed wirings (PgDagReadModel / SpecRunDagEnqueuer / PgDagEventEmitter)
// are integration-tested against the live stack; this suite is the behavioral
// contract every DagWalker impl must satisfy without a database.

import { EventEmittingDagWalker } from "../../src/engine/dag/walker.js";
import type { DagEventEmitter } from "../../src/engine/dag/walkerPg.js";
import type {
  BudgetGate,
  DagEnqueuer,
  DagReadModel,
  DagSnapshot,
  DagSpecNode,
  DagSpecPhase,
  DagTickPlan,
  ProjectBudgetState,
} from "../../src/engine/contracts/dagWalker.js";
import type {
  DagLifecycleReadModel,
  DagLifecycleSnapshot,
  SpecLifecycle,
} from "../../src/engine/contracts/dagLifecycle.js";
import type { DagAncestorStackResolver } from "../../src/engine/dag/walkerPg.js";
import {
  describeDagWalkerConformance,
  type DagWalkerConformanceHarness,
  type RecordedDagEvent,
  type RecordedEnqueue,
} from "./dagWalkerConformance.js";

const PROJECT_ID = "project_conformance";

/** A mutable in-memory DAG the test seeds + the enqueuer claims into. */
class MemoryDag {
  private readonly nodes = new Map<string, DagSpecNode>();

  set(node: DagSpecNode): void {
    this.nodes.set(node.specId, { ...node });
  }

  phaseOf(specId: string): DagSpecPhase | undefined {
    return this.nodes.get(specId)?.phase;
  }

  /** The atomic-claim effect: a pending spec becomes in_flight on enqueue. */
  claim(specId: string): void {
    const existing = this.nodes.get(specId);
    if (existing !== undefined) {
      this.nodes.set(specId, { ...existing, phase: "in_flight" });
    }
  }

  snapshot(projectId: string): DagSnapshot {
    return { projectId, nodes: [...this.nodes.values()].map((n) => ({ ...n })), archived: false };
  }

  /**
   * Derive a lifecycle projection from the DAG phase: a `done` spec projects
   * `merged` (a satisfied dependency), everything else `pending`. The conformance
   * suite drives the walker at the CONSERVATIVE threshold (deps must be merged),
   * so this reproduces the Phase-1 "all deps done" readiness contract exactly.
   */
  lifecycle(projectId: string): DagLifecycleSnapshot {
    const bySpecId = new Map<string, SpecLifecycle>();
    for (const n of this.nodes.values()) {
      const state = n.phase === "done" ? "merged" : "pending";
      bySpecId.set(n.specId, {
        specId: n.specId,
        state,
        openFindingMaxSeverity: state === "merged" ? "none" : "unaudited",
      });
    }
    return { projectId, bySpecId };
  }
}

class MemoryReadModel implements DagReadModel {
  constructor(private readonly dag: MemoryDag) {}
  async loadSnapshot(projectId: string): Promise<DagSnapshot> {
    return this.dag.snapshot(projectId);
  }
}

/** The conservative-threshold lifecycle read model + a never-called ancestor-stack resolver —
 *  object literals (not classes) to keep this file under the per-file class cap. */
function memoryLifecycleReadModel(dag: MemoryDag): DagLifecycleReadModel {
  return { loadLifecycle: async (projectId: string): Promise<DagLifecycleSnapshot> => dag.lifecycle(projectId) };
}

const neverSpeculateStackResolver: DagAncestorStackResolver = {
  resolveStack: async (): Promise<never> => {
    throw new Error("conformance suite runs conservative; the ancestor-stack resolver must never be called");
  },
};

class RecordingEnqueuer implements DagEnqueuer {
  private seq = 0;
  constructor(
    private readonly dag: MemoryDag,
    readonly records: RecordedEnqueue[],
  ) {}

  async enqueueSpecRun(input: { projectId: string; specId: string }): Promise<{ runId: string }> {
    // The real createQueuedRunFromSpec atomically claims pending → active; mirror
    // that here so a re-walk sees the spec in-flight (idempotency contract).
    if (this.dag.phaseOf(input.specId) !== "pending") {
      throw new Error(`spec ${input.specId} is not runnable (already claimed)`);
    }
    this.seq += 1;
    const runId = `run_${this.seq}`;
    this.dag.claim(input.specId);
    this.records.push({ projectId: input.projectId, specId: input.specId, runId });
    return { runId };
  }
}

class RecordingEventEmitter implements DagEventEmitter {
  // Mirrors the PgDagEventEmitter's once-per-band-per-window dedup: a band already
  // recorded for this project+period is NOT re-emitted (a re-walk re-pings nothing).
  private readonly milestonesSeen = new Set<string>();

  constructor(readonly records: RecordedDagEvent[]) {}

  async emitSpecEnqueued(input: {
    projectId: string;
    specId: string;
    runId: string;
    satisfiedDependsOn: string[];
    inFlightBefore: number;
    concurrencyCeiling: number;
  }): Promise<void> {
    this.records.push({
      type: "dag.spec.enqueued",
      specId: input.specId,
      runId: input.runId,
      satisfiedDependsOn: input.satisfiedDependsOn,
      inFlightBefore: input.inFlightBefore,
      concurrencyCeiling: input.concurrencyCeiling,
    });
  }

  // The conservative-threshold suite never speculates, so these record nothing the
  // Phase-1 contract asserts on — but they must exist to satisfy the seam.
  async emitSpecSpeculative(): Promise<void> {}
  async emitSpeculationHeld(): Promise<void> {}
  async emitAncestorNotReady(): Promise<void> {}

  async emitDrained(input: { projectId: string; plan: DagTickPlan }): Promise<void> {
    this.records.push({
      type: "dag.drained",
      doneCount: input.plan.doneCount,
      inFlightCount: input.plan.inFlightCount,
      blockedCount: input.plan.blockedCount,
    });
  }

  async emitBudgetPaused(input: {
    projectId: string;
    ceilingUsd: number;
    spentUsd: number;
    period: "monthly" | "total";
    readyHeldBack: number;
    reason?: "unpriced_spend" | "unparseable_config" | "unresolvable_project_org";
  }): Promise<void> {
    this.records.push({
      type: "dag.budget.paused",
      ceilingUsd: input.ceilingUsd,
      spentUsd: input.spentUsd,
      period: input.period,
      readyHeldBack: input.readyHeldBack,
      ...(input.reason !== undefined && { reason: input.reason }),
    });
  }

  async emitBudgetMilestone(input: {
    projectId: string;
    band: 50 | 80;
    ceilingUsd: number;
    spentUsd: number;
    period: "monthly" | "total";
  }): Promise<boolean> {
    const key = `${input.projectId}:${input.period}:${input.band}`;
    if (this.milestonesSeen.has(key)) return false;
    this.milestonesSeen.add(key);
    this.records.push({
      type: "dag.budget.milestone",
      band: input.band,
      ceilingUsd: input.ceilingUsd,
      spentUsd: input.spentUsd,
      period: input.period,
    });
    return true;
  }

  async emitConcurrencySaturated(input: { projectId: string; plan: DagTickPlan }): Promise<void> {
    this.records.push({
      type: "dag.concurrency.saturated",
      readyHeldBack: input.plan.readyHeldBack,
      inFlightCount: input.plan.inFlightCount,
      concurrencyCeiling: input.plan.concurrencyCeiling,
    });
  }
}

/**
 * A test budget gate (fixture — lives under tests/, never in src/). Defaults to NO
 * budget (unlimited), so the existing conformance cases run byte-identically. A
 * case that wants to exercise the dollar-budget gate sets a ceiling + spend.
 */
class MemoryBudgetGate implements BudgetGate {
  private state: ProjectBudgetState = {
    ceilingUsd: undefined,
    period: "monthly",
    spentUsd: 0,
    notionalUsd: 0,
  };
  // The conformance cases set only the gate-relevant fields; fill the notional/
  // gated-figure surfacing fields the walker gate never reads.
  set(state: Omit<ProjectBudgetState, "notionalUsd">): void {
    this.state = { notionalUsd: 0, ...state };
  }
  async resolveBudget(): Promise<ProjectBudgetState> {
    return this.state;
  }
}

function makeHarness(ceiling: number): DagWalkerConformanceHarness {
  const dag = new MemoryDag();
  const enqueues: RecordedEnqueue[] = [];
  const events: RecordedDagEvent[] = [];
  const budgetGate = new MemoryBudgetGate();
  let currentCeiling = ceiling;
  const walker = new EventEmittingDagWalker({
    readModel: new MemoryReadModel(dag),
    lifecycleReadModel: memoryLifecycleReadModel(dag),
    enqueuer: new RecordingEnqueuer(dag, enqueues),
    events: new RecordingEventEmitter(events),
    ancestorStackResolver: neverSpeculateStackResolver,
    // The conformance suite pins the Phase-1 readiness contract (all deps merged/
    // done) — that is exactly the CONSERVATIVE threshold; depth cap is irrelevant.
    speculationConfig: async () => ({ threshold: "conservative", depthCap: 2 }),
    // Default: NO budget (unlimited), so the dependency/headroom/idempotency cases
    // run byte-identically; the budget cases set a ceiling + spend explicitly.
    budgetGate,
    concurrency: () => currentCeiling,
  });
  return {
    walker,
    projectId: PROJECT_ID,
    setSpec: (node) => dag.set(node),
    setCeiling: (next) => {
      currentCeiling = next;
    },
    setBudget: (state) => budgetGate.set(state),
    phaseOf: (specId) => dag.phaseOf(specId),
    enqueues,
    events,
  };
}

describeDagWalkerConformance("EventEmittingDagWalker (in-memory seams)", { make: makeHarness });
