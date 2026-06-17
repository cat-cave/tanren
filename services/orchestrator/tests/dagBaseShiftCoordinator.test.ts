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
  readonly calls: Array<{
    runId: string;
    nonSpeculative: boolean;
    // §2.2: the re-resolved ancestor stack the coordinator threads to the opener (the value
    // the live-jj-local opener assembles `main + ordered ancestors` from).
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

// Counter-bearing seam fakes built as factories (not classes — the file's class budget
// is reserved for the richer recording fakes below).
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
  // jj-local: the re-point writes ONLY the re-resolved ancestor stack (the legacy
  // `speculative_base` column was dropped in WS-B PR-12 — never carried on the port).
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
  // The FULL emitted payload (the never-discard `sameRunId: true` mirror the production
  // `appendIntegrationRebaseEvent` builds) — for asserting contract-validity.
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
  /** Omit the gate-rework router to exercise the degenerate replan fallback (legacy conformance). */
  noGateRework?: boolean;
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
    ...(opts.noGateRework === true ? {} : { gateRework }),
  });
  return { coord, workspace, opener, reGate, resolver, persistence, nodes, events, gateRework };
}

// The default re-resolved ancestor stack the kick-off threads (one unmerged ancestor,
// spec_a, at its NEW head — the real PR-head branch + run id the stack resolver supplies).
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

    // (1) NEVER-DISCARD: the re-exec run id IS the dependent's OWN run id — not a new run.
    expect(result.reexecRunId).toBe(DEP_RUN);
    // (1) the branch was REBASED on the jj core (rebaseOnto invoked) — never a fresh clone.
    expect(h.workspace.rebaseCalls).toEqual([{ branch: DEP_BRANCH, baseSha: "sha-new-base" }]);
    // (1) the run row was KEPT: re-pointed + marked in-flight pointing at the SAME run. jj-local:
    // there is NO synthesized integration ref, so `runs.ancestor_stack` (the re-resolved stack)
    // is the sole base written.
    expect(h.persistence.repointStacks).toEqual([{ runId: DEP_RUN, ancestorStack: DEFAULT_STACK }]);
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
    expect(h.persistence.repointStacks).toHaveLength(1);
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

  it("a CLEAN rebase whose re-gate FAILS a GATE TIER ⇒ WRITER REWORK (carrying the gate error), NOT replan/irreconcilable", async () => {
    // THE FIX: a clean rebase (jj recorded NO conflict) whose fresh re-gate FAILS a GATE TIER
    // (lint/test/build) on the new base is the WRITER's to fix — route to WRITER REWORK
    // carrying the real gate error as steering, NEVER to replan (the old, mis-classified
    // behavior that conflated a clean-rebase gate-fail with an irreconcilable conflict and
    // stranded the spec). The convergence detector inside the router owns escalation (no count).
    const gateError = "base-shift re-gate failed at tier tier-2: step 'test' (exit 1)";
    const h = harness({ conflictOnRebase: false, reGate: "failed", reGateError: gateError });
    await reexec(h);
    // Routed to WRITER REWORK with the REAL gate error (no_silent_fallback) — NOT replanned.
    expect(h.gateRework.calls).toEqual([{ specId: "spec_b", runId: DEP_RUN, gateError }]);
    expect(h.persistence.replanned).toEqual([]);
    expect(h.persistence.repointStacks).toEqual([]);
    // The categorical decision is still emitted (the rebase WAS clean — rebaseConflicted:false).
    const event = h.events.rawEvents[0];
    expect(event).toMatchObject({ decision: "replanned", rebaseConflicted: false, sameRunId: true });
    expect(() => IntegrationRebasePayload.parse(event)).not.toThrow();
  });

  it("DEGENERATE WIRING (no gate-rework router) ⇒ a clean-rebase gate-fail falls back to replan (never stranded)", async () => {
    // Back-compat / conformance fallback: with NO gate-rework router wired, a clean-rebase
    // gate-fail falls back to `recordReplan` (the pre-fix behavior) so the spec is never
    // stranded — production ALWAYS wires the router (the test above).
    const h = harness({ conflictOnRebase: false, reGate: "failed", noGateRework: true });
    await reexec(h);
    expect(h.gateRework.calls).toEqual([]);
    expect(h.persistence.replanned).toHaveLength(1);
    expect(h.persistence.repointStacks).toEqual([]);
    const event = h.events.rawEvents[0];
    expect(event).toMatchObject({ decision: "replanned", rebaseConflicted: false, sameRunId: true });
    expect(() => IntegrationRebasePayload.parse(event)).not.toThrow();
  });

  it("a CONFLICTED rebase whose RESOLVED tree fails a GATE TIER ⇒ WRITER REWORK (clean tree, not irreconcilable)", async () => {
    // The resolver FIT the conflict (a clean resolved tree), but the coordinator's re-gate of
    // that resolved tree fails a GATE TIER — the tree is byte-clean, the code just fails a
    // gate on the new base. Route to WRITER REWORK, NOT replan.
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
    // The LIVE resolver's INTERNAL re-gate failed a GATE TIER and it ALREADY routed the spec
    // to writer rework (re-opened + enqueued a re-author run) — signalled via routedToRework.
    // The coordinator MUST NOT also replan (that would double-route the spec).
    const h = harness({
      conflictOnRebase: true,
      resolution: { resolved: false, routedToRework: true, reason: "re-gate gate-tier fail — routed to rework" },
    });
    await reexec(h);
    expect(h.persistence.replanned).toEqual([]);
    // The coordinator does not re-route (the resolver owned it) — its own gate-rework seam is
    // untouched on this path.
    expect(h.gateRework.calls).toEqual([]);
    expect(h.events.events).toEqual([
      { runId: DEP_RUN, decision: "replanned", rebaseConflicted: true, sameRunId: true },
    ]);
  });

  it("FAIL-CLOSED: a `pending` (inconclusive) re-gate HOLDS — never merges, never discards", async () => {
    const h = harness({ conflictOnRebase: false, reGate: "pending" });
    await expect(reexec(h)).rejects.toBeInstanceOf(BaseShiftHeldError);
    // The work survives: no replan write, no keep-run write — just a loud hold.
    expect(h.persistence.replanned).toEqual([]);
    expect(h.persistence.repointStacks).toEqual([]);
  });

  it("non-speculative (every ancestor merged) re-points the base to an EMPTY stack (a real run against main), same run", async () => {
    const h = harness({ conflictOnRebase: false, reGate: "passed" });
    const result = await reexec(h, { nonSpeculative: true, ancestorStack: [] });
    expect(result.reexecRunId).toBe(DEP_RUN);
    // jj-local: non-speculative ⇒ the re-resolved stack is EMPTY (a real run against main).
    expect(h.persistence.repointStacks).toEqual([{ runId: DEP_RUN, ancestorStack: [] }]);
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

// walker-jj-local-integration-design.md §2.2 — the never-discard base shift over the LOCAL
// ancestor stack. Two coupling points vs the deleted synthesized-ref path: (1) the
// coordinator THREADS the re-resolved ancestor stack to the opener (which assembles it
// locally); (2) `keepRun` re-points `runs.ancestor_stack` to the re-resolved stack (a run is
// "speculative" iff the stack is non-empty — the legacy `speculative_base` column is gone).
describe("base-shift over the re-resolved ancestor stack", () => {
  it("the re-resolved stack is THREADED to the opener (assembled locally, not a synthesized ref)", async () => {
    const h = harness({ conflictOnRebase: false, reGate: "passed" });
    await reexec(h);
    expect(h.opener.calls).toEqual([
      {
        runId: DEP_RUN,
        nonSpeculative: false,
        // The opener got the re-resolved stack (NOT undefined) — so the live opener assembles
        // it locally (`main + ordered ancestors`), never a synthesized host ref.
        ancestorStack: DEFAULT_STACK,
      },
    ]);
    // The dependent's branch was rebased onto the opener's assembled head (never-discard:
    // the SAME branch, rebased in place — not regenerated).
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
    // Non-speculative: the opener gets an empty stack (it takes the plain default_branch
    // clone, not a local assembly) and keepRun writes an empty stack.
    expect(h.opener.calls).toEqual([{ runId: DEP_RUN, nonSpeculative: true, ancestorStack: [] }]);
    expect(h.persistence.repointStacks).toEqual([{ runId: DEP_RUN, ancestorStack: [] }]);
  });
});
