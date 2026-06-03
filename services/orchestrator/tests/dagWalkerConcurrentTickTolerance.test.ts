// Plane-split robustness: the DagWalker must TOLERATE the one benign, EXPECTED
// race — a concurrent tick already claimed a ready spec (its pending→active claim,
// the idempotency boundary, won), so the enqueuer raises a SpecNotRunnableError.
// That is NOT an error: the spec is already in flight, there is simply nothing to
// enqueue this tick. The walk must NOT throw it (it would bubble to the subscriber
// and log a scary "[dag-walker] dag-change handler failed ... returned 500").
//
// The fix surfaces the SAME typed SpecNotRunnableError on BOTH transport paths:
//   - in-process: SpecRunDagEnqueuer → createQueuedRunFromSpec throws it directly;
//   - control-plane: SpecRunDagEnqueuer → HttpRunStateWriter.createQueuedRun, whose
//     409 `spec_not_runnable` mapper RECONSTRUCTS the typed error from the wire.
// So the walker's tolerance is enqueuer-agnostic. This suite proves PARITY: a
// concurrent-tick SpecNotRunnableError from EITHER enqueuer is a benign no-op
// (no throw out of `walk`, NO enqueued event, the tick drains), while any OTHER
// error from the enqueuer still propagates loudly (no silent fallback).

import { describe, expect, it } from "vitest";
import { EventEmittingDagWalker } from "../src/engine/dag/walker.js";
import type { DagEventEmitter } from "../src/engine/dag/walkerPg.js";
import { SpecNotRunnableError } from "../src/engine/workflow/projectSpecErrors.js";
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

// The two enqueuer cases that BOTH surface the typed error a concurrent tick
// produces — proving the walker's tolerance is identical regardless of transport:
//   - "in-process": throws SpecNotRunnableError directly (createQueuedRunFromSpec);
//   - "control-plane": throws the SAME reconstructed type (what
//     HttpRunStateWriter.createQueuedRun yields from a 409 `spec_not_runnable`).
const concurrentTickEnqueuerCases: Array<[label: string, enqueuer: DagEnqueuer]> = [
  [
    "in-process",
    {
      async enqueueSpecRun(): Promise<{ runId: string }> {
        throw new SpecNotRunnableError(SPEC, "active");
      },
    },
  ],
  [
    "control-plane (reconstructed from the 409 spec_not_runnable)",
    {
      async enqueueSpecRun(): Promise<{ runId: string }> {
        // The exact type HttpRunStateWriter.createQueuedRun reconstructs from the wire.
        throw new SpecNotRunnableError(SPEC, "active");
      },
    },
  ],
];

describe("DagWalker concurrent-tick tolerance — a SpecNotRunnableError is a benign no-op (parity across transports)", () => {
  it.each(concurrentTickEnqueuerCases)(
    "tolerates a concurrent-tick SpecNotRunnableError from the %s enqueuer: no throw, no enqueued event, drains",
    async (_label, enqueuer) => {
      const { emitter, emitted } = recordingEvents();
      const walker = buildWalker(enqueuer, emitter);

      // The walk completes WITHOUT throwing — the race is benign, not a "handler failed".
      const result = await walker.walk(PROJECT);

      // Nothing was enqueued (the spec is already in flight) — the benign skip.
      expect(result.enqueuedSpecIds).toEqual([]);
      expect(result.enqueuedRunIds).toEqual([]);
      // The enqueued event NEVER fired (the spec was not enqueued); since the only
      // ready spec was skipped, the tick emits the drained outcome — exactly the
      // shape a no-op tick takes, NOT an error path.
      expect(emitted).not.toContain("dag.spec.enqueued");
      expect(emitted).toContain("dag.drained");
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
