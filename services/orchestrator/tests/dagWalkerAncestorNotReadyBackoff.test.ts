// apex-v35 PROOF (the `ancestor_not_ready` runner-alloc hot-loop fix): a speculative dependent
// that re-drives must be SPACED, so it does not re-allocate a runner on every percolation
// notification. The live run re-drove ONE dependent ("Upgrade dependencies to latest", which
// depends on ~all other specs) ~516× over a single build — each speculative enqueue ALLOCATING
// a runner, minting a scoped token, cloning to jj-assemble the base, then (PR #576) re-driving
// to `open` on a benign `AncestorNotReadyError` and re-firing on the NEXT notification with NO
// spacing (`dag.spec.ancestor_not_ready`: 512; runner.allocated / scoped_token_minted: ~516).
//
// apex-v45 EXTENSION (the run-CYCLE hot-loop fix): the v35 time-based backoff alone is
// insufficient when each run cycle takes 30-65 seconds (runner alloc + jj clone +
// AncestorNotReadyError). The backoff windows (3s→10s→30s→60s) may EXPIRE during the run,
// so by the time the run terminates and the next walk fires, the window has elapsed and the
// dependent is re-enqueued again — 368 times in the apex-v45 live run, same as v35's 516×.
//
// The additional gate: track the ANCESTOR LIFECYCLE STATE KEY at each attempt. A speculative
// dependent is only re-driven when its unmerged ancestors have MADE PROGRESS (their lifecycle
// states changed). If the ancestor is at the same lifecycle state as the last attempt, skip —
// re-arm the window from NOW and wait for a genuine ancestor advance. This is purely
// event-driven on ancestor progress, not time-capped.
//
// Together: (1) time-based window guards rapid notification storms; (2) ancestor-state-key
// guards run-cycle hot-loops where each cycle takes longer than the time window. A dependent
// re-drives ONLY when the ancestor actually advances (CI passes, PR merges, etc.).
//
// Driven through the in-memory walker seams (TEST FIXTURES) + a clock-injected HeldReDriveBackoff,
// asserted deterministically with no DB.

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
    return { ceilingUsd: undefined, period: "monthly", spentUsd: 0, notionalUsd: 0 };
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

describe("DagWalker ancestor-not-ready re-drive backoff (apex-v35 + apex-v45 hot-loop fix)", () => {
  it("NOTIFICATION STORM with UNCHANGED ancestor: exactly 1 enqueue, then all subsequent walks are gated on ancestor progress", async () => {
    let clock = 0;
    // spec_a at pr_open (a published head); spec_b a pending dependent that KEEPS re-driving
    // (it stays `pending` every walk — modelling the benign `ancestor_not_ready` re-drive that
    // returned it to `open` on every percolation notification in the live run).
    // ANCESTOR STATE IS UNCHANGED throughout the storm (spec_a stays at pr_open).
    const readModel = new MutableReadModel([
      node("spec_a", "in_flight", [], 0),
      node("spec_b", "pending", ["spec_a"], 1),
    ]);
    const lifecycle = new MutableLifecycle({ spec_a: "pr_open", spec_b: "pending" });
    const { walker, enqueuer } = makeWalker({ readModel, lifecycle, clock: () => clock });

    // The live storm: a percolation notification every 100ms for 60s.
    // Walk 1 (t=0): spec_b enqueues speculatively; ancestor key recorded (spec_a:pr_open).
    // All subsequent walks: ancestor key UNCHANGED → skip (progress-gated), re-arm window.
    // WITHOUT the ancestor-progress check: ~600 runner allocations over 60s.
    // WITH it: exactly 1 enqueue — zero progress = zero re-drives.
    for (let t = 0; t < 60_000; t += 100) {
      clock = t;
      await walker.walk(PROJECT);
    }

    // BOUNDED to exactly 1: the ancestor never progressed so no re-drive was warranted.
    expect(enqueuer.records.length).toBe(1);
    expect(enqueuer.records[0]?.specId).toBe("spec_b");
  });

  it("RUN-CYCLE HOT-LOOP: a dependent blocked on a slow ancestor (each run takes 60s) is NOT re-enqueued until the ancestor ADVANCES", async () => {
    // This is the apex-v45 repro: run cycles take 30-65 seconds (runner alloc + jj clone +
    // AncestorNotReadyError). The time-based backoff (3s window) expires DURING the run, so
    // each run termination triggers a fresh re-drive. 368 cycles in the live run.
    // The fix: gate on ancestor progress, not just time.
    let clock = 0;
    const readModel = new MutableReadModel([
      node("spec_a", "in_flight", [], 0),
      node("spec_b", "pending", ["spec_a"], 1),
    ]);
    const lifecycle = new MutableLifecycle({ spec_a: "pr_open", spec_b: "pending" });
    const { walker, enqueuer } = makeWalker({ readModel, lifecycle, clock: () => clock });

    // Walk 1 (t=0): spec_b enqueues (ancestor key = spec_a:pr_open). Run starts.
    await walker.walk(PROJECT);
    expect(enqueuer.records.length).toBe(1);

    // Each simulated run takes 60s (runner alloc + clone + AncestorNotReadyError → re-drive).
    // Run 1 terminates at t=60s. Walk fires. Ancestor UNCHANGED (still pr_open).
    // → ancestor-progress gate BLOCKS the re-drive (no runner allocation).
    // Simulate each run-terminal walk: ancestor still unchanged.
    for (let t = 60_000; t < 60_000 * 10; t += 60_000) {
      clock = t;
      await walker.walk(PROJECT);
    }

    // After 9 more walks (9 simulated run cycles), still exactly 1 enqueue.
    // The ancestor never progressed, so no re-drive was warranted.
    expect(enqueuer.records.length).toBe(1);

    // NOW the ancestor advances: spec_a goes from pr_open → ci_green (CI passed).
    // The ancestor state key changes → spec_b is re-eligible for a fresh attempt.
    lifecycle.entries["spec_a"] = "ci_green";
    clock += 60_000;
    await walker.walk(PROJECT);

    // Exactly 1 fresh enqueue after ancestor advanced.
    expect(enqueuer.records.length).toBe(2);
    expect(enqueuer.records.every((r) => r.specId === "spec_b")).toBe(true);
  });

  it("NOTIFICATION STORM defense still works: rapid walks within the backoff window do NOT both re-enqueue", async () => {
    let clock = 1_000;
    const readModel = new MutableReadModel([
      node("spec_a", "in_flight", [], 0),
      node("spec_b", "pending", ["spec_a"], 1),
    ]);
    const lifecycle = new MutableLifecycle({ spec_a: "pr_open", spec_b: "pending" });
    const { walker, enqueuer, emitter } = makeWalker({ readModel, lifecycle, clock: () => clock });

    // Walk 1: enqueues spec_b speculatively (arms the backoff window + records ancestor key).
    await walker.walk(PROJECT);
    expect(enqueuer.records.length).toBe(1);
    expect(emitter.speculative).toEqual(["spec_b"]);

    // Walk 2 a few ms later (the storm) — spec_b still pending (re-drove), SKIPPED inside
    // the first 3s window (time gate fires before ancestor-progress check): no second enqueue.
    clock += 5;
    await walker.walk(PROJECT);
    expect(enqueuer.records.length).toBe(1);
  });

  it("a re-drive DOES proceed when the ancestor's lifecycle advances past its last-recorded state", async () => {
    let clock = 1_000;
    const readModel = new MutableReadModel([
      node("spec_a", "in_flight", [], 0),
      node("spec_b", "pending", ["spec_a"], 1),
    ]);
    const lifecycle = new MutableLifecycle({ spec_a: "pr_open", spec_b: "pending" });
    const { walker, enqueuer } = makeWalker({ readModel, lifecycle, clock: () => clock });

    // Walk 1: enqueues spec_b (ancestor key = spec_a:pr_open).
    await walker.walk(PROJECT);
    expect(enqueuer.records.length).toBe(1);

    // spec_a advances to ci_green (CI passed). Ancestor state key changes.
    lifecycle.entries["spec_a"] = "ci_green";

    // Walk 2 past the backoff window: ancestor PROGRESSED → re-eligible → re-enqueues spec_b.
    clock += 60_000;
    await walker.walk(PROJECT);
    expect(enqueuer.records.length).toBe(2);
    expect(enqueuer.records.every((r) => r.specId === "spec_b")).toBe(true);
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

    // Walk 1: spec_b enqueues speculatively (arms the backoff + records ancestor key).
    await walker.walk(PROJECT);
    expect(enqueuer.records.length).toBe(1);

    // spec_b's run took (it advanced to in_flight — occupying a slot, no longer pending). Past
    // the backoff window, a re-walk does NOT re-enqueue it (it is not a pending candidate).
    readModel.nodes = [node("spec_a", "in_flight", [], 0), node("spec_b", "in_flight", ["spec_a"], 1)];
    clock += 60_000;
    await walker.walk(PROJECT);
    expect(enqueuer.records.length).toBe(1);
  });

  it("a first-time speculative dependent with no prior attempt record always gets a chance (no phantom gating)", async () => {
    const clock = 0;
    // No prior attempt — first walk should always proceed regardless of ancestor-progress check.
    const readModel = new MutableReadModel([
      node("spec_a", "in_flight", [], 0),
      node("spec_b", "pending", ["spec_a"], 1),
    ]);
    const lifecycle = new MutableLifecycle({ spec_a: "pr_open", spec_b: "pending" });
    const { walker, enqueuer } = makeWalker({ readModel, lifecycle, clock: () => clock });

    await walker.walk(PROJECT);
    expect(enqueuer.records.length).toBe(1);
    expect(enqueuer.records[0]?.specId).toBe("spec_b");
  });
});
