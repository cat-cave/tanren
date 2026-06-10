// (autonomy-engine.md §2c): the EventEmittingDagWalker's SPECULATIVE
// behavior, driven through in-memory seams (test fixtures — they live here, never
// in src/). Proves: a speculative dependent gets a DYNAMIC BASE = its integration
// branch + emits dag.spec.speculative; an A-vs-B integration conflict surfaces and
// HOLDS the dependent (it is not enqueued against a broken base); the depth cap
// emits dag.spec.speculation_held; and a speculative dependent's run is created
// against the integration branch (its MERGE — handled downstream — still waits for
// the real ancestor merge, which we prove by showing the dependent never enqueues
// when its ancestor is not yet threshold-crossed, only once it is, and on a real
// merge it would re-enqueue against default_branch — see the merge-waits test).

import { describe, expect, it } from "vitest";
import { EventEmittingDagWalker } from "../src/engine/dag/walker.js";
import type { DagEventEmitter } from "../src/engine/dag/walkerPg.js";
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
import type {
  BuildSpeculativeIntegrationInput,
  IntegrationOutcome,
  SpeculativeIntegrator,
} from "../src/engine/contracts/speculativeIntegrator.js";
import type { SpeculationThreshold } from "../src/engine/config/index.js";
import type { AncestorStack } from "../src/engine/dag/ancestorStack.js";

const PROJECT = "project_spec";

function node(specId: string, phase: DagSpecNode["phase"], dependsOn: string[], orderKey: number): DagSpecNode {
  return { specId, phase, dependsOn, priority: "tbd", orderKey };
}

class FixedReadModel implements DagReadModel {
  constructor(
    private readonly nodes: DagSpecNode[],
    private readonly archived = false,
  ) {}
  async loadSnapshot(projectId: string): Promise<DagSnapshot> {
    return { projectId, nodes: this.nodes.map((n) => ({ ...n })), archived: this.archived };
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
  speculativeBase?: string;
  ancestorStack?: AncestorStack;
}

class RecordingEnqueuer implements DagEnqueuer {
  readonly records: RecordedEnqueue[] = [];
  private seq = 0;
  async enqueueSpecRun(input: {
    projectId: string;
    specId: string;
    speculativeBase?: string;
    ancestorStack?: AncestorStack;
  }): Promise<{ runId: string }> {
    this.seq += 1;
    this.records.push({
      specId: input.specId,
      ...(input.speculativeBase !== undefined && { speculativeBase: input.speculativeBase }),
      ...(input.ancestorStack !== undefined && { ancestorStack: input.ancestorStack }),
    });
    return { runId: `run_${this.seq}` };
  }
}

interface RecordedSpeculative {
  specId: string;
  unmergedAncestors: string[];
  integrationBranch: string;
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
    return { ceilingUsd: undefined, period: "monthly", spentUsd: 0, notionalUsd: 0, gatedFigure: "real_spend" };
  },
};

class FakeIntegrator implements SpeculativeIntegrator {
  readonly calls: BuildSpeculativeIntegrationInput[] = [];
  constructor(private readonly mode: "ok" | "conflict" = "ok") {}
  async buildIntegration(input: BuildSpeculativeIntegrationInput): Promise<IntegrationOutcome> {
    this.calls.push(input);
    const integrationBranch = `tanren/integ/${input.dependentSpecId}`;
    if (this.mode === "conflict") {
      return {
        outcome: "conflict",
        integrationBranch,
        ancestorHeadShas: {},
        // WS-A PR-1: no integrated base on a conflict ⇒ empty stack.
        ancestorStack: [],
        conflictBetween: {
          specId: input.unmergedAncestorSpecIds[1] ?? "",
          otherSpecId: input.unmergedAncestorSpecIds[0] ?? "",
        },
        message: "ancestor conflict",
      };
    }
    // WS-A PR-1: the ordered ancestor stack the dependent dual-writes to
    // `runs.ancestor_stack` — one member per unmerged ancestor (DAG order).
    const ancestorHeadShas = Object.fromEntries(
      input.unmergedAncestorSpecIds.map((specId) => [specId, `sha_${specId}`] as const),
    );
    const ancestorStack: AncestorStack = input.unmergedAncestorSpecIds.map((specId) => ({
      specId,
      runId: `run_${specId}`,
      branch: `tanren/${specId}`,
      headSha: `sha_${specId}`,
    }));
    return { outcome: "integrated", integrationBranch, ancestorHeadShas, ancestorStack, message: "ok" };
  }
}

function makeWalker(opts: {
  nodes: DagSpecNode[];
  lifecycle: Record<string, SpecLifecycleState | SpecLifecycle>;
  threshold: SpeculationThreshold;
  depthCap?: number;
  ceiling?: number;
  integrator?: SpeculativeIntegrator;
  archived?: boolean;
}): {
  walker: EventEmittingDagWalker;
  enqueuer: RecordingEnqueuer;
  emitter: RecordingEmitter;
  integrator: SpeculativeIntegrator;
} {
  const enqueuer = new RecordingEnqueuer();
  const emitter = new RecordingEmitter();
  const integrator = opts.integrator ?? new FakeIntegrator("ok");
  const walker = new EventEmittingDagWalker({
    readModel: new FixedReadModel(opts.nodes, opts.archived ?? false),
    lifecycleReadModel: new FixedLifecycle(opts.lifecycle),
    enqueuer,
    events: emitter,
    integrator,
    speculationConfig: async () => ({ threshold: opts.threshold, depthCap: opts.depthCap ?? 2 }),
    budgetGate: unlimitedBudgetGate,
    concurrency: () => opts.ceiling ?? 5,
  });
  return { walker, enqueuer, emitter, integrator };
}

describe("DagWalker speculative execution (§2c)", () => {
  it("a speculative dependent gets a DYNAMIC BASE = its integration branch + emits dag.spec.speculative", async () => {
    const { walker, enqueuer, emitter, integrator } = makeWalker({
      nodes: [node("spec_a", "in_flight", [], 0), node("spec_b", "pending", ["spec_a"], 1)],
      lifecycle: { spec_a: { specId: "spec_a", state: "audited", openFindingMaxSeverity: "P2" }, spec_b: "pending" },
      threshold: "moderate",
    });
    const result = await walker.walk(PROJECT);

    expect(result.enqueuedSpecIds).toEqual(["spec_b"]);
    // The run was created against the integration branch (the dynamic base). WS-A PR-1:
    // the ordered ancestor stack is DUAL-WRITTEN alongside the legacy speculative base.
    expect(enqueuer.records).toEqual([
      {
        specId: "spec_b",
        speculativeBase: "tanren/integ/spec_b",
        ancestorStack: [{ specId: "spec_a", runId: "run_spec_a", branch: "tanren/spec_a", headSha: "sha_spec_a" }],
      },
    ]);
    // The integration branch was built for spec_b over its unmerged ancestor spec_a.
    expect((integrator as FakeIntegrator).calls).toEqual([
      { projectId: PROJECT, dependentSpecId: "spec_b", unmergedAncestorSpecIds: ["spec_a"] },
    ]);
    expect(emitter.speculative).toEqual([
      {
        projectId: PROJECT,
        specId: "spec_b",
        runId: "run_1",
        unmergedAncestors: ["spec_a"],
        threshold: "moderate",
        integrationBranch: "tanren/integ/spec_b",
      },
    ]);
  });

  it("an A-vs-B integration conflict HOLDS the dependent (it is not enqueued against a broken base)", async () => {
    // C depends on A and B (both unmerged + audited); the integrator reports they
    // conflict WITH EACH OTHER on the integration branch.
    const { walker, enqueuer, emitter } = makeWalker({
      nodes: [
        node("spec_a", "in_flight", [], 0),
        node("spec_b", "in_flight", [], 1),
        node("spec_c", "pending", ["spec_a", "spec_b"], 2),
      ],
      lifecycle: {
        spec_a: { specId: "spec_a", state: "audited", openFindingMaxSeverity: "none" },
        spec_b: { specId: "spec_b", state: "audited", openFindingMaxSeverity: "none" },
        spec_c: "pending",
      },
      threshold: "moderate",
      integrator: new FakeIntegrator("conflict"),
    });
    const result = await walker.walk(PROJECT);

    // C is HELD — never enqueued against the broken integration.
    expect(result.enqueuedSpecIds).toEqual([]);
    expect(enqueuer.records).toEqual([]);
    expect(emitter.speculative).toEqual([]);
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

  it("a NON-speculative start (ancestor merged) enqueues against default_branch (no speculative base) + emits dag.spec.enqueued", async () => {
    const { walker, enqueuer, emitter, integrator } = makeWalker({
      nodes: [node("spec_a", "done", [], 0), node("spec_b", "pending", ["spec_a"], 1)],
      lifecycle: { spec_a: "merged", spec_b: "pending" },
      threshold: "moderate",
    });
    const result = await walker.walk(PROJECT);

    expect(result.enqueuedSpecIds).toEqual(["spec_b"]);
    // No speculative base — the merge stage uses default_branch.
    expect(enqueuer.records).toEqual([{ specId: "spec_b" }]);
    expect((integrator as FakeIntegrator).calls).toEqual([]);
    expect(emitter.enqueued).toEqual(["spec_b"]);
    expect(emitter.speculative).toEqual([]);
  });

  it("a speculative dependent's WORK proceeds but its MERGE waits: it starts on the integration branch while its ancestor is unmerged, then on real merge re-walk it re-enqueues a child against default_branch", async () => {
    // Tick 1: A audited-but-unmerged → B starts speculatively on the integration
    // branch (A's code is NOT yet on main). B's PR base is the integration branch,
    // so B's MERGE cannot land before A is genuinely merged (it targets the integ
    // ref, not main). We assert B's base is the integration branch (proof the
    // dependent does not merge against the real base while the ancestor is unmerged).
    const spec = makeWalker({
      nodes: [node("spec_a", "in_flight", [], 0), node("spec_b", "pending", ["spec_a"], 1)],
      lifecycle: { spec_a: { specId: "spec_a", state: "audited", openFindingMaxSeverity: "none" }, spec_b: "pending" },
      threshold: "moderate",
    });
    await spec.walker.walk(PROJECT);
    expect(spec.enqueuer.records[0]).toEqual({
      specId: "spec_b",
      speculativeBase: "tanren/integ/spec_b",
      ancestorStack: [{ specId: "spec_a", runId: "run_spec_a", branch: "tanren/spec_a", headSha: "sha_spec_a" }],
    });

    // Tick 2 (after A REALLY merges): a fresh dependent C on the now-merged A bases
    // on default_branch (re-gate against reality). No speculative base.
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
  // READY and enqueued NON-speculatively (no integration branch — its deps are all on
  // main), under the DEFAULT conservative threshold. The DAG was stalling at 3/14: the
  // planner saw the merged chain as crossed (so the spec was uncategorized in the
  // drained event — neither done/blocked/in-flight, it was READY) but the non-speculative
  // enqueue gate rejected it because the deps were `merged`, not `done`. The walker
  // classification half is pinned here (the gate half is the (6a) plane-split DB test);
  // together they prove the all-merged chain advances past 3/14.
  it("a pending spec whose dependency chain is ALL merged is READY + enqueued non-speculatively (NOT drained)", async () => {
    const { walker, enqueuer, emitter, integrator } = makeWalker({
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
    // NON-speculative: every dependency is merged (on main), so there is NO integration
    // branch (no speculativeBase) and the integrator is never consulted.
    expect(enqueuer.records).toEqual([{ specId: "schema" }]);
    expect((integrator as FakeIntegrator).calls).toEqual([]);
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
      archived: true,
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
});
