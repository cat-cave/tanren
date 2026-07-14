// Intent-preserving resolver tests: both intents + DAG provenance, verified publish,
// typed replan/rework ownership, fail-closed re-gates, and inspectable events.

import { describe, expect, it } from "vitest";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { buildIntentPreservingConflictResolver } from "../src/engine/workflow/reviewMerge/conflictResolver/resolver.js";
import type {
  ConflictAnswererInvoker,
  ConflictProvenance,
  ConflictProvenanceReader,
  GateReworkRouter,
  GatheredConflict,
  ReGateVerdict,
  ReplanRouter,
  ResolvedTreeReGate,
  SpecIntent,
  WorkspaceConflictApplier,
} from "../src/engine/contracts/conflictResolution.js";
import type { ConflictAnswer } from "../src/engine/answerers/schemas/index.js";
import type { ConflictContext } from "../src/engine/workflow/reviewMerge/index.js";

const MERGING: SpecIntent = {
  specId: "spec_merging",
  title: "Add analytics endpoint",
  description: "Expose per-link click analytics",
  acceptanceCriteria: ["GET /links/:id/analytics returns counts"],
};

const BASE: SpecIntent = {
  specId: "spec_base",
  title: "Add rate limiting",
  description: "Throttle the redirect route",
  acceptanceCriteria: ["redirects are rate-limited"],
};

const CONTEXT: ConflictContext = {
  runId: "run_1",
  prUrl: "https://github.com/o/r/pull/7",
  prNumber: 7,
  baseBranch: "main",
  message: "merge conflict in src/router.ts",
};

function fakeProvenance(p: ConflictProvenance): ConflictProvenanceReader {
  return { read: async () => p };
}

function fakeApplier(
  files: GatheredConflict["files"],
  log: string[],
): WorkspaceConflictApplier & { applied: Array<{ path: string; content: string }> } {
  const applied: Array<{ path: string; content: string }> = [];
  return {
    applied,
    gather: async () => {
      log.push("gather");
      return { files };
    },
    applyResolution: async (resolved) => {
      log.push("apply");
      applied.push(...resolved.map((f) => ({ path: f.path, content: f.content })));
    },
    publishResolved: async () => {
      log.push("publish");
    },
    abort: async () => {
      log.push("abort");
    },
  };
}

function fakeAnswerer(
  answer: ConflictAnswer,
  captured: { input?: Parameters<ConflictAnswererInvoker["resolve"]>[0] },
): ConflictAnswererInvoker {
  return {
    resolve: async (input) => {
      captured.input = input;
      return answer;
    },
  };
}

function fakeReGate(verdict: ReGateVerdict): ResolvedTreeReGate {
  return { reGate: async () => verdict };
}

function recordingReplan(): ReplanRouter & {
  calls: Array<{ specId: string; newContext: string; otherSpecId?: string }>;
} {
  const calls: Array<{ specId: string; newContext: string; otherSpecId?: string }> = [];
  return {
    calls,
    routeBackToPlanner: async (input) => {
      calls.push(input);
      return {
        kind: "owned",
        receipt: { kind: "planner_replan", specId: input.specId, run: { kind: "already_running", runId: "run_live" } },
      };
    },
  };
}

function recordingGateRework(): GateReworkRouter & { calls: Array<{ specId: string; gateError: string }> } {
  const calls: Array<{ specId: string; gateError: string }> = [];
  return {
    calls,
    routeGateFailToRework: async (input) => {
      calls.push(input);
      return {
        kind: "owned",
        receipt: { kind: "writer_rework", specId: input.specId, run: { kind: "already_running", runId: "run_live" } },
      };
    },
  };
}

const conflictedFiles: GatheredConflict["files"] = [
  { path: "src/router.ts", conflictedContent: "<<<<<<< HEAD\nanalytics\n=======\nratelimit\n>>>>>>> base\n" },
];

describe("intentPreservingConflictResolver", () => {
  it("resolves a two-spec conflict, re-gates clean, and publishes → merge proceeds", async () => {
    const events = new FakeEventStore();
    const log: string[] = [];
    const applier = fakeApplier(conflictedFiles, log);
    const captured: { input?: Parameters<ConflictAnswererInvoker["resolve"]>[0] } = {};
    const replan = recordingReplan();

    const resolver = buildIntentPreservingConflictResolver({
      projectId: "proj_1",
      mergingSpecIntent: MERGING,
      eventStore: events,
      provenance: fakeProvenance({ conflictingSpecId: BASE.specId, conflictingSpecIntent: BASE, dagEdge: true }),
      applier,
      answerer: fakeAnswerer(
        {
          decision: "resolve",
          reasoning: "kept analytics AND ratelimit",
          resolvedFiles: [{ path: "src/router.ts", content: "analytics + ratelimit\n" }],
          replanSpec: null,
        },
        captured,
      ),
      reGate: fakeReGate({ passed: true, reason: "green" }),
      replan,
    });

    const result = await resolver(CONTEXT);

    expect(result.resolved).toBe(true);
    // The Answerer saw BOTH intents + the DAG edge.
    expect(captured.input?.mergingSpecIntent.specId).toBe("spec_merging");
    expect(captured.input?.conflictingSpecIntent?.specId).toBe("spec_base");
    expect(captured.input?.dagEdge).toBe(true);
    // The resolution was applied + published; nothing routed back to the planner.
    expect(log).toEqual(["gather", "apply", "publish"]);
    expect(applier.applied).toEqual([{ path: "src/router.ts", content: "analytics + ratelimit\n" }]);
    expect(replan.calls).toHaveLength(0);
    // Events: resolving → resolved (no irreconcilable).
    const names = events.events.map((e) => e.eventType);
    expect(names).toContain("merge.conflict.resolving");
    expect(names).toContain("merge.conflict.resolved");
    expect(names).not.toContain("merge.conflict.irreconcilable");
    const resolving = events.events.find((e) => e.eventType === "merge.conflict.resolving");
    expect(resolving?.payload).toMatchObject({ conflictingSpecId: "spec_base", dagEdge: true });
  });

  it("§4: short-circuits an EMPTY gather BEFORE the model call (no wasted resolve, recoverable)", async () => {
    const events = new FakeEventStore();
    const log: string[] = [];
    // gather() surfaces NO conflicted files.
    const applier = fakeApplier([], log);
    const captured: { input?: Parameters<ConflictAnswererInvoker["resolve"]>[0] } = {};
    const replan = recordingReplan();

    const resolver = buildIntentPreservingConflictResolver({
      projectId: "proj_1",
      mergingSpecIntent: MERGING,
      eventStore: events,
      provenance: fakeProvenance({ conflictingSpecId: BASE.specId, conflictingSpecIntent: BASE, dagEdge: true }),
      applier,
      answerer: fakeAnswerer(
        { decision: "resolve", reasoning: "should NEVER run", resolvedFiles: [], replanSpec: null },
        captured,
      ),
      reGate: fakeReGate({ passed: true, reason: "unused" }),
      replan,
    });

    const result = await resolver(CONTEXT);

    // Recoverable conflict (intent stays alive) — but NO model call was made.
    expect(result.resolved).toBe(false);
    expect(captured.input).toBeUndefined();
    // Only gather ran — no apply/publish/abort, no replan, no resolving/resolved events.
    expect(log).toEqual(["gather"]);
    expect(replan.calls).toHaveLength(0);
    const names = events.events.map((e) => e.eventType);
    expect(names).not.toContain("merge.conflict.resolving");
    expect(names).not.toContain("merge.conflict.resolved");
    expect(names).not.toContain("merge.conflict.irreconcilable");
  });

  it("routes a spec back to the planner on an irreconcilable verdict (not dropped, not merged)", async () => {
    const events = new FakeEventStore();
    const log: string[] = [];
    const applier = fakeApplier(conflictedFiles, log);
    const replan = recordingReplan();

    const resolver = buildIntentPreservingConflictResolver({
      projectId: "proj_1",
      mergingSpecIntent: MERGING,
      eventStore: events,
      provenance: fakeProvenance({ conflictingSpecId: BASE.specId, conflictingSpecIntent: BASE, dagEdge: true }),
      applier,
      answerer: fakeAnswerer(
        {
          decision: "irreconcilable",
          reasoning: "the two route definitions cannot coexist",
          resolvedFiles: [],
          replanSpec: { which: "merging", newContext: "rate limiting now wraps the redirect route" },
        },
        {},
      ),
      reGate: fakeReGate({ passed: true, reason: "unused" }),
      replan,
    });

    const result = await resolver(CONTEXT);

    expect(result.resolved).toBe(false);
    // The merging spec was routed back to the planner WITH the base's change as
    // context — intent stays alive. Nothing was applied/published/merged.
    expect(replan.calls).toEqual([expect.objectContaining({ specId: "spec_merging", otherSpecId: "spec_base" })]);
    expect(replan.calls[0]?.newContext).toContain("rate limiting");
    expect(log).toEqual(["gather", "abort"]);
    const irreconcilable = events.events.find((e) => e.eventType === "merge.conflict.irreconcilable");
    expect(irreconcilable?.payload).toMatchObject({
      replanned: "merging",
      replannedSpecId: "spec_merging",
      fromFailedReGate: false,
    });
    expect(events.events.some((e) => e.eventType === "merge.conflict.resolved")).toBe(false);
  });

  it("does NOT merge when the re-gate of an applied resolution FAILS (routes back instead)", async () => {
    const events = new FakeEventStore();
    const log: string[] = [];
    const applier = fakeApplier(conflictedFiles, log);
    const replan = recordingReplan();

    const resolver = buildIntentPreservingConflictResolver({
      projectId: "proj_1",
      mergingSpecIntent: MERGING,
      eventStore: events,
      provenance: fakeProvenance({ conflictingSpecId: BASE.specId, conflictingSpecIntent: BASE, dagEdge: true }),
      applier,
      answerer: fakeAnswerer(
        {
          decision: "resolve",
          reasoning: "tried to merge both",
          resolvedFiles: [{ path: "src/router.ts", content: "broken\n" }],
          replanSpec: null,
        },
        {},
      ),
      // The resolution applies but the re-gate's checker rejects it.
      reGate: fakeReGate({ passed: false, failedStage: "checker", reason: "analytics endpoint missing" }),
      replan,
    });

    const result = await resolver(CONTEXT);

    expect(result.resolved).toBe(false);
    // Applied, but NEVER published (no merge on an unverified tree); aborted.
    expect(log).toEqual(["gather", "apply", "abort"]);
    expect(log).not.toContain("publish");
    // Routed back to the planner; the event marks the failed re-gate provenance.
    expect(replan.calls).toEqual([expect.objectContaining({ specId: "spec_merging" })]);
    const irreconcilable = events.events.find((e) => e.eventType === "merge.conflict.irreconcilable");
    const payload = irreconcilable?.payload as { fromFailedReGate: boolean; reason: string } | undefined;
    expect(payload?.fromFailedReGate).toBe(true);
    expect(payload?.reason).toContain("re-gate failed (checker)");
    expect(events.events.some((e) => e.eventType === "merge.conflict.resolved")).toBe(false);
  });

  it("routes a GATE-TIER re-gate failure to WRITER REWORK (NOT merge.conflict.irreconcilable / replan)", async () => {
    // THE FIX: the resolution applied to a byte-CLEAN tree (no merge conflict), but the re-gate fails
    // a deterministic GATE TIER on the new base — the WRITER's to fix. Route to WRITER REWORK carrying
    // the gate error, NOT an IRRECONCILABLE CONFLICT (no `merge.conflict.irreconcilable`) and NOT a
    // replan; it carries a typed writer receipt so a base-shift caller does not double-route.
    const events = new FakeEventStore();
    const log: string[] = [];
    const applier = fakeApplier(conflictedFiles, log);
    const replan = recordingReplan();
    const gateRework = recordingGateRework();

    const resolver = buildIntentPreservingConflictResolver({
      projectId: "proj_1",
      mergingSpecIntent: MERGING,
      eventStore: events,
      provenance: fakeProvenance({ conflictingSpecId: BASE.specId, conflictingSpecIntent: BASE, dagEdge: true }),
      applier,
      answerer: fakeAnswerer(
        {
          decision: "resolve",
          reasoning: "merged both",
          resolvedFiles: [{ path: "src/router.ts", content: "analytics + ratelimit\n" }],
          replanSpec: null,
        },
        {},
      ),
      // The resolved tree is clean but a GATE TIER fails on the new base.
      reGate: fakeReGate({ passed: false, failedStage: "gate", reason: "gate failed at tier tier-2: step 'test'" }),
      replan,
      gateRework,
    });
    const result = await resolver(CONTEXT);
    if (result.resolved) throw new Error("expected unresolved result");
    expect(result.recovery).toMatchObject({ kind: "owned", receipt: { kind: "writer_rework" } });
    // Applied, NEVER published (no merge on an unverified tree); aborted.
    expect(log).toEqual(["gather", "apply", "abort"]);
    expect(log).not.toContain("publish");
    // Routed to WRITER REWORK with the real gate error — NOT to replan, NOT irreconcilable.
    expect(gateRework.calls).toEqual([
      { specId: "spec_merging", gateError: "re-gate failed (gate): gate failed at tier tier-2: step 'test'" },
    ]);
    expect(replan.calls).toHaveLength(0);
    const names = events.events.map((e) => e.eventType);
    expect(names).not.toContain("merge.conflict.irreconcilable");
    expect(names).not.toContain("merge.conflict.resolved");
  });

  it("a CHECKER re-gate rejection STILL routes to replan / irreconcilable (a genuine does-not-fit, not a gate-fail)", async () => {
    // GUARDRAIL: a checker/auditor rejection of the resolved tree is a genuine "does not satisfy the
    // spec" verdict — it STAYS on the replan / irreconcilable path even with a gate-rework router
    // wired. Only a deterministic GATE-TIER failure reroutes.
    const events = new FakeEventStore();
    const log: string[] = [];
    const applier = fakeApplier(conflictedFiles, log);
    const replan = recordingReplan();
    const gateRework = recordingGateRework();

    const resolver = buildIntentPreservingConflictResolver({
      projectId: "proj_1",
      mergingSpecIntent: MERGING,
      eventStore: events,
      provenance: fakeProvenance({ conflictingSpecId: BASE.specId, conflictingSpecIntent: BASE, dagEdge: true }),
      applier,
      answerer: fakeAnswerer(
        {
          decision: "resolve",
          reasoning: "tried to merge both",
          resolvedFiles: [{ path: "src/router.ts", content: "broken\n" }],
          replanSpec: null,
        },
        {},
      ),
      reGate: fakeReGate({ passed: false, failedStage: "checker", reason: "analytics endpoint missing" }),
      replan,
      gateRework,
    });
    const result = await resolver(CONTEXT);
    if (result.resolved) throw new Error("expected unresolved result");
    expect(result.recovery).toMatchObject({ kind: "owned", receipt: { kind: "planner_replan" } });
    // The gate-rework router is NOT engaged; the replan / irreconcilable path runs as before.
    expect(gateRework.calls).toHaveLength(0);
    expect(replan.calls).toEqual([expect.objectContaining({ specId: "spec_merging" })]);
    const irreconcilable = events.events.find((e) => e.eventType === "merge.conflict.irreconcilable");
    const payload = irreconcilable?.payload as { fromFailedReGate: boolean; reason: string } | undefined;
    expect(payload?.fromFailedReGate).toBe(true);
    expect(payload?.reason).toContain("re-gate failed (checker)");
  });

  it("routes invalid conflict answers back through replan instead of throwing as infra", async () => {
    const events = new FakeEventStore();
    const log: string[] = [];
    const applier = fakeApplier(conflictedFiles, log);
    const replan = recordingReplan();

    const resolver = buildIntentPreservingConflictResolver({
      projectId: "proj_1",
      mergingSpecIntent: MERGING,
      eventStore: events,
      provenance: fakeProvenance({ conflictingSpecId: BASE.specId, conflictingSpecIntent: BASE, dagEdge: true }),
      applier,
      answerer: fakeAnswerer(
        {
          decision: "resolve",
          reasoning: "resolved it",
          resolvedFiles: [],
          replanSpec: null,
        },
        {},
      ),
      reGate: fakeReGate({ passed: true, reason: "unused" }),
      replan,
    });

    const result = await resolver(CONTEXT);

    expect(result.resolved).toBe(false);
    expect(log).toEqual(["gather", "abort"]);
    expect(log).not.toContain("apply");
    expect(log).not.toContain("publish");
    expect(replan.calls).toEqual([expect.objectContaining({ specId: "spec_merging", otherSpecId: "spec_base" })]);
    expect(replan.calls[0]?.newContext).toContain(
      "conflict answer invalid: decision 'resolve' must carry at least one resolved file",
    );
    const irreconcilable = events.events.find((e) => e.eventType === "merge.conflict.irreconcilable");
    expect(irreconcilable?.payload).toMatchObject({
      replanned: "merging",
      replannedSpecId: "spec_merging",
      fromFailedReGate: false,
      reason: "conflict answer invalid: decision 'resolve' must carry at least one resolved file",
    });
    expect(events.events.some((e) => e.eventType === "merge.conflict.resolved")).toBe(false);
  });

  it("proceeds with the merging spec's intent alone when no other spec is attributed", async () => {
    const events = new FakeEventStore();
    const log: string[] = [];
    const applier = fakeApplier(conflictedFiles, log);
    const captured: { input?: Parameters<ConflictAnswererInvoker["resolve"]>[0] } = {};

    const resolver = buildIntentPreservingConflictResolver({
      projectId: "proj_1",
      mergingSpecIntent: MERGING,
      eventStore: events,
      // No conflicting spec attributed (conflict against un-attributed base history).
      provenance: fakeProvenance({ dagEdge: false }),
      applier,
      answerer: fakeAnswerer(
        {
          decision: "resolve",
          reasoning: "rebased on base history",
          resolvedFiles: [{ path: "src/router.ts", content: "resolved\n" }],
          replanSpec: null,
        },
        captured,
      ),
      reGate: fakeReGate({ passed: true, reason: "green" }),
      replan: recordingReplan(),
    });

    const result = await resolver(CONTEXT);

    expect(result.resolved).toBe(true);
    expect(captured.input?.conflictingSpecIntent).toBeUndefined();
    expect(captured.input?.dagEdge).toBe(false);
    const resolving = events.events.find((e) => e.eventType === "merge.conflict.resolving");
    expect(resolving?.payload).not.toHaveProperty("conflictingSpecId");
    expect(resolving?.payload).toMatchObject({ dagEdge: false });
  });

  it("P2c-2: a percolation re-execution threads the UPSTREAM-CHANGE context to the answerer", async () => {
    // When `upstreamChange` is set (a change-percolation re-execution), the resolver
    // runs in upstream-change mode — the ancestor's change flows INTO this spec.
    const events = new FakeEventStore();
    const log: string[] = [];
    const applier = fakeApplier(conflictedFiles, log);
    const captured: { input?: Parameters<ConflictAnswererInvoker["resolve"]>[0] } = {};

    const resolver = buildIntentPreservingConflictResolver({
      projectId: "proj_1",
      mergingSpecIntent: MERGING,
      eventStore: events,
      provenance: fakeProvenance({ conflictingSpecId: BASE.specId, conflictingSpecIntent: BASE, dagEdge: true }),
      applier,
      answerer: fakeAnswerer(
        {
          decision: "resolve",
          reasoning: "absorbed the ancestor change, kept this spec's work",
          resolvedFiles: [{ path: "src/router.ts", content: "ancestor + dependent\n" }],
          replanSpec: null,
        },
        captured,
      ),
      reGate: fakeReGate({ passed: true, reason: "green" }),
      replan: recordingReplan(),
      upstreamChange: { ancestorSpecId: "spec_base", changeSummary: "the reviewer reworked the rate limiter" },
    });

    const result = await resolver(CONTEXT);

    expect(result.resolved).toBe(true);
    // The upstream-change framing reached the answerer (now-reachable in production).
    expect(captured.input?.upstreamChange).toEqual({
      ancestorSpecId: "spec_base",
      changeSummary: "the reviewer reworked the rate limiter",
    });
  });
});
