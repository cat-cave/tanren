// apex-v35 PROOF (the `ancestor_not_ready` runner-alloc hot-loop fix): a speculative dependent
// that re-drives must be SPACED, so it does not re-allocate a runner on every percolation
// notification. The live run re-drove ONE dependent ("Upgrade dependencies to latest", which
// depends on ~all other specs) ~516× over a single build — each speculative enqueue ALLOCATING
// a runner, minting a scoped token, cloning to jj-assemble the base, then (PR #576) re-driving
// to `open` on a benign `AncestorNotReadyError` and re-firing on the NEXT notification with NO
// spacing (`dag.spec.ancestor_not_ready`: 512; runner.allocated / scoped_token_minted: ~516).
//
// The fix mirrors #584's base-shift HELD backoff (`HeldReDriveBackoff`):
//   (1) BACKOFF (the bound): the SAME speculative dependent is not re-enqueued until its
//       per-spec backoff window elapses (3s→10s→30s→60s) — so a notification STORM yields a
//       HANDFUL of spaced speculative enqueues, NOT hundreds. This is the operative fix: it
//       bounds the loop even when the bootstrap-time `AncestorNotReadyError` race is invisible
//       to the walker's cheap lifecycle view.
//   (2) CHEAP PRE-CHECK (defense): when the lifecycle projection itself shows an unmerged
//       ancestor below `pr_open` (no published head), the walker DEFERS without allocating a
//       runner / resolving the stack — emitting the benign `dag.spec.ancestor_not_ready`.
// A dependent still re-drives once spaced (the backoff never caps the wait), so it is never
// starved. Driven through the in-memory walker seams (TEST FIXTURES) + a clock-injected
// HeldReDriveBackoff, asserted deterministically with no DB.

import { describe, expect, it } from "vitest";
import { EventEmittingDagWalker } from "../src/engine/dag/walker.js";
import { HeldReDriveBackoff } from "../src/engine/dag/heldReDriveBackoff.js";
import { firstAncestorWithoutPublishedHead } from "../src/engine/dag/speculation.js";
import type { DagAncestorStackResolver, DagEventEmitter } from "../src/engine/dag/walkerPg.js";
import type {
  BudgetGate,
  DagEnqueuer,
  DagReadModel,
  DagSnapshot,
  DagSpecNode,
  ProjectBudgetState,
} from "../src/engine/contracts/dagWalker.js";
import type {
  DagLifecycleReadModel,
  DagLifecycleSnapshot,
  SpecLifecycle,
  SpecLifecycleState,
} from "../src/engine/contracts/dagLifecycle.js";
import type { ResolvedAncestorBranch } from "../src/engine/dag/ancestorStack.js";
import type { AncestorStack } from "../src/engine/dag/ancestorStack.js";

const PROJECT = "project_ancestor_wait";

function node(specId: string, phase: DagSpecNode["phase"], dependsOn: string[], orderKey: number): DagSpecNode {
  return { specId, phase, dependsOn, priority: "tbd", orderKey };
}

/** A mutable lifecycle snapshot the test can flip to simulate an ancestor advancing. */
class MutableLifecycle implements DagLifecycleReadModel {
  constructor(public entries: Record<string, SpecLifecycleState>) {}
  async loadLifecycle(projectId: string): Promise<DagLifecycleSnapshot> {
    const bySpecId = new Map<string, SpecLifecycle>();
    for (const [specId, state] of Object.entries(this.entries)) {
      bySpecId.set(specId, { specId, state, openFindingMaxSeverity: "none" });
    }
    return { projectId, bySpecId };
  }
}

/** A mutable DAG snapshot: the dependent re-drives by returning to `pending` (the loop). */
class MutableReadModel implements DagReadModel {
  constructor(public nodes: DagSpecNode[]) {}
  async loadSnapshot(projectId: string): Promise<DagSnapshot> {
    return { projectId, nodes: this.nodes.map((n) => ({ ...n })), archived: false };
  }
}

/** Records every speculative enqueue — each models a real runner allocation + token + clone. */
class RecordingEnqueuer implements DagEnqueuer {
  readonly records: Array<{ specId: string; ancestorStack?: AncestorStack }> = [];
  private seq = 0;
  async enqueueSpecRun(input: {
    projectId: string;
    specId: string;
    ancestorStack?: AncestorStack;
  }): Promise<{ runId: string }> {
    this.seq += 1;
    this.records.push({
      specId: input.specId,
      ...(input.ancestorStack !== undefined && { ancestorStack: input.ancestorStack }),
    });
    return { runId: `run_${this.seq}` };
  }
}

/** Counts every stack resolution — a NOT-READY cheap-defer must never resolve the stack. */
class CountingStackResolver implements DagAncestorStackResolver {
  calls = 0;
  async resolveStack(input: {
    projectId: string;
    unmergedAncestorSpecIds: ReadonlyArray<string>;
  }): Promise<ReadonlyArray<ResolvedAncestorBranch>> {
    this.calls += 1;
    return input.unmergedAncestorSpecIds.map((specId) => ({
      specId,
      runId: `run_${specId}`,
      branch: `tanren/${specId}`,
    }));
  }
}

interface RecordedNotReady {
  specId: string;
  ancestorSpecId: string;
  ancestorPhase: "pending" | "in_flight";
}

class RecordingEmitter implements DagEventEmitter {
  readonly speculative: string[] = [];
  readonly ancestorNotReady: RecordedNotReady[] = [];
  async emitSpecEnqueued(): Promise<void> {}
  async emitSpecSpeculative(input: { specId: string }): Promise<void> {
    this.speculative.push(input.specId);
  }
  async emitSpeculationHeld(): Promise<void> {}
  async emitAncestorNotReady(input: {
    projectId: string;
    specId: string;
    ancestorSpecId: string;
    ancestorPhase: "pending" | "in_flight";
  }): Promise<void> {
    this.ancestorNotReady.push({
      specId: input.specId,
      ancestorSpecId: input.ancestorSpecId,
      ancestorPhase: input.ancestorPhase,
    });
  }
  async emitDrained(): Promise<void> {}
  async emitBudgetPaused(): Promise<void> {}
  async emitBudgetMilestone(): Promise<boolean> {
    return true;
  }
  async emitConcurrencySaturated(): Promise<void> {}
}

const unlimitedBudgetGate: BudgetGate = {
  async resolveBudget(): Promise<ProjectBudgetState> {
    return { ceilingUsd: undefined, period: "monthly", spentUsd: 0, notionalUsd: 0, gatedFigure: "real_spend" };
  },
};

function makeWalker(opts: { readModel: MutableReadModel; lifecycle: MutableLifecycle; clock: () => number }): {
  walker: EventEmittingDagWalker;
  enqueuer: RecordingEnqueuer;
  emitter: RecordingEmitter;
  stackResolver: CountingStackResolver;
} {
  const enqueuer = new RecordingEnqueuer();
  const emitter = new RecordingEmitter();
  const stackResolver = new CountingStackResolver();
  const walker = new EventEmittingDagWalker({
    readModel: opts.readModel,
    lifecycleReadModel: opts.lifecycle,
    enqueuer,
    events: emitter,
    ancestorStackResolver: stackResolver,
    // aggressive: spec_a at `pr_open` crosses the threshold, so spec_b is READY+SPECULATIVE —
    // exactly the live "Upgrade dependencies" case (a dependent on an in-flight ancestor).
    speculationConfig: async () => ({ threshold: "aggressive", depthCap: 5 }),
    budgetGate: unlimitedBudgetGate,
    concurrency: () => 5,
    ancestorWaitBackoff: new HeldReDriveBackoff(opts.clock),
  });
  return { walker, enqueuer, emitter, stackResolver };
}

describe("DagWalker ancestor-not-ready re-drive backoff (apex-v35 hot-loop fix)", () => {
  it("a NOTIFICATION STORM over a re-driving speculative dependent yields a HANDFUL of spaced enqueues, NOT ~516 (the no-backoff hot-loop FAILS here)", async () => {
    let clock = 0;
    // spec_a at pr_open (a published head); spec_b a pending dependent that KEEPS re-driving
    // (it stays `pending` every walk — modelling the benign `ancestor_not_ready` re-drive that
    // returned it to `open` on every percolation notification in the live run).
    const readModel = new MutableReadModel([
      node("spec_a", "in_flight", [], 0),
      node("spec_b", "pending", ["spec_a"], 1),
    ]);
    const lifecycle = new MutableLifecycle({ spec_a: "pr_open", spec_b: "pending" });
    const { walker, enqueuer } = makeWalker({ readModel, lifecycle, clock: () => clock });

    // The live storm: a percolation notification every 100ms for 60s. WITHOUT the backoff each
    // walk re-enqueued spec_b — ~600 runner allocations. WITH it, re-enqueues are SPACED on the
    // 3s→10s→30s→60s curve, so only a handful fire over the window.
    for (let t = 0; t < 60_000; t += 100) {
      clock = t;
      await walker.walk(PROJECT);
    }

    // BOUNDED: enqueues at t=0, ~3s, ~13s, ~43s (next at ~103s is past the 60s window) → 4,
    // NOT ~600. This assertion makes the no-backoff hot-loop FAIL loudly.
    expect(enqueuer.records.length).toBeGreaterThanOrEqual(1);
    expect(enqueuer.records.length).toBeLessThan(10);
    expect(enqueuer.records.every((r) => r.specId === "spec_b")).toBe(true);
  });

  it("two walks within the backoff window do NOT both re-enqueue the dependent (the re-drive is spaced)", async () => {
    let clock = 1_000;
    const readModel = new MutableReadModel([
      node("spec_a", "in_flight", [], 0),
      node("spec_b", "pending", ["spec_a"], 1),
    ]);
    const lifecycle = new MutableLifecycle({ spec_a: "pr_open", spec_b: "pending" });
    const { walker, enqueuer, emitter } = makeWalker({ readModel, lifecycle, clock: () => clock });

    // Walk 1: enqueues spec_b speculatively (arms the backoff window).
    await walker.walk(PROJECT);
    expect(enqueuer.records.length).toBe(1);
    expect(emitter.speculative).toEqual(["spec_b"]);

    // Walk 2 a few ms later (the storm) — spec_b still pending (re-drove), but SKIPPED inside
    // the first 3s window: no second enqueue, no runner allocation.
    clock += 5;
    await walker.walk(PROJECT);
    expect(enqueuer.records.length).toBe(1);

    // Walk 3 past the window: re-eligible, so it re-enqueues once (it never gives up).
    clock += 4_000;
    await walker.walk(PROJECT);
    expect(enqueuer.records.length).toBe(2);
  });

  it("CHEAP PRE-CHECK helper: an unmerged ancestor below `pr_open` has no published head; one at/above `pr_open` does", () => {
    // The published-head check is a pure function of the lifecycle projection.
    const below = new Map<string, SpecLifecycle>([
      ["spec_a", { specId: "spec_a", state: "building", openFindingMaxSeverity: "none" }],
    ]);
    expect(firstAncestorWithoutPublishedHead(["spec_a"], { projectId: PROJECT, bySpecId: below })).toEqual({
      ancestorSpecId: "spec_a",
      phase: "in_flight",
    });
    // No run yet ⇒ `pending` phase; an absent projection entry is also not-ready.
    const none = new Map<string, SpecLifecycle>();
    expect(firstAncestorWithoutPublishedHead(["spec_a"], { projectId: PROJECT, bySpecId: none })).toEqual({
      ancestorSpecId: "spec_a",
      phase: "pending",
    });
    // At/above pr_open (a published head) ⇒ ready (undefined).
    const at = new Map<string, SpecLifecycle>([
      ["spec_a", { specId: "spec_a", state: "pr_open", openFindingMaxSeverity: "none" }],
    ]);
    expect(firstAncestorWithoutPublishedHead(["spec_a"], { projectId: PROJECT, bySpecId: at })).toBeUndefined();
  });

  it("CHEAP PRE-CHECK in the walker: a TRANSITIVE ancestor below `pr_open` DEFERS the dependent without allocating a runner or resolving its stack", () => {
    const clock = 1_000;
    // spec_c → spec_b → spec_a. spec_b (spec_c's DIRECT dep) is `pr_open` so spec_c crosses the
    // aggressive threshold and reaches enqueueOne; but the TRANSITIVE ancestor spec_a is
    // `building` (no published head). The cheap pre-check defers spec_c BEFORE provisioning.
    const readModel = new MutableReadModel([
      node("spec_a", "in_flight", [], 0),
      node("spec_b", "in_flight", ["spec_a"], 1),
      node("spec_c", "pending", ["spec_b"], 2),
    ]);
    const lifecycle = new MutableLifecycle({ spec_a: "building", spec_b: "pr_open", spec_c: "pending" });
    const { walker, enqueuer, emitter, stackResolver } = makeWalker({ readModel, lifecycle, clock: () => clock });

    return walker.walk(PROJECT).then(() => {
      // DEFERRED cheaply — no enqueue, no runner, no token, and the stack was NEVER resolved.
      expect(enqueuer.records).toEqual([]);
      expect(stackResolver.calls).toBe(0);
      // The benign `dag.spec.ancestor_not_ready` fired ONCE, naming the not-yet-published
      // transitive ancestor (spec_a, `building` → `in_flight`).
      expect(emitter.ancestorNotReady).toEqual([
        { specId: "spec_c", ancestorSpecId: "spec_a", ancestorPhase: "in_flight" },
      ]);
    });
  });

  it("a recovered dependent that advances past `pending` is no longer a re-enqueue candidate (never starved, never re-driven forever)", async () => {
    let clock = 0;
    const readModel = new MutableReadModel([
      node("spec_a", "in_flight", [], 0),
      node("spec_b", "pending", ["spec_a"], 1),
    ]);
    const lifecycle = new MutableLifecycle({ spec_a: "pr_open", spec_b: "pending" });
    const { walker, enqueuer } = makeWalker({ readModel, lifecycle, clock: () => clock });

    // Walk 1: spec_b enqueues speculatively (arms the backoff).
    await walker.walk(PROJECT);
    expect(enqueuer.records.length).toBe(1);

    // spec_b's run took (it advanced to in_flight — occupying a slot, no longer pending). Past
    // the backoff window, a re-walk does NOT re-enqueue it (it is not a pending candidate).
    readModel.nodes = [node("spec_a", "in_flight", [], 0), node("spec_b", "in_flight", ["spec_a"], 1)];
    clock += 60_000;
    await walker.walk(PROJECT);
    expect(enqueuer.records.length).toBe(1);
  });
});
