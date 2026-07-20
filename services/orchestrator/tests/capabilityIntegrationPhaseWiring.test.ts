// Regression pin (in-9/in-10 finding-3): the DagWalker MUST invoke the
// capability_prepare integration phase — before spec planning — on every active
// walk, and the production construction seam must wire it. Guards against the phase
// silently becoming a dead path in a future refactor.

import { describe, expect, it } from "vitest";
import { EventEmittingDagWalker } from "../src/engine/dag/walker.js";
import type { DagEventEmitter, DagAncestorStackResolver } from "../src/engine/dag/walkerPg.js";
import type {
  BudgetGate,
  DagEnqueuer,
  DagReadModel,
  DagSnapshot,
  IntegrationPhase,
  ProjectBudgetState,
} from "../src/engine/contracts/dagWalker.js";
import type { DagLifecycleReadModel, DagLifecycleSnapshot } from "../src/engine/contracts/dagLifecycle.js";

const PROJECT = "proj_phase";
const SPEC = "spec_ready";

function readyReadModel(): DagReadModel {
  return {
    async loadSnapshot(projectId: string): Promise<DagSnapshot> {
      return {
        projectId,
        nodes: [{ specId: SPEC, phase: "pending", dependsOn: [], priority: "tbd", orderKey: 1 }],
        projectLifecycle: "active",
      };
    },
  };
}

function readyLifecycle(): DagLifecycleReadModel {
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
    return { ceilingUsd: undefined, period: "monthly", spentUsd: 0, notionalUsd: 0 };
  },
};

const neverStackResolver: DagAncestorStackResolver = {
  resolveStack: async (): Promise<never> => {
    throw new Error("non-speculative spec: the ancestor-stack resolver must not be called");
  },
};

const inertEvents = { async emitDrained() {}, async emitSpecEnqueued() {} } as unknown as DagEventEmitter;

function buildWalker(order: string[], integrationPhase?: IntegrationPhase): EventEmittingDagWalker {
  const enqueuer: DagEnqueuer = {
    async enqueueSpecRun(): Promise<{ runId: string }> {
      order.push("enqueue");
      return { runId: "run_1" };
    },
  };
  return new EventEmittingDagWalker({
    readModel: readyReadModel(),
    lifecycleReadModel: readyLifecycle(),
    enqueuer,
    events: inertEvents,
    ancestorStackResolver: neverStackResolver,
    speculationConfig: async () => ({ threshold: "conservative", depthCap: 2 }),
    budgetGate: noBudgetGate,
    concurrency: () => 4,
    ...(integrationPhase !== undefined && { integrationPhase }),
  });
}

describe("DagWalker integration-phase wiring (finding-3 pin)", () => {
  it("invokes integrationPhase.prepare BEFORE spec planning/enqueue", async () => {
    const order: string[] = [];
    const seen: string[] = [];
    const phase: IntegrationPhase = {
      async prepare(projectId: string): Promise<unknown> {
        seen.push(projectId);
        order.push("prepare");
        return {};
      },
    };
    const result = await buildWalker(order, phase).walk(PROJECT);
    expect(seen).toEqual([PROJECT]);
    expect(result.enqueuedSpecIds).toEqual([SPEC]);
    // prepare ran, and ran before the spec was enqueued.
    expect(order).toEqual(["prepare", "enqueue"]);
  });

  it("is a no-op when no integration phase is wired (optional)", async () => {
    const order: string[] = [];
    const result = await buildWalker(order).walk(PROJECT);
    expect(result.enqueuedSpecIds).toEqual([SPEC]);
    expect(order).toEqual(["enqueue"]);
  });

  it("is fail-safe: a throwing prepare never aborts spec scheduling", async () => {
    const order: string[] = [];
    const phase: IntegrationPhase = {
      async prepare(): Promise<unknown> {
        order.push("prepare");
        throw new Error("capability prepare boom");
      },
    };
    const result = await buildWalker(order, phase).walk(PROJECT);
    // The walk did NOT throw and STILL enqueued the ready spec.
    expect(result.enqueuedSpecIds).toEqual([SPEC]);
    expect(order).toEqual(["prepare", "enqueue"]);
  });
});
