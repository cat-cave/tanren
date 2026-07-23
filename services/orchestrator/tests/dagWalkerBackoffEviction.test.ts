// Issue #1072 F1 PROOF: the DagWalker's ancestor-wait backoff map is BOUNDED by live in-play
// specs, NOT by the cumulative count of specs the long-lived worker ever drove. A backoff entry
// is armed when a speculative dependent enters the wait set; it must be EVICTED when its spec
// leaves play — reaches a WALKER-TERMINAL DAG phase (`done`/`terminal_blocked`), is deleted, or
// its project goes non-active — so the map never leaks an inert entry per distinct spec forever.
//
// CRITICAL (the adversarial-audit flip case): the eviction predicate keys on the spec's DAG phase
// (its `specs.status`), NOT the lifecycle ladder. A dependent that hit `AncestorNotReadyError` is
// re_driven — its spec is STILL `open` (phase `pending`) while its LATEST RUN is `halted`, which
// `projectSpecLifecycle` derives to lifecycle `blocked`. That is the NORMAL waiting state the
// hot-loop gate exists for; its entry MUST be retained, or the walker re-provisions a runner storm
// on every terminal notification. See `pruneAncestorWaitBackoff`.
//
// Driven through the in-memory walker seams (TEST FIXTURES) + a clock-injected HeldReDriveBackoff,
// asserted deterministically with no DB.

import { describe, expect, it } from "vitest";
import { EventEmittingDagWalker } from "../src/engine/dag/walker.js";
import { HeldReDriveBackoff } from "../src/engine/dag/heldReDriveBackoff.js";
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

const PROJECT = "project_backoff_eviction";

function node(specId: string, phase: DagSpecNode["phase"], dependsOn: string[], orderKey: number): DagSpecNode {
  return { specId, phase, dependsOn, priority: "tbd", orderKey };
}

/** A mutable lifecycle snapshot the test can flip to simulate a run halting / a spec merging. */
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

/** A mutable DAG snapshot: the test flips node phases to model merge / halt / removal. */
class MutableReadModel implements DagReadModel {
  constructor(public nodes: DagSpecNode[]) {}
  async loadSnapshot(projectId: string): Promise<DagSnapshot> {
    return { projectId, nodes: this.nodes.map((item) => ({ ...item })), projectLifecycle: "active" };
  }
}

/** Records every speculative enqueue — each models a real runner allocation + token + clone. */
class RecordingEnqueuer implements DagEnqueuer {
  readonly records: Array<{ specId: string }> = [];
  private seq = 0;
  async enqueueSpecRun(input: { projectId: string; specId: string }): Promise<{ runId: string }> {
    this.seq += 1;
    this.records.push({ specId: input.specId });
    return { runId: `run_${this.seq}` };
  }
}

class CountingStackResolver implements DagAncestorStackResolver {
  async resolveStack(input: {
    projectId: string;
    unmergedAncestorSpecIds: ReadonlyArray<string>;
  }): Promise<ReadonlyArray<ResolvedAncestorBranch>> {
    return input.unmergedAncestorSpecIds.map((specId) => ({
      specId,
      runId: `run_${specId}`,
      branch: `tanren/${specId}`,
    }));
  }
}

class NoopEmitter implements DagEventEmitter {
  async emitSpecEnqueued(): Promise<void> {}
  async emitSpecSpeculative(): Promise<void> {}
  async emitSpeculationHeld(): Promise<void> {}
  async emitAncestorNotReady(): Promise<void> {}
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

/** Build a walker over the supplied backoff so a test can inspect its map size. */
function makeWalkerWith(opts: {
  readModel: MutableReadModel;
  lifecycle: MutableLifecycle;
  backoff: HeldReDriveBackoff;
}): { walker: EventEmittingDagWalker; enqueuer: RecordingEnqueuer } {
  const enqueuer = new RecordingEnqueuer();
  const walker = new EventEmittingDagWalker({
    readModel: opts.readModel,
    lifecycleReadModel: opts.lifecycle,
    enqueuer,
    events: new NoopEmitter(),
    ancestorStackResolver: new CountingStackResolver(),
    speculationConfig: async () => ({ threshold: "aggressive", depthCap: 5 }),
    budgetGate: unlimitedBudgetGate,
    concurrency: () => 5,
    ancestorWaitBackoff: opts.backoff,
  });
  return { walker, enqueuer };
}

describe("DagWalker ancestor-wait backoff map is BOUNDED — DAG-phase eviction (issue #1072 F1)", () => {
  it("evicts a dependent's backoff entry once its spec reaches a terminal (merged → phase `done`) state", async () => {
    let clock = 0;
    const backoff = new HeldReDriveBackoff(() => clock);
    const readModel = new MutableReadModel([
      node("spec_a", "in_flight", [], 0),
      node("spec_b", "pending", ["spec_a"], 1),
    ]);
    const lifecycle = new MutableLifecycle({ spec_a: "pr_open", spec_b: "pending" });
    const { walker, enqueuer } = makeWalkerWith({ readModel, lifecycle, backoff });

    // Walk 1: spec_b enters the wait set (speculative enqueue) → its backoff entry is armed.
    await walker.walk(PROJECT);
    expect(enqueuer.records.length).toBe(1);
    expect(backoff.size()).toBe(1);

    // A walk while spec_b is STILL in play (phase `pending`) RETAINS the entry — the gate must keep
    // spacing it; eviction must not fire prematurely.
    clock += 5;
    await walker.walk(PROJECT);
    expect(backoff.size()).toBe(1);

    // spec_b's run MERGES: its DAG node is `done` (spec status `merged`).
    lifecycle.entries["spec_b"] = "merged";
    readModel.nodes = [node("spec_a", "in_flight", [], 0), node("spec_b", "done", ["spec_a"], 1)];
    clock += 60_000;
    await walker.walk(PROJECT);

    // The dead entry is EVICTED — the map is bounded by live in-play specs, not cumulative.
    expect(backoff.size()).toBe(0);
  });

  it("RETAINS the entry for an OPEN spec whose LATEST RUN halted (lifecycle would say `blocked`) — no re-drive storm", async () => {
    // The audit's flip case. A dependent that hit `AncestorNotReadyError` is re_driven: spec STILL
    // `open` (phase `pending`) while its latest RUN is `halted` → `projectSpecLifecycle` derives
    // lifecycle `blocked`. The entry MUST be retained. A lifecycle-`blocked` predicate would drop it
    // here and re-provision a runner on every terminal notification; the DAG-phase predicate keeps it.
    let clock = 0;
    const backoff = new HeldReDriveBackoff(() => clock);
    const readModel = new MutableReadModel([
      node("spec_a", "in_flight", [], 0),
      node("spec_b", "pending", ["spec_a"], 1),
    ]);
    const lifecycle = new MutableLifecycle({ spec_a: "pr_open", spec_b: "pending" });
    const { walker, enqueuer } = makeWalkerWith({ readModel, lifecycle, backoff });

    // Walk 1: spec_b enqueues speculatively → its entry is armed.
    await walker.walk(PROJECT);
    expect(enqueuer.records.length).toBe(1);
    expect(backoff.size()).toBe(1);

    // spec_b's run HALTS (AncestorNotReadyError → re_drive): spec stays `open` (phase `pending`),
    // latest-run lifecycle flips to `blocked`. The ancestor did NOT progress (spec_a stays pr_open).
    lifecycle.entries["spec_b"] = "blocked";

    // Several run-terminal re-walks past the backoff window. Lifecycle-`blocked` predicate ⇒ evict
    // here ⇒ re-drive EVERY walk (storm). DAG-phase predicate ⇒ retained ⇒ progress-gate keeps skipping.
    for (let t = 60_000; t <= 60_000 * 5; t += 60_000) {
      clock = t;
      await walker.walk(PROJECT);
    }

    // The entry survived every walk AND the gate held — NO re-drive storm.
    expect(backoff.size()).toBe(1);
    expect(enqueuer.records.length).toBe(1);

    // Only when spec_b GENUINELY terminates (merged → phase `done`) is the entry freed.
    lifecycle.entries["spec_b"] = "merged";
    readModel.nodes = [node("spec_a", "in_flight", [], 0), node("spec_b", "done", ["spec_a"], 1)];
    clock += 60_000;
    await walker.walk(PROJECT);
    expect(backoff.size()).toBe(0);
  });

  it("evicts on a genuinely terminal SPEC STATUS (halted spec → phase `terminal_blocked`)", async () => {
    let clock = 0;
    const backoff = new HeldReDriveBackoff(() => clock);
    const readModel = new MutableReadModel([
      node("spec_a", "in_flight", [], 0),
      node("spec_b", "pending", ["spec_a"], 1),
    ]);
    const lifecycle = new MutableLifecycle({ spec_a: "pr_open", spec_b: "pending" });
    const { walker } = makeWalkerWith({ readModel, lifecycle, backoff });

    await walker.walk(PROJECT);
    expect(backoff.size()).toBe(1);

    // The SPEC itself terminates (status halted/cancelled/needs_attention → phase `terminal_blocked`),
    // no longer open to re-planning. Distinct from a halted RUN on an open spec (previous test).
    readModel.nodes = [node("spec_a", "in_flight", [], 0), node("spec_b", "terminal_blocked", ["spec_a"], 1)];
    clock += 60_000;
    await walker.walk(PROJECT);
    expect(backoff.size()).toBe(0);
  });

  it("does NOT accumulate an entry per spec across many dependents completing — map stays bounded", async () => {
    let clock = 0;
    const backoff = new HeldReDriveBackoff(() => clock);
    // One long-lived ancestor (stays `pr_open`, never gets its own entry — only DEPENDENTS record).
    // A fresh dependent enters the wait set, then merges, over many iterations. WITHOUT eviction the
    // map grows to N; WITH it, it is bounded by the single live dependent and returns to zero.
    let maxSize = 0;
    for (let i = 1; i <= 20; i += 1) {
      const dep = `spec_dep_${i}`;
      const readModel = new MutableReadModel([node("spec_a", "in_flight", [], 0), node(dep, "pending", ["spec_a"], i)]);
      const lifecycle = new MutableLifecycle({ spec_a: "pr_open", [dep]: "pending" });
      const { walker, enqueuer } = makeWalkerWith({ readModel, lifecycle, backoff });

      clock += 1_000;
      await walker.walk(PROJECT);
      expect(enqueuer.records.length).toBe(1);
      maxSize = Math.max(maxSize, backoff.size());

      // It merges; the next walk (of THIS project) evicts its now-dead (phase `done`) entry.
      lifecycle.entries[dep] = "merged";
      readModel.nodes = [node("spec_a", "in_flight", [], 0), node(dep, "done", ["spec_a"], i)];
      clock += 60_000;
      await walker.walk(PROJECT);
    }

    expect(maxSize).toBe(1);
    expect(backoff.size()).toBe(0);
  });

  it("a project going non-active evicts ALL of its backoff entries (empty live set)", async () => {
    let clock = 0;
    const backoff = new HeldReDriveBackoff(() => clock);
    const readModel = new MutableReadModel([
      node("spec_a", "in_flight", [], 0),
      node("spec_b", "pending", ["spec_a"], 1),
    ]);
    const lifecycle = new MutableLifecycle({ spec_a: "pr_open", spec_b: "pending" });
    const { walker } = makeWalkerWith({ readModel, lifecycle, backoff });

    await walker.walk(PROJECT);
    expect(backoff.size()).toBe(1);

    // The project is archived: loadSnapshot reports a non-active lifecycle, so the retain set is
    // empty and every one of this project's entries is freed.
    readModel.loadSnapshot = async (projectId: string) => ({ projectId, nodes: [], projectLifecycle: "archived" });
    clock += 60_000;
    await walker.walk(PROJECT);
    expect(backoff.size()).toBe(0);
  });
});
