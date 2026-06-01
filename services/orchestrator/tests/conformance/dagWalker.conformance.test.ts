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

import { EventEmittingDagWalker, type DagEventEmitter } from "../../src/engine/dag/walker.js";
import type {
  DagEnqueuer,
  DagReadModel,
  DagSnapshot,
  DagSpecNode,
  DagSpecPhase,
  DagTickPlan,
} from "../../src/engine/contracts/dagWalker.js";
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
    return { projectId, nodes: [...this.nodes.values()].map((n) => ({ ...n })) };
  }
}

class MemoryReadModel implements DagReadModel {
  constructor(private readonly dag: MemoryDag) {}
  async loadSnapshot(projectId: string): Promise<DagSnapshot> {
    return this.dag.snapshot(projectId);
  }
}

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

  async emitDrained(input: { projectId: string; plan: DagTickPlan }): Promise<void> {
    this.records.push({
      type: "dag.drained",
      doneCount: input.plan.doneCount,
      inFlightCount: input.plan.inFlightCount,
      blockedCount: input.plan.blockedCount,
    });
  }

  async emitBudgetPaused(input: { projectId: string; plan: DagTickPlan }): Promise<void> {
    this.records.push({
      type: "dag.budget.paused",
      readyHeldBack: input.plan.readyHeldBack,
      inFlightCount: input.plan.inFlightCount,
      concurrencyCeiling: input.plan.concurrencyCeiling,
    });
  }
}

function makeHarness(ceiling: number): DagWalkerConformanceHarness {
  const dag = new MemoryDag();
  const enqueues: RecordedEnqueue[] = [];
  const events: RecordedDagEvent[] = [];
  let currentCeiling = ceiling;
  const walker = new EventEmittingDagWalker({
    readModel: new MemoryReadModel(dag),
    enqueuer: new RecordingEnqueuer(dag, enqueues),
    events: new RecordingEventEmitter(events),
    concurrency: () => currentCeiling,
  });
  return {
    walker,
    projectId: PROJECT_ID,
    setSpec: (node) => dag.set(node),
    setCeiling: (next) => {
      currentCeiling = next;
    },
    phaseOf: (specId) => dag.phaseOf(specId),
    enqueues,
    events,
  };
}

describeDagWalkerConformance("EventEmittingDagWalker (in-memory seams)", { make: makeHarness });
