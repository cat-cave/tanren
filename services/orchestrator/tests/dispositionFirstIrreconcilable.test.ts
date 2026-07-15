// F2 hostile: routeIrreconcilable aux history is disposition-first.
// Old bug: always append merge.conflict.irreconcilable with replanned fields after route.

import { describe, expect, it } from "vitest";
import type {
  ConflictAnswererInvoker,
  ConflictProvenanceReader,
  ReplanRouteResult,
  ReplanRouter,
  ResolvedTreeReGate,
  SpecIntent,
  WorkspaceConflictApplier,
} from "../src/engine/contracts/conflictResolution.js";
import { buildIntentPreservingConflictResolver } from "../src/engine/workflow/reviewMerge/conflictResolver/resolver.js";
import type { ConflictContext } from "../src/engine/workflow/reviewMerge/index.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";

const MERGING: SpecIntent = {
  specId: "spec_merging",
  title: "A",
  description: "a",
  acceptanceCriteria: ["x"],
};
const CONTEXT: ConflictContext = {
  runId: "run_1",
  prUrl: "https://github.com/o/r/pull/1",
  prNumber: 1,
  baseBranch: "main",
  message: "conflict",
};

function applier(): WorkspaceConflictApplier {
  return {
    gather: async () => ({
      files: [{ path: "f.ts", conflictedContent: "<<<<<<<\na\n=======\nb\n>>>>>>>\n" }],
    }),
    applyResolution: async () => {},
    publishResolved: async () => {},
    abort: async () => {},
  };
}

function provenance(): ConflictProvenanceReader {
  return {
    read: async () => ({
      conflictingSpecId: "spec_base",
      conflictingSpecIntent: {
        specId: "spec_base",
        title: "B",
        description: "b",
        acceptanceCriteria: ["y"],
      },
      dagEdge: true,
    }),
  };
}

function answererIrreconcilable(): ConflictAnswererInvoker {
  return {
    resolve: async () => ({
      decision: "irreconcilable",
      reasoning: "intents collide",
      resolvedFiles: [],
      replanSpec: { which: "merging", newContext: "re-plan ON TOP OF the base change" },
    }),
  };
}

function reGateOk(): ResolvedTreeReGate {
  return { reGate: async () => ({ passed: true, reason: "ok" }) };
}

function replanReturning(result: ReplanRouteResult): ReplanRouter {
  return { routeBackToPlanner: async () => result };
}

async function runIrreconcilable(result: ReplanRouteResult) {
  const events = new FakeEventStore();
  const hook = buildIntentPreservingConflictResolver({
    projectId: "proj",
    orgId: "org",
    mergingSpecIntent: MERGING,
    eventStore: events,
    provenance: provenance(),
    applier: applier(),
    answerer: answererIrreconcilable(),
    reGate: reGateOk(),
    replan: replanReturning(result),
  });
  const out = await hook(CONTEXT);
  return { out, events };
}

describe("F2 routeIrreconcilable disposition-first aux events", () => {
  it("owned → irreconcilable WITH replanned fields", async () => {
    const { out, events } = await runIrreconcilable({
      kind: "owned",
      receipt: {
        kind: "planner_replan",
        specId: "spec_merging",
        run: { kind: "already_running", runId: "live" },
      },
    });
    expect(out).toMatchObject({ resolved: false, recovery: { kind: "owned" } });
    const irreconcilableEvent = events.events.find((e) => e.eventType === "merge.conflict.irreconcilable");
    expect(irreconcilableEvent).toBeDefined();
    expect(irreconcilableEvent?.payload).toMatchObject({
      replanned: "merging",
      replannedSpecId: "spec_merging",
    });
  });

  it("parked → no irreconcilable (park lineage only)", async () => {
    const { out, events } = await runIrreconcilable({
      kind: "parked",
      receipt: { kind: "needs_attention", specId: "spec_merging", source: "planner_replan" },
      message: "parked",
    });
    expect(out).toMatchObject({ resolved: false, recovery: { kind: "parked" } });
    expect(events.events.some((e) => e.eventType === "merge.conflict.irreconcilable")).toBe(false);
  });

  it("terminal_noop → zero aux claiming conflict/replan", async () => {
    const { out, events } = await runIrreconcilable({
      kind: "terminal_noop",
      status: "merged",
      message: "merged",
    });
    expect(out).toMatchObject({ resolved: false, recovery: { kind: "terminal_noop" } });
    expect(events.events.some((e) => e.eventType === "merge.conflict.irreconcilable")).toBe(false);
  });

  it("parking_failed → zero aux claiming conflict/replan", async () => {
    const { out, events } = await runIrreconcilable({ kind: "parking_failed", message: "fail" });
    expect(out).toMatchObject({ resolved: false, recovery: { kind: "parking_failed" } });
    expect(events.events.some((e) => e.eventType === "merge.conflict.irreconcilable")).toBe(false);
  });

  it("HOSTILE: parking_required (empty gather, no replan) leaves zero irreconcilable aux", async () => {
    const events = new FakeEventStore();
    const hook = buildIntentPreservingConflictResolver({
      projectId: "proj",
      orgId: "org",
      mergingSpecIntent: MERGING,
      eventStore: events,
      provenance: provenance(),
      applier: {
        gather: async () => ({ files: [] }),
        applyResolution: async () => {},
        publishResolved: async () => {},
        abort: async () => {},
      },
      answerer: answererIrreconcilable(),
      reGate: reGateOk(),
      replan: replanReturning({
        kind: "owned",
        receipt: {
          kind: "planner_replan",
          specId: "x",
          run: { kind: "already_running", runId: "live" },
        },
      }),
    });
    const out = await hook(CONTEXT);
    expect(out).toMatchObject({ resolved: false, recovery: { kind: "parking_required" } });
    expect(events.events.some((e) => e.eventType === "merge.conflict.irreconcilable")).toBe(false);
  });
});
