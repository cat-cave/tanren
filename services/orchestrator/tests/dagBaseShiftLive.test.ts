// Wave-3/Slice-2: the LIVE base-shift seams + the `baseShiftLive()` flag (default ON +
// kill-switch) + the merge-path `behind`-handler wiring (tanren-owns-the-engine.md §3
// never-discard, §7 one base-shift handler). These prove the WIRING + the never-discard
// coordinator outcomes through a FAITHFUL FAKE of the live seams (the full jj-against-a-
// runner path is apex-validated; here we fake at the live-seam boundary). Proves:
//   - flag DEFAULT ON: `buildBaseShiftCoordinator` with the runner deps wired selects the
//     LIVE seams (the opener allocates a runner) — NOT the held stub;
//   - flag OFF (`BASE_SHIFT_LIVE=0`): the held stubs HOLD loudly (kill-switch);
//   - flag ON but the runner deps ABSENT: the held stubs HOLD (fail-closed, never a silent
//     degrade);
//   - the merge-path `behind` hook maps the coordinator's never-discard outcomes:
//       * a CONFLICT rebased + resolved IN PLACE (same run_id, ending `rebased_resolved`)
//         ⇒ the hook returns `rebased` — NOT `held` (the never-discard proof);
//       * an irreconcilable shift ⇒ the coordinator `replanned` (work alive) ⇒ `held`;
//       * a clean rebase + passing re-gate ⇒ `rebased_clean` (no replan) ⇒ `rebased`;
//       * a re-gate `pending` ⇒ a `BaseShiftHeldError` ⇒ the hook `held` (fail-closed).

import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { SpeculativeDependent } from "../src/engine/contracts/changePercolation.js";
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
import { buildBaseShiftCoordinator } from "../src/engine/dag/percolationBuild.js";
import { buildBaseShiftRebaseHook } from "../src/engine/dag/baseShiftRebaseHook.js";

const PROJECT = "project_live";
const DEP_RUN = "run_dependent_keep_me";
const DEP_SPEC = "spec_b";
const DEP_BRANCH = "tanren/run_dependent";

function dependent(): SpeculativeDependent {
  return {
    specId: DEP_SPEC,
    runId: DEP_RUN,
    speculativeBase: "tanren/integ/spec_b",
    integratedAncestorShas: { spec_a: "sha-old" },
    verifiedAncestorShas: { spec_a: "sha-old" },
    lifecycleState: "building",
    openFindingMaxSeverity: "unaudited",
  };
}

afterEach(() => {
  delete process.env["BASE_SHIFT_LIVE"];
  vi.restoreAllMocks();
});

// ---- In-memory seams (TEST FIXTURES — they live here, never src/) ----------

class RecordingWorkspaceCore implements WorkspaceVcsCore {
  constructor(private readonly conflictOnRebase: boolean) {}
  async openWorkspace(): Promise<{ workspaceId: string; path: string }> {
    return { workspaceId: "ws_1", path: "/scratch/ws_1" };
  }
  async branch(): Promise<void> {}
  async checkout(): Promise<void> {}
  async commit(): Promise<{ headSha: string }> {
    return { headSha: "sha-commit" };
  }
  async rebaseOnto(_ws: { workspaceId: string }, branch: string): Promise<RebaseResult> {
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
  async resolveConflict(): Promise<{ headSha: string }> {
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

const opener: BaseShiftWorkspaceOpener = {
  async open() {
    return { workspaceId: "ws_1", path: "/scratch/ws_1", branch: DEP_BRANCH, newBaseSha: "sha-new-base" };
  },
};

function reGate(verdict: ReGateVerdict): BaseShiftReGate {
  return {
    async reGate() {
      return verdict;
    },
  };
}
function resolver(resolution: ConflictResolution): BaseShiftConflictResolver {
  return {
    async resolve() {
      return resolution;
    },
  };
}
const nodes: BaseShiftNodeReader = {
  async nodesForDependent(): Promise<IntegrationNode[]> {
    return [];
  },
};

class RecordingPersistence implements BaseShiftPersistence {
  readonly repointCalls: string[] = [];
  readonly replanned: Array<{ runId: string; specId: string }> = [];
  async repointBase(input: { runId: string }): Promise<void> {
    this.repointCalls.push(input.runId);
  }
  async markInFlight(): Promise<void> {}
  async recordReplan(input: { runId: string; specId: string }): Promise<void> {
    this.replanned.push({ runId: input.runId, specId: input.specId });
  }
}

class RecordingEvents implements BaseShiftEventEmitter {
  readonly decisions: Array<{ runId: string; decision: RebaseDecision }> = [];
  async emitRebase(input: { runId: string; decision: RebaseDecision }): Promise<void> {
    this.decisions.push({ runId: input.runId, decision: input.decision });
  }
}

function coordinator(opts: { conflictOnRebase?: boolean; reGate?: ReGateVerdict; resolution?: ConflictResolution }): {
  coord: BaseShiftCoordinator;
  persistence: RecordingPersistence;
  events: RecordingEvents;
} {
  const persistence = new RecordingPersistence();
  const events = new RecordingEvents();
  const coord = new BaseShiftCoordinator({
    workspace: new RecordingWorkspaceCore(opts.conflictOnRebase ?? false),
    opener,
    reGate: reGate(opts.reGate ?? "passed"),
    resolver: resolver(opts.resolution ?? { resolved: true, headSha: "sha-resolved" }),
    persistence,
    nodes,
    events,
  });
  return { coord, persistence, events };
}

// A pool whose connect()-client + pool.query both answer the hook's run lookup (the
// `runWithSystemScope` machinery runs the query on the checked-out client).
function fakeRunsPool(): pg.Pool {
  const answer = (sql: string) => {
    if (/SELECT spec_id, project_id FROM runs/u.test(sql)) {
      return { rows: [{ spec_id: DEP_SPEC, project_id: PROJECT }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query: (sql: string) => Promise.resolve(answer(sql)), release: () => {} };
  return {
    query: (sql: string) => Promise.resolve(answer(sql)),
    connect: () => Promise.resolve(client),
  } as unknown as pg.Pool;
}

// ---- (1) The flag selection (default ON + kill-switch + fail-closed fallback) ----

// The held stub throws BEFORE any DB read; the live opener's FIRST act is
// `loadBaseShiftRunContext` (a `runWithSystemScope` `FROM runs` query). So whether a `FROM
// runs` read RAN distinguishes the LIVE seam from the HELD stub.
function countingPool(counter: { reads: number }): pg.Pool {
  const run = (sql: string) => {
    if (/FROM runs/u.test(sql)) counter.reads += 1;
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
  return { query: run, connect: () => Promise.resolve({ query: run, release: () => {} }) } as unknown as pg.Pool;
}

const driveRebase = (coord: BaseShiftCoordinator) =>
  coord.rebaseOnto({
    projectId: PROJECT,
    dependent: dependent(),
    newBaseRef: "main",
    nonSpeculative: true,
    ancestorSpecId: "main",
    toSha: "main",
  });

const runnerDeps = () => ({
  allocator: { allocate: vi.fn<() => Promise<never>>(), release: vi.fn<() => Promise<void>>() } as never,
  ssh: {} as never,
  identitySecretRef: "secret/runner/identity",
});

describe("baseShiftLive() flag — the Wave-3/Slice-2 cutover (default ON + kill-switch)", () => {
  it("DEFAULT ON + runner deps wired ⇒ the LIVE opener runs (reaches the DB context load), NOT the held stub", async () => {
    const counter = { reads: 0 };
    const coord = buildBaseShiftCoordinator({
      pool: countingPool(counter),
      vcsProvider: {} as never,
      secrets: {} as never,
      ...runnerDeps(),
    });
    // The live opener loads the run context (a DB read) BEFORE allocating; the row is absent
    // here so it surfaces a fail-closed hold — but the KEY proof is the DB read RAN (live).
    await expect(driveRebase(coord)).rejects.toBeInstanceOf(BaseShiftHeldError);
    expect(counter.reads).toBeGreaterThanOrEqual(1);
  });

  it("KILL-SWITCH (BASE_SHIFT_LIVE=0) ⇒ the HELD stub holds loudly (never reaches the DB)", async () => {
    process.env["BASE_SHIFT_LIVE"] = "0";
    const counter = { reads: 0 };
    const coord = buildBaseShiftCoordinator({
      pool: countingPool(counter),
      vcsProvider: {} as never,
      secrets: {} as never,
      ...runnerDeps(),
    });
    await expect(driveRebase(coord)).rejects.toBeInstanceOf(BaseShiftHeldError);
    // The held stub threw BEFORE any DB read — the kill-switch reverted to the stubs.
    expect(counter.reads).toBe(0);
  });

  it("flag ON but runner deps ABSENT ⇒ the HELD stub holds (fail-closed, never a silent degrade)", async () => {
    const coord = buildBaseShiftCoordinator({
      pool: { query: () => Promise.resolve({ rows: [], rowCount: 0 }) } as unknown as pg.Pool,
      vcsProvider: {} as never,
      secrets: {} as never,
    });
    await expect(driveRebase(coord)).rejects.toBeInstanceOf(BaseShiftHeldError);
  });
});

// ---- (2) The merge-path `behind` hook maps the never-discard outcomes ----

describe("buildBaseShiftRebaseHook — the merge `behind` path routes through the ONE coordinator", () => {
  async function runHook(opts: Parameters<typeof coordinator>[0]) {
    const { coord, persistence, events } = coordinator(opts);
    const hook = buildBaseShiftRebaseHook({ pool: fakeRunsPool(), coordinator: coord });
    const outcome = await hook({ runId: DEP_RUN, baseBranch: "main", headBranch: DEP_BRANCH });
    return { outcome, persistence, events };
  }

  it("THE NEVER-DISCARD PROOF: a CONFLICT rebased + resolved IN PLACE (same run_id) ⇒ `rebased`, NOT `held`", async () => {
    const { outcome, persistence, events } = await runHook({
      conflictOnRebase: true,
      reGate: "passed",
      resolution: { resolved: true, headSha: "sha-resolved" },
    });
    // The conflicted rebase was resolved in place + re-gated clean: the dependent's run row
    // was KEPT (repoint on the SAME run id), NO replan, ending `rebased_resolved`.
    expect(events.decisions).toEqual([{ runId: DEP_RUN, decision: "rebased_resolved" }]);
    expect(persistence.repointCalls).toEqual([DEP_RUN]);
    expect(persistence.replanned).toEqual([]);
    // The merge `behind` path reads this as `rebased` (advance + re-gate + merge), NOT held.
    expect(outcome).toEqual({ outcome: "rebased" });
  });

  it("an IRRECONCILABLE shift ⇒ the coordinator `replanned` (work ALIVE, same run) ⇒ the hook `held`", async () => {
    const { outcome, persistence, events } = await runHook({
      conflictOnRebase: true,
      resolution: { resolved: false, reason: "intents genuinely collide" },
    });
    // Replanned on the SAME run id — the work is alive, never discarded; the merge HOLDS.
    expect(events.decisions).toEqual([{ runId: DEP_RUN, decision: "replanned" }]);
    expect(persistence.replanned).toEqual([{ runId: DEP_RUN, specId: DEP_SPEC }]);
    expect(outcome.outcome).toBe("held");
  });

  it("a CLEAN rebase + passing re-gate ⇒ `rebased_clean` (NO replan, token reuse) ⇒ the hook `rebased`", async () => {
    const { outcome, persistence, events } = await runHook({ conflictOnRebase: false, reGate: "passed" });
    expect(events.decisions).toEqual([{ runId: DEP_RUN, decision: "rebased_clean" }]);
    expect(persistence.replanned).toEqual([]);
    expect(outcome).toEqual({ outcome: "rebased" });
  });

  it("FAIL-CLOSED: a re-gate `pending` ⇒ a BaseShiftHeldError ⇒ the hook `held` (work survives, never merged)", async () => {
    const { outcome, persistence } = await runHook({ conflictOnRebase: false, reGate: "pending" });
    // No keep-run + no replan write — just a loud hold the merge path reads as recoverable.
    expect(persistence.repointCalls).toEqual([]);
    expect(persistence.replanned).toEqual([]);
    expect(outcome.outcome).toBe("held");
  });

  it("a missing run ⇒ `held` (never a silent proceed)", async () => {
    const emptyPool = {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      connect: () => Promise.resolve({ query: () => Promise.resolve({ rows: [], rowCount: 0 }), release: () => {} }),
    } as unknown as pg.Pool;
    const { coord } = coordinator({});
    const hook = buildBaseShiftRebaseHook({ pool: emptyPool, coordinator: coord });
    const outcome = await hook({ runId: "run_missing", baseBranch: "main" });
    expect(outcome.outcome).toBe("held");
  });
});
