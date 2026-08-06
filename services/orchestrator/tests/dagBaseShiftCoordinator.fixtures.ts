// Shared scripted-seam fixtures for the BaseShiftCoordinator never-discard unit tests
// (`dagBaseShiftCoordinator.test.ts`). Extracted so each file stays under the 500-line
// architecture cap; the in-memory seams, the `harness` builder, and the `reexec` driver are
// imported by the test file. No vitest primitives here — pure test scaffolding.

import type { PercolationDecision, SpeculativeDependent } from "../src/engine/contracts/changePercolation.js";
import type { IntegrationNode } from "../src/engine/contracts/integrationNodes.js";
import type { AncestorStack } from "../src/engine/dag/ancestorStack.js";
import type { RebaseResult, RecordedConflict, WorkspaceVcsCore } from "../src/engine/contracts/workspaceVcsCore.js";
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
  type ReGateResult,
  type ReGateVerdict,
} from "../src/engine/dag/baseShiftCoordinator.js";
import type { BaseShiftLineagePayload } from "../src/engine/dag/baseShiftLineage.js";
import { ownedPlannerRecovery, settleRecoveryForTest } from "./fixtures/scriptedRecoverySettlement.js";

export const PROJECT = "project_base_shift";
export const DEP_RUN = "run_dependent_keep_me";
export const DEP_BRANCH = "tanren/run_dependent";

export function dependent(over: Partial<SpeculativeDependent> = {}): SpeculativeDependent {
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

export const DECISION: PercolationDecision = {
  ancestorSpecId: "spec_a",
  promptness: "immediate",
  fromSha: "sha-old",
  toSha: "sha-new",
  immediateSeverity: "P0",
};

// ---- In-memory seams (fixtures) -------------------------------------------

export class RecordingWorkspaceCore implements WorkspaceVcsCore {
  readonly rebaseCalls: Array<{ branch: string; baseSha: string }> = [];
  readonly resolveCalls: Array<{ branch: string; conflictId: string }> = [];
  constructor(
    private readonly conflictOnRebase: boolean,
    // #1059: when set, `rebaseOnto` THROWS — the live provider's `rebaseOnto` propagates a
    // publish failure (a rejected `--force-with-lease` when the remote head moved mid-window)
    // out of this seam exactly this way, so the coordinator must map it to a fail-closed HOLD.
    private readonly throwOnRebase?: Error,
  ) {}

  async openWorkspace(): Promise<{ workspaceId: string; path: string }> {
    return { workspaceId: "ws_1", path: "/scratch/ws_1" };
  }
  async assembleIntegration(): Promise<never> {
    throw new Error("subset assembly is outside this base-shift fixture");
  }
  async branch(): Promise<void> {}
  async checkout(): Promise<void> {}
  async commit(): Promise<{ headSha: string }> {
    return { headSha: "sha-commit" };
  }
  async rebaseOnto(_ws: { workspaceId: string }, branch: string, baseSha: string): Promise<RebaseResult> {
    this.rebaseCalls.push({ branch, baseSha });
    if (this.throwOnRebase !== undefined) {
      throw this.throwOnRebase;
    }
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

export class RecordingOpener implements BaseShiftWorkspaceOpener {
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

export type ScriptedReGate = BaseShiftReGate & { calls: number };
export function scriptedReGate(verdict: ReGateVerdict, gateError?: string): ScriptedReGate {
  const fake: ScriptedReGate = {
    calls: 0,
    async reGate(): Promise<ReGateResult> {
      fake.calls += 1;
      return { verdict, ...(gateError !== undefined && { gateError }) };
    },
  };
  return fake;
}

export type RecordingGateRework = BaseShiftGateReworkRouter & {
  calls: Array<{ specId: string; runId: string; gateError: string }>;
};
export function recordingGateRework(): RecordingGateRework {
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
          run: { kind: "enqueued", replanRunId: "run_r", plannerTaskId: "task_r" },
        },
      };
    },
  };
}

export type ScriptedResolver = BaseShiftConflictResolver & { calls: number };
export function scriptedResolver(resolution: ConflictResolution): ScriptedResolver {
  const fake: ScriptedResolver = {
    calls: 0,
    async resolve(): Promise<ConflictResolution> {
      fake.calls += 1;
      return resolution;
    },
  };
  return fake;
}

export type RecordingNodeReader = BaseShiftNodeReader & { calls: number };
export function recordingNodeReader(): RecordingNodeReader {
  const fake: RecordingNodeReader = {
    calls: 0,
    async nodesForDependent(): Promise<IntegrationNode[]> {
      fake.calls += 1;
      return [];
    },
  };
  return fake;
}

export class RecordingPersistence implements BaseShiftPersistence {
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
  async recordReplan(input: { runId: string; specId: string; reason: string }) {
    this.replanned.push({ runId: input.runId, specId: input.specId, reason: input.reason });
    return ownedPlannerRecovery(input.specId);
  }
  async settleRecovery(input: Parameters<BaseShiftPersistence["settleRecovery"]>[0]) {
    return settleRecoveryForTest(input.recovery);
  }
  async clearInFlight(): Promise<void> {}
}

export class RecordingEventEmitter implements BaseShiftEventEmitter {
  readonly events: Array<{ runId: string; decision: RebaseDecision; rebaseConflicted: boolean; sameRunId: true }> = [];
  // The FULL emitted payload (the never-discard `sameRunId: true` mirror the production
  // `appendIntegrationRebaseEvent` builds) — for asserting contract-validity.
  readonly rawEvents: Array<Record<string, unknown>> = [];
  // The durable gv-17 lineage the pg emitter would write to `base_shift_operations` — the
  // ONLY place the recorded `ancestorSpecId` / `invalidationCause` are observable.
  readonly lineages: Array<BaseShiftLineagePayload> = [];
  async emitRebase(input: {
    specId: string;
    runId: string;
    branch: string;
    newBaseSha: string;
    headSha: string;
    rebaseConflicted: boolean;
    decision: RebaseDecision;
    lineage?: BaseShiftLineagePayload;
  }): Promise<void> {
    if (input.lineage !== undefined) {
      this.lineages.push(input.lineage);
    }
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

export interface Harness {
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

export function harness(opts: {
  conflictOnRebase?: boolean;
  reGate?: ReGateVerdict;
  reGateError?: string;
  resolution?: ConflictResolution;
  throwOnRebase?: Error;
}): Harness {
  const workspace = new RecordingWorkspaceCore(opts.conflictOnRebase ?? false, opts.throwOnRebase);
  const opener = new RecordingOpener();
  const reGate = scriptedReGate(opts.reGate ?? "passed", opts.reGateError);
  const resolver = scriptedResolver(opts.resolution ?? { resolved: true, headSha: "sha-resolved" });
  const persistence = new RecordingPersistence();
  const nodes = recordingNodeReader();
  const events = new RecordingEventEmitter();
  const gateRework = recordingGateRework();
  // gateRework is REQUIRED on BaseShiftCoordinatorDeps (Codex critic #15) — every construction
  // site MUST wire it; there is no degenerate-replan fallback to conform against.
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

// The default re-resolved ancestor stack the kick-off threads (one unmerged ancestor,
// spec_a, at its NEW head — the real PR-head branch + run id the stack resolver supplies).
export const DEFAULT_STACK: AncestorStack = [
  { specId: "spec_a", runId: "run_a", branch: "tanren/spec_a", headSha: "sha-new" },
];

export async function reexec(h: Harness, over: Partial<Parameters<BaseShiftCoordinator["reexecute"]>[0]> = {}) {
  return h.coord.reexecute({
    projectId: PROJECT,
    dependent: dependent(),
    decision: DECISION,
    ancestorStack: DEFAULT_STACK,
    nonSpeculative: false,
    ...over,
  });
}
