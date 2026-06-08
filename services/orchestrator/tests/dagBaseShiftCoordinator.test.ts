// THE NEVER-DISCARD KEYSTONE PROOF (tanren-owns-the-engine.md §3/§7): the
// BaseShiftCoordinator REBASES the dependent's existing run/branch in place via the jj
// `WorkspaceVcsCore` and re-plans ONLY when the resolver + re-gate say the old work no
// longer fits — it NEVER supersede+regenerates (the deleted `PgPercolationReexecutor`).
// Driven through in-memory seams (TEST FIXTURES — they live here, never src/). Proves:
//   (1) rebase-not-regenerate: an ancestor lands → the dependent's run row is the SAME
//       run_id (the `reexecRunId` IS the dependent's own run id, NOT a new run), its
//       branch was rebased (`rebaseOnto` invoked on the jj core), NO new run was
//       created, and re-plan was NOT invoked on a clean rebase + passing re-gate;
//   (2) a conflicted rebase RECORDS the jj conflict (the work survives) and re-plans
//       ONLY when the resolver says it no longer fits;
//   (3) `integration.rebase` / `rebase_vs_rebuild` instrumentation is emitted;
//   (4) fail-closed: an unresolvable re-gate HOLDS (never merges, never discards).

import { describe, expect, it } from "vitest";
import {
  decideSettle,
  type PercolationDecision,
  type SpeculativeDependent,
} from "../src/engine/contracts/changePercolation.js";
import type { IntegrationNode } from "../src/engine/contracts/integrationNodes.js";
import type { RebaseResult, RecordedConflict, WorkspaceVcsCore } from "../src/engine/contracts/workspaceVcsCore.js";
import {
  BaseShiftCoordinator,
  BaseShiftHeldError,
  type BaseShiftConflictResolver,
  type BaseShiftEventEmitter,
  type BaseShiftNodeReader,
  type BaseShiftPersistence,
  type BaseShiftReGate,
  type BaseShiftWorkspaceOpener,
  type ConflictResolution,
  type RebaseDecision,
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

// ---- In-memory seams (fixtures) -------------------------------------------

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
      // jj: a conflicting rebase SUCCEEDS + records the conflict IN the commit.
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
  readonly calls: Array<{ runId: string; newBaseRef: string; nonSpeculative: boolean }> = [];
  async open(input: {
    dependent: SpeculativeDependent;
    newBaseRef: string;
    nonSpeculative: boolean;
  }): Promise<{ workspaceId: string; path: string; branch: string; newBaseSha: string }> {
    this.calls.push({
      runId: input.dependent.runId,
      newBaseRef: input.newBaseRef,
      nonSpeculative: input.nonSpeculative,
    });
    return { workspaceId: "ws_1", path: "/scratch/ws_1", branch: DEP_BRANCH, newBaseSha: "sha-new-base" };
  }
}

// Counter-bearing seam fakes built as factories (not classes — the file's class budget
// is reserved for the richer recording fakes below).
type ScriptedReGate = BaseShiftReGate & { calls: number };
function scriptedReGate(verdict: ReGateVerdict): ScriptedReGate {
  const fake: ScriptedReGate = {
    calls: 0,
    async reGate(): Promise<ReGateVerdict> {
      fake.calls += 1;
      return verdict;
    },
  };
  return fake;
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
  readonly repointCalls: Array<{ runId: string; speculativeBase: string | null }> = [];
  readonly markedInFlight: Array<{ runId: string; ancestorSpecId: string; toSha: string }> = [];
  readonly replanned: Array<{ runId: string; specId: string; reason: string }> = [];
  async repointBase(input: { runId: string; speculativeBase: string | null }): Promise<void> {
    this.repointCalls.push({ runId: input.runId, speculativeBase: input.speculativeBase });
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
  async emitRebase(input: { runId: string; rebaseConflicted: boolean; decision: RebaseDecision }): Promise<void> {
    this.events.push({
      runId: input.runId,
      decision: input.decision,
      rebaseConflicted: input.rebaseConflicted,
      sameRunId: true,
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
}

function harness(opts: {
  conflictOnRebase?: boolean;
  reGate?: ReGateVerdict;
  resolution?: ConflictResolution;
}): Harness {
  const workspace = new RecordingWorkspaceCore(opts.conflictOnRebase ?? false);
  const opener = new RecordingOpener();
  const reGate = scriptedReGate(opts.reGate ?? "passed");
  const resolver = scriptedResolver(opts.resolution ?? { resolved: true, headSha: "sha-resolved" });
  const persistence = new RecordingPersistence();
  const nodes = recordingNodeReader();
  const events = new RecordingEventEmitter();
  const coord = new BaseShiftCoordinator({ workspace, opener, reGate, resolver, persistence, nodes, events });
  return { coord, workspace, opener, reGate, resolver, persistence, nodes, events };
}

async function reexec(h: Harness, over: Partial<Parameters<BaseShiftCoordinator["reexecute"]>[0]> = {}) {
  return h.coord.reexecute({
    projectId: PROJECT,
    dependent: dependent(),
    decision: DECISION,
    integrationBranch: "tanren/integ/spec_b",
    ancestorHeadShas: { spec_a: "sha-new" },
    nonSpeculative: false,
    ...over,
  });
}

describe("BaseShiftCoordinator — never-discard rebase (NOT supersede+regenerate)", () => {
  it("THE PROOF: an ancestor lands ⇒ the dependent's run row is the SAME run_id (rebase, no new run)", async () => {
    const h = harness({ conflictOnRebase: false, reGate: "passed" });
    const result = await reexec(h);

    // (1) NEVER-DISCARD: the re-exec run id IS the dependent's OWN run id — not a new run.
    expect(result.reexecRunId).toBe(DEP_RUN);
    // (1) the branch was REBASED on the jj core (rebaseOnto invoked) — never a fresh clone.
    expect(h.workspace.rebaseCalls).toEqual([{ branch: DEP_BRANCH, baseSha: "sha-new-base" }]);
    // (1) the run row was KEPT: re-pointed + marked in-flight pointing at the SAME run.
    expect(h.persistence.repointCalls).toEqual([{ runId: DEP_RUN, speculativeBase: "tanren/integ/spec_b" }]);
    expect(h.persistence.markedInFlight).toEqual([{ runId: DEP_RUN, ancestorSpecId: "spec_a", toSha: "sha-new" }]);
    // (1) re-plan was NOT invoked on a clean rebase + passing re-gate (tokens REUSED).
    expect(h.persistence.replanned).toEqual([]);
    // S0: the affected integration_nodes were consulted (observe-only).
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

    // The conflicting rebase SUCCEEDED + recorded the conflict (the work was not discarded).
    expect(h.workspace.rebaseCalls).toHaveLength(1);
    expect(h.resolver.calls).toBe(1);
    // The resolved tree fit (re-gate passed) ⇒ KEEP the run (same run id), NO re-plan.
    expect(result.reexecRunId).toBe(DEP_RUN);
    expect(h.persistence.repointCalls).toHaveLength(1);
    expect(h.persistence.replanned).toEqual([]);
    expect(h.events.events).toEqual([
      { runId: DEP_RUN, decision: "rebased_resolved", rebaseConflicted: true, sameRunId: true },
    ]);
  });

  it("a CONFLICTED rebase the resolver says is IRRECONCILABLE ⇒ re-plan (kept ALIVE, same run, NEVER discarded)", async () => {
    const h = harness({ conflictOnRebase: true, resolution: { resolved: false, reason: "intents genuinely collide" } });
    const result = await reexec(h);

    // Still the SAME run row — re-plan keeps the work alive on it, never a new run.
    expect(result.reexecRunId).toBe(DEP_RUN);
    expect(h.persistence.replanned).toHaveLength(1);
    expect(h.persistence.replanned[0]?.runId).toBe(DEP_RUN);
    // Never absorbed/kept-clean on an irreconcilable conflict.
    expect(h.persistence.markedInFlight).toEqual([]);
    expect(h.events.events).toEqual([
      { runId: DEP_RUN, decision: "replanned", rebaseConflicted: true, sameRunId: true },
    ]);
  });

  it("a CLEAN rebase whose re-gate FAILED ⇒ re-plan (the work no longer fits the shifted base)", async () => {
    const h = harness({ conflictOnRebase: false, reGate: "failed" });
    await reexec(h);
    expect(h.persistence.replanned).toHaveLength(1);
    expect(h.persistence.repointCalls).toEqual([]);
    expect(h.events.events[0]?.decision).toBe("replanned");
  });

  it("FAIL-CLOSED: a `pending` (inconclusive) re-gate HOLDS — never merges, never discards", async () => {
    const h = harness({ conflictOnRebase: false, reGate: "pending" });
    await expect(reexec(h)).rejects.toBeInstanceOf(BaseShiftHeldError);
    // The work survives: no replan write, no keep-run write — just a loud hold.
    expect(h.persistence.replanned).toEqual([]);
    expect(h.persistence.repointCalls).toEqual([]);
  });

  it("non-speculative (every ancestor merged) re-points the base to NULL (a real run against main), same run", async () => {
    const h = harness({ conflictOnRebase: false, reGate: "passed" });
    const result = await reexec(h, { nonSpeculative: true });
    expect(result.reexecRunId).toBe(DEP_RUN);
    expect(h.persistence.repointCalls).toEqual([{ runId: DEP_RUN, speculativeBase: null }]);
  });
});

describe("§5-P0 settle fix (tanren-owns-the-engine.md §5) — a changes_requested re-exec NEVER absorbs", () => {
  // The S1-plumbed review verdict is a FIRST-CLASS settle input: a `changes_requested`
  // re-exec must NOT advance the termination key / unblock the merge, even audited-clean.
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
