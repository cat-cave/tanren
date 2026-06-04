// Plane-split robustness: the DagWalker must TOLERATE the BENIGN, EXPECTED
// per-spec enqueue conditions — neither is a real failure, and neither may abort
// the tick (which would starve the OTHER ready specs and stall the DAG):
//
//   1. SpecNotRunnableError — a concurrent tick already claimed a ready spec (its
//      pending→active claim, the idempotency boundary, won). The spec is already
//      in flight; there is simply nothing to enqueue this tick.
//   2. SpecDependenciesBlockedError — the spec's dependencies are not yet `done`
//      at enqueue time (the planner saw them merged via the lifecycle projection,
//      but the `specs.status='done'` write was not yet visible to the enqueue tx).
//      The spec simply is not ready yet; a later tick enqueues it once the
//      dependency lands as done.
//
// The walk must NOT throw either (it would bubble to the subscriber and log a
// scary "[dag-walker] run-activity handler failed ... returned 500"). The fix
// surfaces the SAME typed error on BOTH transport paths:
//   - in-process: SpecRunDagEnqueuer → createQueuedRunFromSpec throws it directly;
//   - control-plane: SpecRunDagEnqueuer → HttpRunStateWriter.createQueuedRun, whose
//     typed-409 mapper RECONSTRUCTS the typed error from the wire.
// So the walker's tolerance is enqueuer-agnostic. This suite proves: a benign
// typed error from EITHER enqueuer is a benign no-op (no throw out of `walk`, NO
// enqueued event for THAT spec), that a benign skip of one spec STILL enqueues the
// OTHER ready specs in the same tick (no tick abort), while any OTHER error from
// the enqueuer still propagates loudly (no silent fallback).

import { describe, expect, it } from "vitest";
import { EventEmittingDagWalker } from "../src/engine/dag/walker.js";
import type { DagEventEmitter } from "../src/engine/dag/walkerPg.js";
import { SpecDependenciesBlockedError, SpecNotRunnableError } from "../src/engine/workflow/projectSpecErrors.js";
import type {
  BudgetGate,
  DagEnqueuer,
  DagReadModel,
  DagSnapshot,
  ProjectBudgetState,
} from "../src/engine/contracts/dagWalker.js";
import type { DagLifecycleReadModel, DagLifecycleSnapshot } from "../src/engine/contracts/dagLifecycle.js";
import type { SpeculativeIntegrator } from "../src/engine/contracts/speculativeIntegrator.js";

const PROJECT = "proj_tick";
const SPEC = "spec_ready";
const OTHER_SPEC = "spec_ready_other";

/** A single ready (pending) spec with no dependencies, so the planner enqueues it. */
function readyReadModel(): DagReadModel {
  return {
    async loadSnapshot(projectId: string): Promise<DagSnapshot> {
      return { projectId, nodes: [{ specId: SPEC, phase: "pending", dependsOn: [], priority: "tbd", orderKey: 1 }] };
    },
  };
}

/** A lifecycle projection where the spec is pending (conservative threshold, no deps). */
function emptyLifecycleReadModel(): DagLifecycleReadModel {
  return {
    async loadLifecycle(projectId: string): Promise<DagLifecycleSnapshot> {
      return {
        projectId,
        bySpecId: new Map([[SPEC, { specId: SPEC, state: "pending", openFindingMaxSeverity: "unaudited" }]]),
      };
    },
  };
}

/** Two independent ready (pending, no-deps) specs — so the planner enqueues BOTH. */
function twoReadySpecsReadModel(): DagReadModel {
  return {
    async loadSnapshot(projectId: string): Promise<DagSnapshot> {
      return {
        projectId,
        nodes: [
          { specId: SPEC, phase: "pending", dependsOn: [], priority: "tbd", orderKey: 1 },
          { specId: OTHER_SPEC, phase: "pending", dependsOn: [], priority: "tbd", orderKey: 2 },
        ],
      };
    },
  };
}

/** The matching lifecycle projection: both specs pending (no deps, conservative). */
function twoReadySpecsLifecycle(): DagLifecycleReadModel {
  return {
    async loadLifecycle(projectId: string): Promise<DagLifecycleSnapshot> {
      return {
        projectId,
        bySpecId: new Map([
          [SPEC, { specId: SPEC, state: "pending", openFindingMaxSeverity: "unaudited" }],
          [OTHER_SPEC, { specId: OTHER_SPEC, state: "pending", openFindingMaxSeverity: "unaudited" }],
        ]),
      };
    },
  };
}

const noBudgetGate: BudgetGate = {
  async resolveBudget(): Promise<ProjectBudgetState> {
    return { ceilingUsd: undefined, period: "monthly", spentUsd: 0 };
  },
};

const neverIntegrator: SpeculativeIntegrator = {
  buildIntegration: async (): Promise<never> => {
    throw new Error("non-speculative spec: integrator must not be called");
  },
};

/** A recording event emitter: every emit is captured so the test can assert NO enqueued event fired. */
function recordingEvents(): { emitter: DagEventEmitter; emitted: string[] } {
  const emitted: string[] = [];
  const emitter = {
    async emitSpecEnqueued() {
      emitted.push("dag.spec.enqueued");
    },
    async emitSpecSpeculative() {
      emitted.push("dag.spec.speculative");
    },
    async emitSpeculationHeld() {
      emitted.push("dag.spec.speculation_held");
    },
    async emitDrained() {
      emitted.push("dag.drained");
    },
    async emitBudgetPaused() {
      emitted.push("dag.budget.paused");
    },
    async emitConcurrencySaturated() {
      emitted.push("dag.concurrency.saturated");
    },
  } as unknown as DagEventEmitter;
  return { emitter, emitted };
}

function buildWalker(enqueuer: DagEnqueuer, emitter: DagEventEmitter): EventEmittingDagWalker {
  return new EventEmittingDagWalker({
    readModel: readyReadModel(),
    lifecycleReadModel: emptyLifecycleReadModel(),
    enqueuer,
    events: emitter,
    integrator: neverIntegrator,
    speculationConfig: async () => ({ threshold: "conservative", depthCap: 2 }),
    budgetGate: noBudgetGate,
    concurrency: () => 4,
  });
}

// The benign typed errors the walker must tolerate, each produced identically by
// the in-process enqueuer (createQueuedRunFromSpec throws it directly) AND the
// control-plane enqueuer (HttpRunStateWriter.createQueuedRun reconstructs the SAME
// type from the typed 409) — so the walker's tolerance is enqueuer-agnostic.
const benignErrorCases: Array<[label: string, makeError: () => Error]> = [
  ["SpecNotRunnableError (concurrent-tick claim race)", () => new SpecNotRunnableError(SPEC, "active")],
  ["SpecDependenciesBlockedError (deps not yet done)", () => new SpecDependenciesBlockedError(SPEC, ["spec_dep"])],
];

describe("DagWalker benign-skip tolerance — a typed benign per-spec error is a no-op (not a tick abort)", () => {
  it.each(benignErrorCases)("tolerates a %s: no throw, no enqueued event, drains", async (_label, makeError) => {
    const { emitter, emitted } = recordingEvents();
    const enqueuer: DagEnqueuer = {
      async enqueueSpecRun(): Promise<{ runId: string }> {
        throw makeError();
      },
    };
    const walker = buildWalker(enqueuer, emitter);

    // The walk completes WITHOUT throwing — the condition is benign, not a "handler failed".
    const result = await walker.walk(PROJECT);

    // Nothing was enqueued (benign skip) — the only ready spec was skipped.
    expect(result.enqueuedSpecIds).toEqual([]);
    expect(result.enqueuedRunIds).toEqual([]);
    // The enqueued event NEVER fired; since the only ready spec was skipped, the
    // tick emits the drained outcome — the shape a no-op tick takes, NOT an error.
    expect(emitted).not.toContain("dag.spec.enqueued");
    expect(emitted).toContain("dag.drained");
  });

  // The crux of the fix: a benign skip of ONE spec must NOT abort the tick — the
  // OTHER ready specs in the same tick must still be enqueued.
  it.each(benignErrorCases)(
    "a benign %s on one spec STILL enqueues the OTHER ready spec in the same tick (no tick abort)",
    async (_label, makeError) => {
      const { emitter, emitted } = recordingEvents();
      const enqueuedSpecs: string[] = [];
      const enqueuer: DagEnqueuer = {
        async enqueueSpecRun(input: { specId: string }): Promise<{ runId: string }> {
          // The first ready spec hits the benign condition; the second enqueues fine.
          if (input.specId === SPEC) throw makeError();
          enqueuedSpecs.push(input.specId);
          return { runId: `run_${input.specId}` };
        },
      };
      const walker = new EventEmittingDagWalker({
        readModel: twoReadySpecsReadModel(),
        lifecycleReadModel: twoReadySpecsLifecycle(),
        enqueuer,
        events: emitter,
        integrator: neverIntegrator,
        speculationConfig: async () => ({ threshold: "conservative", depthCap: 2 }),
        budgetGate: noBudgetGate,
        concurrency: () => 4,
      });

      const result = await walker.walk(PROJECT);

      // The benign spec was skipped, but the OTHER ready spec WAS enqueued — the
      // tick continued past the benign skip instead of aborting.
      expect(enqueuedSpecs).toEqual([OTHER_SPEC]);
      expect(result.enqueuedSpecIds).toEqual([OTHER_SPEC]);
      expect(emitted).toContain("dag.spec.enqueued");
    },
  );

  it("still propagates a GENUINE enqueuer error loudly (no silent fallback for real failures)", async () => {
    const { emitter } = recordingEvents();
    const enqueuer: DagEnqueuer = {
      async enqueueSpecRun(): Promise<{ runId: string }> {
        throw new Error("control plane unreachable (genuine infra fault)");
      },
    };
    const walker = buildWalker(enqueuer, emitter);

    // A real failure is NOT swallowed — it bubbles out of the walk.
    await expect(walker.walk(PROJECT)).rejects.toThrow(/control plane unreachable/u);
  });
});
