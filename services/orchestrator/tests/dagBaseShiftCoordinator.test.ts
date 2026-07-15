import { describe, expect, it } from "vitest";
import {
  decideSettle,
  type PercolationDecision,
  type SpeculativeDependent,
} from "../src/engine/contracts/changePercolation.js";
import type { IntegrationNode } from "../src/engine/contracts/integrationNodes.js";
import type { AncestorStack } from "../src/engine/dag/ancestorStack.js";
import type { RebaseResult, RecordedConflict, WorkspaceVcsCore } from "../src/engine/contracts/workspaceVcsCore.js";
import { IntegrationRebasePayload } from "../src/engine/events/schemas/dag.js";
import {
  BaseShiftCoordinator,
  BaseShiftHeldError,
  type BaseShiftConflictResolver,
  type BaseShiftEventEmitter,
  type BaseShiftGateReworkRouter,
  type BaseShiftNodeReader,
  type BaseShiftPersistence,
  type BaseShiftReGate,
  type BaseShiftWorkspaceOpener,
  type ConflictResolution,
  type RebaseDecision,
  type ReGateResult,
  type ReGateVerdict,
} from "../src/engine/dag/baseShiftCoordinator.js";

const PROJECT = "project_base_shift";
const DEP_RUN = "run_dependent_keep_me";
const DEP_BRANCH = "tanren/run_dependent";

function dependent(over: Partial<SpeculativeDependent> = {}): SpeculativeDependent {
  return {
    specId: "spec_b",
    runId: DEP_RUN,
    speculativeBase: "tanren/integ/spec_b",
    integratedAncestorShas: { spec_a: "sha-old" },
    verifiedAncestorShas: { spec_a: "sha-old" },
    lifecycleState: "building",
    openFindingMaxSeverity: "unaudited",
    ...over,
  };
}

const DECISION: PercolationDecision = {
  ancestorSpecId: "spec_a",
  promptness: "immediate",
  fromSha: "sha-old",
  toSha: "sha-new",
  immediateSeverity: "P0",
};

/** A jj `WorkspaceVcsCore` fake recording `rebaseOnto` + `resolveConflict` invocations. */
class RecordingWorkspaceCore implements WorkspaceVcsCore {
  readonly rebaseCalls: Array<{ branch: string; baseSha: string }> = [];
  readonly resolveCalls: Array<{ branch: string; conflictId: string }> = [];
  constructor(private readonly conflictOnRebase: boolean) {}

  async openWorkspace(): Promise<{ workspaceId: string; path: string }> {
    return { workspaceId: "ws_1", path: "/scratch/ws_1" };
  }
  async branch(): Promise<void> {}
  async checkout(): Promise<void> {}
  async commit(): Promise<{ headSha: string }> {
    return { headSha: "sha-commit" };
  }
  async rebaseOnto(_ws: { workspaceId: string }, branch: string, baseSha: string): Promise<RebaseResult> {
    this.rebaseCalls.push({ branch, baseSha });
    if (this.conflictOnRebase) {
      const conflict: RecordedConflict = {
        conflictId: "cfl_1",
        between: { specId: branch, otherSpecId: "base" },
        paths: ["src/x.ts"],
      };
      return { outcome: "conflicted", headSha: "sha-rebased-conflicted", conflict };
    }
    return { outcome: "clean", headSha: "sha-rebased-clean" };
  }
  async resolveConflict(input: { branch: string; conflictId: string }): Promise<{ headSha: string }> {
    this.resolveCalls.push({ branch: input.branch, conflictId: input.conflictId });
    return { headSha: "sha-resolved" };
  }
  async restackDescendants(): Promise<{ restacked: never[]; stillConflicted: never[] }> {
    return { restacked: [], stillConflicted: [] };
  }
  async exportCleanGitRef(): Promise<{ ref: string; headSha: string }> {
    return { ref: "refs/heads/x", headSha: "sha-export" };
  }
  async opUndo(): Promise<void> {}
}

class RecordingOpener implements BaseShiftWorkspaceOpener {
  readonly calls: Array<{
    runId: string;
    nonSpeculative: boolean;
    ancestorStack: AncestorStack | undefined;
  }> = [];
  async open(input: {
    dependent: SpeculativeDependent;
    nonSpeculative: boolean;
    ancestorStack?: AncestorStack;
  }): Promise<{ workspaceId: string; path: string; branch: string; newBaseSha: string }> {
    this.calls.push({
      runId: input.dependent.runId,
      nonSpeculative: input.nonSpeculative,
      ancestorStack: input.ancestorStack,
    });
    return { workspaceId: "ws_1", path: "/scratch/ws_1", branch: DEP_BRANCH, newBaseSha: "sha-new-base" };
  }
}

type ScriptedReGate = BaseShiftReGate & { calls: number };
function scriptedReGate(verdict: ReGateVerdict, gateError?: string): ScriptedReGate {
  const fake: ScriptedReGate = {
    calls: 0,
    async reGate(): Promise<ReGateResult> {
      fake.calls += 1;
      return { verdict, ...(gateError !== undefined && { gateError }) };
    },
  };
  return fake;
}

/** Records EXACTLY which clean-rebase GATE-tier failures routed to WRITER REWORK (the fix). */
type RecordingGateRework = BaseShiftGateReworkRouter & {
  calls: Array<{ specId: string; runId: string; gateError: string }>;
};
function recordingGateRework(): RecordingGateRework {
  const calls: Array<{ specId: string; runId: string; gateError: string }> = [];
  return {
    calls,
    async routeGateFailToRework(input) {
      calls.push({ specId: input.specId, runId: input.runId, gateError: input.gateError });
      return {
        kind: "owned",
        receipt: {
          kind: "writer_rework",
          specId: input.specId,
          run: { kind: "enqueued", replanRunId: "run_rework", plannerTaskId: "task_rework" },
        },
      };
    },
  };
}

type ScriptedResolver = BaseShiftConflictResolver & { calls: number };
function scriptedResolver(resolution: ConflictResolution): ScriptedResolver {
  const fake: ScriptedResolver = {
    calls: 0,
    async resolve(): Promise<ConflictResolution> {
      fake.calls += 1;
      return resolution;
    },
  };
  return fake;
}

type RecordingNodeReader = BaseShiftNodeReader & { calls: number };
function recordingNodeReader(): RecordingNodeReader {
  const fake: RecordingNodeReader = {
    calls: 0,
    async nodesForDependent(): Promise<IntegrationNode[]> {
      fake.calls += 1;
      return [];
    },
  };
  return fake;
}

/** Records EXACTLY which keep-run-row / replan writes ran — the never-discard assertions. */
class RecordingPersistence implements BaseShiftPersistence {
  readonly repointStacks: Array<{ runId: string; ancestorStack: AncestorStack }> = [];
  readonly markedInFlight: Array<{ runId: string; ancestorSpecId: string; toSha: string }> = [];
  readonly replanned: Array<{ runId: string; specId: string; reason: string }> = [];
  async repointBase(input: { runId: string; ancestorStack: AncestorStack }): Promise<void> {
    this.repointStacks.push({ runId: input.runId, ancestorStack: input.ancestorStack });
  }
  async markInFlight(input: { runId: string; pending: { ancestorSpecId: string; toSha: string } }): Promise<void> {
    this.markedInFlight.push({
      runId: input.runId,
      ancestorSpecId: input.pending.ancestorSpecId,
      toSha: input.pending.toSha,
    });
  }
  async recordReplan(input: { runId: string; specId: string; reason: string }): Promise<void> {
    this.replanned.push({ runId: input.runId, specId: input.specId, reason: input.reason });
  }
}

class RecordingEventEmitter implements BaseShiftEventEmitter {
  readonly events: Array<{ runId: string; decision: RebaseDecision; rebaseConflicted: boolean; sameRunId: true }> = [];
  readonly rawEvents: Array<Record<string, unknown>> = [];
  async emitRebase(input: {
    specId: string;
    runId: string;
    branch: string;
    newBaseSha: string;
    headSha: string;
    rebaseConflicted: boolean;
    decision: RebaseDecision;
  }): Promise<void> {
    this.events.push({
      runId: input.runId,
      decision: input.decision,
      rebaseConflicted: input.rebaseConflicted,
      sameRunId: true,
    });
    this.rawEvents.push({
      specId: input.specId,
      runId: input.runId,
      sameRunId: true,
      branch: input.branch,
      newBaseSha: input.newBaseSha,
      headSha: input.headSha,
      rebaseConflicted: input.rebaseConflicted,
      decision: input.decision,
    });
  }
}

interface Harness {
  coord: BaseShiftCoordinator;
  workspace: RecordingWorkspaceCore;
  opener: RecordingOpener;
  reGate: ScriptedReGate;
  resolver: ScriptedResolver;
  persistence: RecordingPersistence;
  nodes: RecordingNodeReader;
  events: RecordingEventEmitter;
  gateRework: RecordingGateRework;
}

function harness(opts: {
  conflictOnRebase?: boolean;
  reGate?: ReGateVerdict;
  reGateError?: string;
  resolution?: ConflictResolution;
}): Harness {
  const workspace = new RecordingWorkspaceCore(opts.conflictOnRebase ?? false);
  const opener = new RecordingOpener();
  const reGate = scriptedReGate(opts.reGate ?? "passed", opts.reGateError);
  const resolver = scriptedResolver(opts.resolution ?? { resolved: true, headSha: "sha-resolved" });
  const persistence = new RecordingPersistence();
  const nodes = recordingNodeReader();
  const events = new RecordingEventEmitter();
  const gateRework = recordingGateRework();
  const coord = new BaseShiftCoordinator({
    workspace,
    opener,
    reGate,
    resolver,
    persistence,
    nodes,
    events,
    gateRework,
  });
  return { coord, workspace, opener, reGate, resolver, persistence, nodes, events, gateRework };
}

const DEFAULT_STACK: AncestorStack = [
  { specId: "spec_a", runId: "run_a", branch: "tanren/spec_a", headSha: "sha-new" },
];

async function reexec(h: Harness, over: Partial<Parameters<BaseShiftCoordinator["reexecute"]>[0]> = {}) {
  return h.coord.reexecute({
    projectId: PROJECT,
    dependent: dependent(),
    decision: DECISION,
    ancestorStack: DEFAULT_STACK,
    nonSpeculative: false,
    ...over,
  });
}

describe("BaseShiftCoordinator — never-discard rebase (NOT supersede+regenerate)", () => {
  it("THE PROOF: an ancestor lands ⇒ the dependent's run row is the SAME run_id (rebase, no new run)", async () => {
    const h = harness({ conflictOnRebase: false, reGate: "passed" });
    const result = await reexec(h);

    expect(result.reexecRunId).toBe(DEP_RUN);
    expect(h.workspace.rebaseCalls).toEqual([{ branch: DEP_BRANCH, baseSha: "sha-new-base" }]);
    expect(h.persistence.repointStacks).toEqual([{ runId: DEP_RUN, ancestorStack: DEFAULT_STACK }]);
    expect(h.persistence.markedInFlight).toEqual([{ runId: DEP_RUN, ancestorSpecId: "spec_a", toSha: "sha-new" }]);
    expect(h.persistence.replanned).toEqual([]);
    expect(h.nodes.calls).toBe(1);
  });

  it("a CLEAN rebase + passing re-gate emits integration.rebase `rebased_clean` (the rebase_vs_rebuild signal)", async () => {
    const h = harness({ conflictOnRebase: false, reGate: "passed" });
    await reexec(h);
    expect(h.events.events).toEqual([
      { runId: DEP_RUN, decision: "rebased_clean", rebaseConflicted: false, sameRunId: true },
    ]);
  });

  it("a CONFLICTED rebase RECORDS the jj conflict (work survives) + resolver fits ⇒ KEEP the run, NO re-plan", async () => {
    const h = harness({
      conflictOnRebase: true,
      reGate: "passed",
      resolution: { resolved: true, headSha: "sha-resolved" },
    });
    const result = await reexec(h);

    expect(h.workspace.rebaseCalls).toHaveLength(1);
    expect(h.resolver.calls).toBe(1);
    expect(result.reexecRunId).toBe(DEP_RUN);
    expect(h.persistence.repointStacks).toHaveLength(1);
    expect(h.persistence.replanned).toEqual([]);
    expect(h.events.events).toEqual([
      { runId: DEP_RUN, decision: "rebased_resolved", rebaseConflicted: true, sameRunId: true },
    ]);
  });

  it("a CONFLICTED rebase the resolver says is IRRECONCILABLE ⇒ re-plan (kept ALIVE, same run, NEVER discarded)", async () => {
    const h = harness({ conflictOnRebase: true, resolution: { resolved: false, reason: "intents genuinely collide" } });
    const result = await reexec(h);

    expect(result.reexecRunId).toBe(DEP_RUN);
    expect(h.persistence.replanned).toHaveLength(1);
    expect(h.persistence.replanned[0]?.runId).toBe(DEP_RUN);
    expect(h.persistence.markedInFlight).toEqual([]);
    expect(h.events.events).toEqual([
      { runId: DEP_RUN, decision: "replanned", rebaseConflicted: true, sameRunId: true },
    ]);
  });

  it("a CLEAN rebase whose re-gate FAILS a GATE TIER ⇒ WRITER REWORK (carrying the gate error), NOT replan/irreconcilable", async () => {
    const gateError = "base-shift re-gate failed at tier tier-2: step 'test' (exit 1)";
    const h = harness({ conflictOnRebase: false, reGate: "failed", reGateError: gateError });
    await reexec(h);
    expect(h.gateRework.calls).toEqual([{ specId: "spec_b", runId: DEP_RUN, gateError }]);
    expect(h.persistence.replanned).toEqual([]);
    expect(h.persistence.repointStacks).toEqual([]);
    const event = h.events.rawEvents[0];
    expect(event).toMatchObject({ decision: "writer_rework", rebaseConflicted: false, sameRunId: true });
    expect(() => IntegrationRebasePayload.parse(event)).not.toThrow();
  });

  it("Codex critic #15: a clean-rebase gate-fail ALWAYS routes to writer rework, NEVER to replan (no fallback)", async () => {
    const gateError = "base-shift re-gate failed at tier tier-3: step 'build' (exit 2)";
    const h = harness({ conflictOnRebase: false, reGate: "failed", reGateError: gateError });
    await reexec(h);
    expect(h.gateRework.calls).toEqual([{ specId: "spec_b", runId: DEP_RUN, gateError }]);
    expect(h.persistence.replanned).toEqual([]);
    expect(h.persistence.repointStacks).toEqual([]);
    const event = h.events.rawEvents[0];
    expect(event).toMatchObject({ decision: "writer_rework", rebaseConflicted: false, sameRunId: true });
    expect(() => IntegrationRebasePayload.parse(event)).not.toThrow();
  });

  it("a CONFLICTED rebase whose RESOLVED tree fails a GATE TIER ⇒ WRITER REWORK (clean tree, not irreconcilable)", async () => {
    const gateError = "base-shift re-gate failed at tier tier-1: step 'lint' (exit 1)";
    const h = harness({
      conflictOnRebase: true,
      resolution: { resolved: true, headSha: "sha-resolved" },
      reGate: "failed",
      reGateError: gateError,
    });
    await reexec(h);
    expect(h.gateRework.calls).toEqual([{ specId: "spec_b", runId: DEP_RUN, gateError }]);
    expect(h.persistence.replanned).toEqual([]);
  });

  it("a CONFLICTED rebase whose resolver routed-to-rework (its own GATE re-gate failed) ⇒ NO double-route (no replan)", async () => {
    const h = harness({
      conflictOnRebase: true,
      resolution: {
        resolved: false,
        reason: "re-gate gate-tier fail — routed to rework",
        recovery: {
          kind: "owned",
          receipt: { kind: "writer_rework", specId: "spec_b", run: { kind: "already_running", runId: "run_live" } },
        },
      },
    });
    await reexec(h);
    expect(h.persistence.replanned).toEqual([]);
    expect(h.gateRework.calls).toEqual([]);
    expect(h.events.events).toEqual([
      { runId: DEP_RUN, decision: "writer_rework", rebaseConflicted: true, sameRunId: true },
    ]);
  });

  it("FAIL-CLOSED: a `pending` (inconclusive) re-gate HOLDS — never merges, never discards", async () => {
    const h = harness({ conflictOnRebase: false, reGate: "pending" });
    await expect(reexec(h)).rejects.toBeInstanceOf(BaseShiftHeldError);
    expect(h.persistence.replanned).toEqual([]);
    expect(h.persistence.repointStacks).toEqual([]);
  });

  it("non-speculative (every ancestor merged) re-points the base to an EMPTY stack (a real run against main), same run", async () => {
    const h = harness({ conflictOnRebase: false, reGate: "passed" });
    const result = await reexec(h, { nonSpeculative: true, ancestorStack: [] });
    expect(result.reexecRunId).toBe(DEP_RUN);
    expect(h.persistence.repointStacks).toEqual([{ runId: DEP_RUN, ancestorStack: [] }]);
  });
});

describe("§5-P0 settle fix (tanren-owns-the-engine.md §5) — a changes_requested re-exec NEVER absorbs", () => {
  it("an audited-clean re-exec whose review verdict is changes_requested ⇒ REPLANNED (not absorbed)", () => {
    expect(decideSettle("audited", "none", "changes_requested")).toBe("replanned");
    expect(decideSettle("review", "none", "changes_requested")).toBe("replanned");
  });

  it("an APPROVED verdict does NOT over-block — an audited-clean re-exec still absorbs", () => {
    expect(decideSettle("audited", "none", "approved")).toBe("absorbed");
  });

  it("no verdict (no-review tier) does NOT block absorption on its own", () => {
    expect(decideSettle("audited", "none")).toBe("absorbed");
  });
});

describe("base-shift over the re-resolved ancestor stack", () => {
  it("the re-resolved stack is THREADED to the opener (assembled locally, not a synthesized ref)", async () => {
    const h = harness({ conflictOnRebase: false, reGate: "passed" });
    await reexec(h);
    expect(h.opener.calls).toEqual([
      {
        runId: DEP_RUN,
        nonSpeculative: false,
        ancestorStack: DEFAULT_STACK,
      },
    ]);
    expect(h.workspace.rebaseCalls).toEqual([{ branch: DEP_BRANCH, baseSha: "sha-new-base" }]);
  });

  it("keepRun re-points runs.ancestor_stack to the re-resolved stack (the sole base source)", async () => {
    const h = harness({ conflictOnRebase: false, reGate: "passed" });
    await reexec(h);
    expect(h.persistence.repointStacks).toEqual([{ runId: DEP_RUN, ancestorStack: DEFAULT_STACK }]);
  });

  it("every ancestor merged ⇒ the re-resolved stack is EMPTY (a real run against main)", async () => {
    const h = harness({ conflictOnRebase: false, reGate: "passed" });
    await reexec(h, { nonSpeculative: true, ancestorStack: [] });
    expect(h.opener.calls).toEqual([{ runId: DEP_RUN, nonSpeculative: true, ancestorStack: [] }]);
    expect(h.persistence.repointStacks).toEqual([{ runId: DEP_RUN, ancestorStack: [] }]);
  });
});
