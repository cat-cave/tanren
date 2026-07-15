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

import { describe, expect, it } from "vitest";
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
  SpecLifecycleState,
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
  /**
   * GV-5 finding #4: the lifecycle state an `in_flight` spec projects to. Defaults
   * to `pending` (the conservative contract: an in-flight ancestor has NOT crossed).
   * The depth-cap proof sets it to `pr_open` so an in-flight ancestor CROSSES the
   * aggressive threshold while staying UNMERGED — the precondition for a depth-held
   * dependent. `done` always projects `merged` regardless of this override.
   */
  private inFlightState: SpecLifecycleState = "pending";

  set(node: DagSpecNode): void {
    this.nodes.set(node.specId, { ...node });
  }

  /** GV-5 finding #4: override what an in-flight spec projects to (depth-cap proof). */
  setInFlightLifecycleState(state: SpecLifecycleState): void {
    this.inFlightState = state;
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
   * `merged` (a satisfied dependency); an `in_flight` spec projects `inFlightState`
   * (default `pending`); everything else `pending`. The conformance suite drives the
   * walker at the CONSERVATIVE threshold (deps must be merged), so the default
   * reproduces the Phase-1 "all deps done" readiness contract exactly.
   */
  lifecycle(projectId: string): DagLifecycleSnapshot {
    const bySpecId = new Map<string, SpecLifecycle>();
    for (const n of this.nodes.values()) {
      const state = n.phase === "done" ? "merged" : n.phase === "in_flight" ? this.inFlightState : "pending";
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

// GV-5 finding #4: a combined exhausted-budget / depth-cap-held former-bug negative
// through the REAL walker (EventEmittingDagWalker). The walker computes the budget-
// pause held-ready count as `plan.toEnqueue.length + plan.readyHeldBack`. Depth-cap-
// HELD work lives in `plan.held` (never in toEnqueue or readyHeldBack), so it is
// excluded — exactly like dependency-blocked work. This test mutation-pins that: if
// the count were widened to include held work, the assertion fails.
describe("DagWalker GV-5: budget-pause excludes depth-cap-held + blocked work", () => {
  // Same in-memory seams as the conformance harness, but: aggressive threshold +
  // depthCap 1, and an in-flight ancestor projects to `pr_open` (CROSSED at the
  // aggressive threshold but UNMERGED) so a dependent on two of them is HELD over
  // the depth cap by the REAL planner. The ancestor-stack resolver is never reached
  // (held + non-speculative-root specs do not resolve a stack).
  function makeDepthCapBudgetHarness(): DagWalkerConformanceHarness {
    const dag = new MemoryDag();
    dag.setInFlightLifecycleState("pr_open");
    const enqueues: RecordedEnqueue[] = [];
    const events: RecordedDagEvent[] = [];
    const budgetGate = new MemoryBudgetGate();
    let currentCeiling = 10;
    const walker = new EventEmittingDagWalker({
      readModel: new MemoryReadModel(dag),
      lifecycleReadModel: memoryLifecycleReadModel(dag),
      enqueuer: new RecordingEnqueuer(dag, enqueues),
      events: new RecordingEventEmitter(events),
      ancestorStackResolver: neverSpeculateStackResolver,
      speculationConfig: async () => ({ threshold: "aggressive", depthCap: 1 }),
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

  it("counts ONLY eligible ready specs; depth-held AND dependency-blocked work are excluded", async () => {
    const h = makeDepthCapBudgetHarness();
    // Exhausted budget — the genuine dollar gate fires.
    h.setBudget({ ceilingUsd: 50, period: "total", spentUsd: 50 });

    // Two eligible READY roots (no deps) — these are the specs the budget gate held.
    h.setSpec({ specId: "spec_root_a", phase: "pending", dependsOn: [], priority: "tbd", orderKey: 0 });
    h.setSpec({ specId: "spec_root_b", phase: "pending", dependsOn: [], priority: "tbd", orderKey: 1 });

    // A dependency-BLOCKED spec (depends on a missing spec) — excluded from the count.
    h.setSpec({ specId: "spec_blocked", phase: "pending", dependsOn: ["spec_missing"], priority: "tbd", orderKey: 2 });

    // Two in-flight ancestors that crossed the aggressive threshold (pr_open) but are
    // NOT merged; spec_held depends on both → unmerged-ancestor depth 2 > cap 1 → HELD.
    h.setSpec({ specId: "spec_anc1", phase: "in_flight", dependsOn: [], priority: "tbd", orderKey: 3 });
    h.setSpec({ specId: "spec_anc2", phase: "in_flight", dependsOn: [], priority: "tbd", orderKey: 4 });
    h.setSpec({
      specId: "spec_held",
      phase: "pending",
      dependsOn: ["spec_anc1", "spec_anc2"],
      priority: "tbd",
      orderKey: 5,
    });

    const result = await h.walker.walk(h.projectId);

    expect(result.status).toBe("budget_paused");
    expect(result.enqueuedSpecIds).toEqual([]);
    expect(h.enqueues).toEqual([]);
    const paused = h.events.find((e) => e.type === "dag.budget.paused");
    // ONLY the two ready roots are counted. The dependency-blocked spec AND the
    // depth-cap-held spec are excluded — the former-bug literal `0` is gone, and a
    // regression that widens the count to include `plan.held` fails here (3 ≠ 2).
    expect(paused?.readyHeldBack).toBe(2);
  });
});
