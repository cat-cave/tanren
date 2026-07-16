// (autonomy-engine.md §2c; walker-jj-local-integration-design.md §4): the
// EventEmittingDagWalker's SPECULATIVE behavior, driven through in-memory seams (test
// fixtures — they live here, never in src/). Proves: a speculative dependent RESOLVES its
// ordered unmerged-ancestor stack (the real PR-head branches) + persists it as
// `ancestor_stack` + emits dag.spec.speculative — NO synthesized host integration ref; the
// depth cap emits dag.spec.speculation_held; a non-speculative start (all deps merged)
// enqueues against default_branch (no stack). The ancestor-vs-ancestor conflict is NO LONGER
// detected at walk time (§4a) — it surfaces during the dependent's own bootstrap assembly.

import { describe, expect, it } from "vitest";
import { EventEmittingDagWalker } from "../src/engine/dag/walker.js";
import type { DagAncestorStackResolver, DagEventEmitter } from "../src/engine/dag/walkerPg.js";
import type {
  BudgetGate,
  DagEnqueuer,
  DagReadModel,
  DagSnapshot,
  DagSpecNode,
  DagTickPlan,
  ProjectBudgetState,
} from "../src/engine/contracts/dagWalker.js";
import type {
  DagLifecycleReadModel,
  DagLifecycleSnapshot,
  SpecLifecycle,
  SpecLifecycleState,
} from "../src/engine/contracts/dagLifecycle.js";
import type { ResolvedAncestorBranch } from "../src/engine/dag/ancestorStack.js";
import type { SpeculationThreshold } from "../src/engine/config/index.js";
import type { AncestorStack } from "../src/engine/dag/ancestorStack.js";

const PROJECT = "project_spec";

function node(specId: string, phase: DagSpecNode["phase"], dependsOn: string[], orderKey: number): DagSpecNode {
  return { specId, phase, dependsOn, priority: "tbd", orderKey };
}

class FixedReadModel implements DagReadModel {
  constructor(
    private readonly nodes: DagSpecNode[],
    private readonly projectLifecycle: DagSnapshot["projectLifecycle"] = "active",
  ) {}
  async loadSnapshot(projectId: string): Promise<DagSnapshot> {
    return {
      projectId,
      nodes: this.nodes.map((item) => ({ ...item })),
      projectLifecycle: this.projectLifecycle,
    };
  }
}

class FixedLifecycle implements DagLifecycleReadModel {
  constructor(private readonly entries: Record<string, SpecLifecycleState | SpecLifecycle>) {}
  async loadLifecycle(projectId: string): Promise<DagLifecycleSnapshot> {
    const bySpecId = new Map<string, SpecLifecycle>();
    for (const [specId, v] of Object.entries(this.entries)) {
      bySpecId.set(
        specId,
        typeof v === "string" ? { specId, state: v, openFindingMaxSeverity: v === "merged" ? "none" : "none" } : v,
      );
    }
    return { projectId, bySpecId };
  }
}

interface RecordedEnqueue {
  specId: string;
  ancestorStack?: AncestorStack;
}

class RecordingEnqueuer implements DagEnqueuer {
  readonly records: RecordedEnqueue[] = [];
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

interface RecordedSpeculative {
  specId: string;
  unmergedAncestors: string[];
  threshold: SpeculationThreshold;
}
interface RecordedHeld {
  specId: string;
  depth: number;
  depthCap: number;
}

class RecordingEmitter implements DagEventEmitter {
  readonly enqueued: string[] = [];
  readonly speculative: RecordedSpeculative[] = [];
  readonly held: RecordedHeld[] = [];
  readonly ancestorNotReady: Array<{ specId: string; ancestorSpecId: string; ancestorPhase: "pending" | "in_flight" }> =
    [];
  readonly drained: DagTickPlan[] = [];
  async emitSpecEnqueued(input: { specId: string }): Promise<void> {
    this.enqueued.push(input.specId);
  }
  async emitSpecSpeculative(input: RecordedSpeculative): Promise<void> {
    this.speculative.push(input);
  }
  async emitSpeculationHeld(input: RecordedHeld): Promise<void> {
    this.held.push(input);
  }
  async emitAncestorNotReady(input: {
    specId: string;
    ancestorSpecId: string;
    ancestorPhase: "pending" | "in_flight";
  }): Promise<void> {
    this.ancestorNotReady.push(input);
  }
  async emitDrained(input: { plan: DagTickPlan }): Promise<void> {
    this.drained.push(input.plan);
  }
  async emitBudgetPaused(): Promise<void> {}
  async emitBudgetMilestone(): Promise<boolean> {
    return true;
  }
  async emitConcurrencySaturated(): Promise<void> {}
}

/** Unlimited budget (no ceiling) — the speculative cases never exercise the gate. */
const unlimitedBudgetGate: BudgetGate = {
  async resolveBudget(): Promise<ProjectBudgetState> {
    return { ceilingUsd: undefined, period: "monthly", spentUsd: 0, notionalUsd: 0 };
  },
};

/** Resolve each unmerged ancestor to its real PR-head branch + run id (DAG order preserved). */
class FakeStackResolver implements DagAncestorStackResolver {
  readonly calls: Array<{ projectId: string; unmergedAncestorSpecIds: ReadonlyArray<string> }> = [];
  async resolveStack(input: {
    projectId: string;
    unmergedAncestorSpecIds: ReadonlyArray<string>;
  }): Promise<ReadonlyArray<ResolvedAncestorBranch>> {
    this.calls.push(input);
    return input.unmergedAncestorSpecIds.map((specId) => ({
      specId,
      runId: `run_${specId}`,
      branch: `tanren/${specId}`,
    }));
  }
}

function makeWalker(opts: {
  nodes: DagSpecNode[];
  lifecycle: Record<string, SpecLifecycleState | SpecLifecycle>;
  threshold: SpeculationThreshold;
  depthCap?: number;
  ceiling?: number;
  projectLifecycle?: DagSnapshot["projectLifecycle"];
}): {
  walker: EventEmittingDagWalker;
  enqueuer: RecordingEnqueuer;
  emitter: RecordingEmitter;
  stackResolver: FakeStackResolver;
} {
  const enqueuer = new RecordingEnqueuer();
  const emitter = new RecordingEmitter();
  const stackResolver = new FakeStackResolver();
  const walker = new EventEmittingDagWalker({
    readModel: new FixedReadModel(opts.nodes, opts.projectLifecycle),
    lifecycleReadModel: new FixedLifecycle(opts.lifecycle),
    enqueuer,
    events: emitter,
    ancestorStackResolver: stackResolver,
    speculationConfig: async () => ({ threshold: opts.threshold, depthCap: opts.depthCap ?? 2 }),
    budgetGate: unlimitedBudgetGate,
    concurrency: () => opts.ceiling ?? 5,
  });
  return { walker, enqueuer, emitter, stackResolver };
}

describe("DagWalker speculative execution (§2c)", () => {
  it("a speculative dependent persists its ANCESTOR STACK (the jj-local base) + emits dag.spec.speculative", async () => {
    const { walker, enqueuer, emitter, stackResolver } = makeWalker({
      nodes: [node("spec_a", "in_flight", [], 0), node("spec_b", "pending", ["spec_a"], 1)],
      lifecycle: { spec_a: { specId: "spec_a", state: "audited", openFindingMaxSeverity: "P2" }, spec_b: "pending" },
      threshold: "moderate",
    });
    const result = await walker.walk(PROJECT);

    expect(result.enqueuedSpecIds).toEqual(["spec_b"]);
    // The run carries the ordered ancestor stack (the jj-local base source) — NO host ref.
    // The per-ancestor headSha is an empty placeholder (the bootstrap assembly fills it).
    expect(enqueuer.records).toEqual([
      {
        specId: "spec_b",
        ancestorStack: [{ specId: "spec_a", runId: "run_spec_a", branch: "tanren/spec_a", headSha: "" }],
      },
    ]);
    // The stack was resolved for spec_b over its unmerged ancestor spec_a.
    expect(stackResolver.calls).toEqual([{ projectId: PROJECT, unmergedAncestorSpecIds: ["spec_a"] }]);
    expect(emitter.speculative).toEqual([
      {
        projectId: PROJECT,
        specId: "spec_b",
        runId: "run_1",
        unmergedAncestors: ["spec_a"],
        threshold: "moderate",
      },
    ]);
  });

  it("the depth cap emits dag.spec.speculation_held (not a silent truncation)", async () => {
    // C → B → A all unmerged-audited (depth 2), cap 1 → held with the event.
    const { walker, enqueuer, emitter } = makeWalker({
      nodes: [
        node("spec_a", "in_flight", [], 0),
        node("spec_b", "in_flight", ["spec_a"], 1),
        node("spec_c", "pending", ["spec_b"], 2),
      ],
      lifecycle: {
        spec_a: { specId: "spec_a", state: "audited", openFindingMaxSeverity: "none" },
        spec_b: { specId: "spec_b", state: "audited", openFindingMaxSeverity: "none" },
        spec_c: "pending",
      },
      threshold: "moderate",
      depthCap: 1,
    });
    const result = await walker.walk(PROJECT);

    expect(result.enqueuedSpecIds).toEqual([]);
    expect(enqueuer.records).toEqual([]);
    expect(emitter.held).toEqual([
      { projectId: PROJECT, specId: "spec_c", unmergedAncestors: ["spec_a", "spec_b"], depth: 2, depthCap: 1 },
    ]);
  });

  it("a NON-speculative start (ancestor merged) enqueues against default_branch (no ancestor stack) + emits dag.spec.enqueued", async () => {
    const { walker, enqueuer, emitter, stackResolver } = makeWalker({
      nodes: [node("spec_a", "done", [], 0), node("spec_b", "pending", ["spec_a"], 1)],
      lifecycle: { spec_a: "merged", spec_b: "pending" },
      threshold: "moderate",
    });
    const result = await walker.walk(PROJECT);

    expect(result.enqueuedSpecIds).toEqual(["spec_b"]);
    // No ancestor stack — the merge stage uses default_branch.
    expect(enqueuer.records).toEqual([{ specId: "spec_b" }]);
    expect(stackResolver.calls).toEqual([]);
    expect(emitter.enqueued).toEqual(["spec_b"]);
    expect(emitter.speculative).toEqual([]);
  });

  it("a speculative dependent's WORK proceeds but its MERGE waits: it starts on its ancestor stack while the ancestor is unmerged, then on real merge re-walk it re-enqueues a child against default_branch", async () => {
    // Tick 1: A audited-but-unmerged → B starts speculatively stacked on A (A's code is NOT
    // yet on main). B's base is the jj-assembled stack, so B's MERGE cannot land before A
    // genuinely merges (the merge stage HOLDS). We assert B's persisted ancestor stack.
    const spec = makeWalker({
      nodes: [node("spec_a", "in_flight", [], 0), node("spec_b", "pending", ["spec_a"], 1)],
      lifecycle: { spec_a: { specId: "spec_a", state: "audited", openFindingMaxSeverity: "none" }, spec_b: "pending" },
      threshold: "moderate",
    });
    await spec.walker.walk(PROJECT);
    expect(spec.enqueuer.records[0]).toEqual({
      specId: "spec_b",
      ancestorStack: [{ specId: "spec_a", runId: "run_spec_a", branch: "tanren/spec_a", headSha: "" }],
    });

    // Tick 2 (after A REALLY merges): a fresh dependent C on the now-merged A bases on
    // default_branch (re-gate against reality). No ancestor stack.
    const real = makeWalker({
      nodes: [node("spec_a", "done", [], 0), node("spec_c", "pending", ["spec_a"], 1)],
      lifecycle: { spec_a: "merged", spec_c: "pending" },
      threshold: "moderate",
    });
    await real.walker.walk(PROJECT);
    expect(real.enqueuer.records[0]).toEqual({ specId: "spec_c" });
  });

  // THE READY-NOT-ENQUEUED REGRESSION (apex v18): a `pending` schema spec whose
  // dependency chain is ALL `merged` (the scaffold→build→ci chain) must be classified
  // READY and enqueued NON-speculatively (no ancestor stack — its deps are all on main),
  // under the DEFAULT conservative threshold.
  it("a pending spec whose dependency chain is ALL merged is READY + enqueued non-speculatively (NOT drained)", async () => {
    const { walker, enqueuer, emitter, stackResolver } = makeWalker({
      // scaffold → build → ci all done/merged; the schema spec depends on all three.
      nodes: [
        node("scaffold", "done", [], 0),
        node("build", "done", ["scaffold"], 1),
        node("ci", "done", ["scaffold", "build"], 2),
        node("schema", "pending", ["scaffold", "build", "ci"], 3),
      ],
      lifecycle: { scaffold: "merged", build: "merged", ci: "merged", schema: "pending" },
      threshold: "conservative",
    });
    const result = await walker.walk(PROJECT);

    // The schema spec was classified READY and ENQUEUED — not stranded in a drained tick.
    expect(result.status).toBe("enqueued");
    expect(result.enqueuedSpecIds).toEqual(["schema"]);
    // NON-speculative: every dependency is merged (on main), so there is NO ancestor stack
    // and the resolver is never consulted.
    expect(enqueuer.records).toEqual([{ specId: "schema" }]);
    expect(stackResolver.calls).toEqual([]);
    // It emitted dag.spec.enqueued (the ready-spec outcome), never dag.drained.
    expect(emitter.enqueued).toEqual(["schema"]);
    expect(emitter.drained).toEqual([]);
  });

  it("an ARCHIVED project enqueues nothing — the walk short-circuits before planning", async () => {
    // A ready spec that WOULD enqueue on an active project; archived ⇒ dormant.
    const { walker, enqueuer, emitter } = makeWalker({
      nodes: [node("spec_ready", "pending", [], 0)],
      lifecycle: { spec_ready: "pending" },
      threshold: "moderate",
      projectLifecycle: "archived",
    });
    const result = await walker.walk(PROJECT);

    expect(result.status).toBe("archived");
    expect(result.enqueuedSpecIds).toEqual([]);
    expect(result.enqueuedRunIds).toEqual([]);
    // No enqueue, no event — fully dormant.
    expect(enqueuer.records).toEqual([]);
    expect(emitter.enqueued).toEqual([]);
    expect(emitter.drained).toEqual([]);
  });

  it("a DERIVING project enqueues nothing — only active projects are runnable", async () => {
    const { walker, enqueuer } = makeWalker({
      nodes: [node("spec_ready", "pending", [], 0)],
      lifecycle: { spec_ready: "pending" },
      threshold: "moderate",
      projectLifecycle: "deriving",
    });

    const result = await walker.walk(PROJECT);

    expect(result.status).toBe("deriving");
    expect(result.enqueuedSpecIds).toEqual([]);
    expect(enqueuer.records).toEqual([]);
  });
});
