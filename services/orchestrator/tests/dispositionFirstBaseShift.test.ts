// F1 hostile: base-shift threads post-route disposition; pending clear vs retain.
// Old bug: discard ReplanRouteResult, force decision=replanned, always clear pending.

import { describe, expect, it } from "vitest";
import type { ConflictRecoveryDisposition, ReplanRouteResult } from "../src/engine/contracts/conflictResolution.js";
import type { SpeculativeDependent } from "../src/engine/contracts/changePercolation.js";
import type { RebaseResult, RecordedConflict, WorkspaceVcsCore } from "../src/engine/contracts/workspaceVcsCore.js";
import type { AncestorStack } from "../src/engine/dag/ancestorStack.js";
import {
  BaseShiftCoordinator,
  type BaseShiftConflictResolver,
  type BaseShiftEventEmitter,
  type BaseShiftGateReworkRouter,
  type BaseShiftNodeReader,
  type BaseShiftPersistence,
  type BaseShiftReGate,
  type BaseShiftWorkspaceOpener,
  type ConflictResolution,
  type RebaseDecision,
} from "../src/engine/dag/baseShiftCoordinator.js";
import {
  baseShiftDecisionFromRecovery,
  baseShiftDecisionFromRouteResult,
  shouldClearPercolationPending,
} from "../src/engine/merge/recoveryOwnership.js";

const PROJECT = "proj_disp";
const DEP_RUN = "run_dep";
const DEP_BRANCH = "tanren/run_dep";
const STACK: AncestorStack = [{ specId: "spec_a", runId: "run_a", branch: "tanren/a", headSha: "sha-a" }];

function dependent(): SpeculativeDependent {
  return {
    specId: "spec_b",
    runId: DEP_RUN,
    speculativeBase: "tanren/integ/spec_b",
    integratedAncestorShas: { spec_a: "sha-old" },
    verifiedAncestorShas: { spec_a: "sha-old" },
    lifecycleState: "building",
    openFindingMaxSeverity: "unaudited",
  };
}

class ConflictWs implements WorkspaceVcsCore {
  async openWorkspace() {
    return { workspaceId: "ws", path: "/tmp/ws" };
  }
  async branch() {}
  async checkout() {}
  async commit() {
    return { headSha: "sha-c" };
  }
  async rebaseOnto(): Promise<RebaseResult> {
    const conflict: RecordedConflict = {
      conflictId: "c1",
      between: { specId: DEP_BRANCH, otherSpecId: "base" },
      paths: ["x.ts"],
    };
    return { outcome: "conflicted", headSha: "sha-conflicted", conflict };
  }
  async resolveConflict() {
    return { headSha: "sha-resolved" };
  }
  async restackDescendants() {
    return { restacked: [], stillConflicted: [] };
  }
  async exportCleanGitRef() {
    return { ref: "refs/heads/x", headSha: "sha-x" };
  }
  async opUndo() {}
}

class RecordingPersist implements BaseShiftPersistence {
  replanned: Array<{ reason: string }> = [];
  replanResult: ReplanRouteResult = {
    kind: "owned",
    receipt: {
      kind: "planner_replan",
      specId: "spec_b",
      run: { kind: "enqueued", replanRunId: "run_r", plannerTaskId: "task_r" },
    },
  };
  async repointBase() {}
  async markInFlight() {}
  async recordReplan(input: { reason: string }) {
    this.replanned.push({ reason: input.reason });
    return this.replanResult;
  }
}

class RecordingEmit implements BaseShiftEventEmitter {
  decisions: RebaseDecision[] = [];
  async emitRebase(input: { decision: RebaseDecision }) {
    this.decisions.push(input.decision);
  }
}

const opener: BaseShiftWorkspaceOpener = {
  open: async () => ({ workspaceId: "ws", path: "/tmp", branch: DEP_BRANCH, newBaseSha: "sha-base" }),
};
const reGatePass: BaseShiftReGate = { reGate: async () => ({ verdict: "passed" }) };
const nodeReader: BaseShiftNodeReader = { nodesForDependent: async () => [] };
const gateRework: BaseShiftGateReworkRouter = {
  routeGateFailToRework: async () => ({
    kind: "owned",
    receipt: {
      kind: "writer_rework",
      specId: "spec_b",
      run: { kind: "already_running", runId: "run_live" },
    },
  }),
};

function scriptedResolver(resolution: ConflictResolution): BaseShiftConflictResolver {
  return { resolve: async () => resolution };
}

async function reexecConflicted(persist: RecordingPersist, resolution: ConflictResolution, emit: RecordingEmit) {
  const coord = new BaseShiftCoordinator({
    workspace: new ConflictWs(),
    opener,
    reGate: reGatePass,
    resolver: scriptedResolver(resolution),
    persistence: persist,
    nodes: nodeReader,
    events: emit,
    gateRework,
  });
  return coord.rebaseOnto({
    projectId: PROJECT,
    dependent: dependent(),
    nonSpeculative: false,
    ancestorStack: STACK,
    ancestorSpecId: "spec_a",
    toSha: "sha-new",
  });
}

describe("F1 base-shift post-route dispositions + pending clear/retain", () => {
  it.each([
    {
      name: "owned → replanned",
      result: {
        kind: "owned" as const,
        receipt: {
          kind: "planner_replan" as const,
          specId: "spec_b",
          run: { kind: "enqueued" as const, replanRunId: "r", plannerTaskId: "t" },
        },
      },
      decision: "replanned" as const,
      clear: true,
    },
    {
      name: "parked → parked",
      result: {
        kind: "parked" as const,
        receipt: { kind: "needs_attention" as const, specId: "spec_b", source: "planner_replan" as const },
        message: "parked",
      },
      decision: "parked" as const,
      clear: true,
    },
    {
      name: "terminal_noop → held",
      result: { kind: "terminal_noop" as const, status: "merged" as const, message: "merged" },
      decision: "held" as const,
      clear: true,
    },
    {
      name: "parking_failed → held (retain pending)",
      result: { kind: "parking_failed" as const, message: "park fail", observedStatus: "in_flight" },
      decision: "held" as const,
      clear: false,
    },
  ])("$name", async ({ result, decision, clear }) => {
    const persist = new RecordingPersist();
    persist.replanResult = result;
    const emit = new RecordingEmit();
    const out = await reexecConflicted(persist, { resolved: false, reason: "collide" }, emit);
    expect(persist.replanned).toHaveLength(1);
    expect(out.decision).toBe(decision);
    expect(emit.decisions).toEqual([decision]);
    expect(shouldClearPercolationPending(result.kind)).toBe(clear);
  });

  it("HOSTILE: parking_required is never claimed replanned merely because routing was attempted", async () => {
    const persist = new RecordingPersist();
    persist.replanResult = {
      kind: "parking_failed",
      message: "park failed after replan attempt",
      observedStatus: "in_flight",
    };
    const emit = new RecordingEmit();
    const out = await reexecConflicted(
      persist,
      {
        resolved: false,
        reason: "collide",
        recovery: { kind: "parking_required", message: "needs park" },
      },
      emit,
    );
    expect(persist.replanned).toHaveLength(1);
    expect(out.decision).toBe("held");
    expect(out.decision).not.toBe("replanned");
    expect(baseShiftDecisionFromRecovery({ kind: "parking_required", message: "x" })).toBe("held");
    expect(baseShiftDecisionFromRouteResult({ kind: "parking_required" })).toBe("held");
  });

  it("pre-assigned owned/parked/terminal/parking_failed never re-route via recordReplan", async () => {
    const cases: Array<{ recovery: ConflictRecoveryDisposition; decision: RebaseDecision }> = [
      {
        recovery: {
          kind: "owned",
          receipt: {
            kind: "writer_rework",
            specId: "spec_b",
            run: { kind: "already_running", runId: "live" },
          },
        },
        decision: "writer_rework",
      },
      {
        recovery: {
          kind: "parked",
          receipt: { kind: "needs_attention", specId: "spec_b", source: "planner_replan" },
          message: "parked",
        },
        decision: "parked",
      },
      {
        recovery: { kind: "terminal_noop", status: "cancelled", message: "cancelled" },
        decision: "held",
      },
      {
        recovery: { kind: "parking_failed", message: "fail" },
        decision: "held",
      },
    ];
    for (const c of cases) {
      const persist = new RecordingPersist();
      const emit = new RecordingEmit();
      const out = await reexecConflicted(persist, { resolved: false, reason: "x", recovery: c.recovery }, emit);
      expect(persist.replanned).toHaveLength(0);
      expect(out.decision).toBe(c.decision);
    }
  });

  it("pending clear predicate: owned/parked/terminal clear; parking_failed/required retain", () => {
    expect(shouldClearPercolationPending("owned")).toBe(true);
    expect(shouldClearPercolationPending("parked")).toBe(true);
    expect(shouldClearPercolationPending("terminal_noop")).toBe(true);
    expect(shouldClearPercolationPending("parking_failed")).toBe(false);
    expect(shouldClearPercolationPending("parking_required")).toBe(false);
  });
});
