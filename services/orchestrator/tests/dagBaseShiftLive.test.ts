// The LIVE base-shift seams + the merge-path `behind`-handler wiring
// (tanren-owns-the-engine.md §3 never-discard, §7 one base-shift handler). These prove the
// WIRING + the never-discard coordinator outcomes through a FAITHFUL FAKE of the live seams
// (the full jj-against-a-runner path is apex-validated; here we fake at the live-seam
// boundary). Proves:
//   - the LIVE seams are unconditional: `buildBaseShiftCoordinator` with the runner deps
//     wired selects the LIVE seams (the opener allocates a runner);
//   - the runner deps ABSENT: construction THROWS LOUD (a wiring bug, never a silent
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
  type BaseShiftGateReworkRouter,
  type BaseShiftNodeReader,
  type BaseShiftPersistence,
  type BaseShiftReGate,
  type BaseShiftWorkspaceOpener,
  type ConflictResolution,
  type RebaseDecision,
  type ReGateVerdict,
} from "../src/engine/dag/baseShiftCoordinator.js";
import { buildBaseShiftCoordinator, MarkerSuppressedBaseShiftPersistence } from "../src/engine/dag/percolationBuild.js";
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
  delete process.env["WALKER_JJ_LOCAL_BASE"];
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
  readonly markedInFlight: Array<{ runId: string; ancestorSpecId: string }> = [];
  readonly replanned: Array<{ runId: string; specId: string }> = [];
  async repointBase(input: { runId: string }): Promise<void> {
    this.repointCalls.push(input.runId);
  }
  async markInFlight(input: { runId: string; pending: { ancestorSpecId: string } }): Promise<void> {
    // A `percolation_pending` marker write — the percolation poller's selector. The P1
    // behind path must NOT reach here (it is wrapped by MarkerSuppressedBaseShiftPersistence).
    this.markedInFlight.push({ runId: input.runId, ancestorSpecId: input.pending.ancestorSpecId });
  }
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

const noopGateRework: BaseShiftGateReworkRouter = {
  async routeGateFailToRework() {},
};

function coordinator(opts: {
  conflictOnRebase?: boolean;
  reGate?: ReGateVerdict;
  resolution?: ConflictResolution;
  /** Wrap the recording persistence in the behind-path marker suppressor (the P1 fix). */
  suppressMarker?: boolean;
}): {
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
    persistence: opts.suppressMarker === true ? new MarkerSuppressedBaseShiftPersistence(persistence) : persistence,
    nodes,
    events,
    // gateRework is REQUIRED (Codex critic #15) — this file's tests do not exercise the
    // clean-rebase gate-fail arm, so a no-op suffices; the routing proofs live in
    // dagBaseShiftCoordinator.test.ts (the `RecordingGateRework` harness).
    gateRework: noopGateRework,
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

// ---- (1) The live-seam selection (unconditional + loud-throw on absent deps) ----

// The live opener's FIRST act is `loadBaseShiftRunContext` (a `runWithSystemScope` `FROM
// runs` query). So whether a `FROM runs` read RAN proves the LIVE seam drove.
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

describe("the LIVE base-shift seams — unconditional + loud-throw on absent deps", () => {
  it("runner deps wired ⇒ the LIVE opener runs (reaches the DB context load)", async () => {
    const counter = { reads: 0 };
    const coord = buildBaseShiftCoordinator({
      pool: countingPool(counter),
      githubHttp: {} as never,
      secrets: {} as never,
      ...runnerDeps(),
    });
    // The live opener loads the run context (a DB read) BEFORE allocating; the row is absent
    // here so it surfaces a fail-closed hold — but the KEY proof is the DB read RAN (live).
    await expect(driveRebase(coord)).rejects.toBeInstanceOf(BaseShiftHeldError);
    expect(counter.reads).toBeGreaterThanOrEqual(1);
  });

  it("WS-A PR-6: WALKER_JJ_LOCAL_BASE ON + a speculative dependent ⇒ the LIVE opener still runs (the local-assembly path is reachable)", async () => {
    // With the jj-local flag ON and a NON-empty re-resolved stack, the live opener takes the
    // LOCAL stack-assembly arm (`assembleBaseShiftStackWorkspace`) instead of the single-ref
    // clone — but it STILL loads the run context first (the DB read), proving the live seam (not
    // the held stub) drives. The assembly itself is realjj-pinned (baseShiftStackAssembly.realjj).
    process.env["WALKER_JJ_LOCAL_BASE"] = "1";
    const counter = { reads: 0 };
    const coord = buildBaseShiftCoordinator({
      pool: countingPool(counter),
      githubHttp: {} as never,
      secrets: {} as never,
      ...runnerDeps(),
    });
    // A speculative drive (non-empty stack onto the integration ref) — the jj-local opener arm.
    await expect(
      coord.rebaseOnto({
        projectId: PROJECT,
        dependent: dependent(),
        newBaseRef: "tanren/integ/spec_b",
        nonSpeculative: false,
        ancestorStack: [{ specId: "spec_a", runId: "run_a", branch: "tanren/run_a", headSha: "sha-a-new" }],
        ancestorSpecId: "spec_a",
        toSha: "sha-a-new",
      }),
    ).rejects.toBeInstanceOf(BaseShiftHeldError);
    expect(counter.reads).toBeGreaterThanOrEqual(1);
  });

  it("runner deps ABSENT ⇒ construction THROWS LOUD (a wiring bug, never a silent degrade)", () => {
    // A build site with no allocator/ssh/identity is wired wrong: the base-shift handler
    // needs the runner deps to drive a live runner and they are absent. That is a
    // CONSTRUCTION BUG, not a degrade to honor with a quiet hold — `buildBaseShiftCoordinator`
    // throws.
    expect(() =>
      buildBaseShiftCoordinator({
        pool: { query: () => Promise.resolve({ rows: [], rowCount: 0 }) } as unknown as pg.Pool,
        githubHttp: {} as never,
        secrets: {} as never,
      }),
    ).toThrow(/The live base-shift deps are not wired/u);
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
    // The merge `behind` path reads this as `rebased` (advance + re-gate + merge), NOT
    // held — and surfaces the RESOLVED head sha so the dispatcher's re-gate binds its
    // verdict to the rebased PR head (§5 commit-binding), not the stale workspace HEAD.
    expect(outcome).toEqual({ outcome: "rebased", rebasedHeadSha: "sha-resolved" });
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
    // §5 commit-binding: the CLEAN rebase surfaces its rebased head sha for the re-gate.
    expect(outcome).toEqual({ outcome: "rebased", rebasedHeadSha: "sha-rebased-clean" });
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

// ---- (3) P1: the merge-queue `behind` rebase is NOT a deferred percolation ----

describe("P1: the `behind` rebase NEVER stamps percolation_pending (no mis-routing to the poller)", () => {
  async function runBehind(opts: Parameters<typeof coordinator>[0]) {
    const { coord, persistence, events } = coordinator({ ...opts, suppressMarker: true });
    const hook = buildBaseShiftRebaseHook({ pool: fakeRunsPool(), coordinator: coord });
    const outcome = await hook({ runId: DEP_RUN, baseBranch: "main", headBranch: DEP_BRANCH });
    return { outcome, persistence, events };
  }

  it("a clean behind rebase KEEPS the run (repoint) but writes NO percolation_pending marker", async () => {
    const { outcome, persistence } = await runBehind({ conflictOnRebase: false, reGate: "passed" });
    // The run row is kept (repoint), the merge proceeds (`rebased`)…
    expect(outcome).toMatchObject({ outcome: "rebased" });
    expect(persistence.repointCalls).toEqual([DEP_RUN]);
    // …but NO `percolation_pending` was stamped — so the percolation poller (which selects on
    // that marker) can NEVER pick this synchronous merge-queue run up + falsely settle it.
    expect(persistence.markedInFlight).toEqual([]);
  });

  it("a resolved-conflict behind rebase (same run_id never-discard) also writes NO marker", async () => {
    const { outcome, persistence } = await runBehind({
      conflictOnRebase: true,
      reGate: "passed",
      resolution: { resolved: true, headSha: "sha-resolved" },
    });
    expect(outcome).toMatchObject({ outcome: "rebased" });
    // never-discard: the SAME run kept; never mis-routed to the percolation poller.
    expect(persistence.repointCalls).toEqual([DEP_RUN]);
    expect(persistence.markedInFlight).toEqual([]);
  });

  it("the change-percolation path (un-suppressed persistence) STILL stamps the marker — only `behind` is decoupled", async () => {
    // The default coordinator (no suppressMarker wrap) is the percolation path: it MUST keep the
    // marker (the settle reads it). This guards against over-suppressing the real deferral.
    const { coord, persistence } = coordinator({ conflictOnRebase: false, reGate: "passed" });
    await coord.reexecute({
      projectId: PROJECT,
      dependent: dependent(),
      decision: {
        ancestorSpecId: "spec_a",
        promptness: "immediate",
        fromSha: "sha-old",
        toSha: "sha-new",
        immediateSeverity: "P0",
      },
      integrationBranch: "tanren/integ/spec_b",
      ancestorHeadShas: { spec_a: "sha-new" },
      nonSpeculative: false,
    });
    expect(persistence.markedInFlight).toEqual([{ runId: DEP_RUN, ancestorSpecId: "spec_a" }]);
  });
});

describe("MarkerSuppressedBaseShiftPersistence — the behind-path marker suppressor (unit)", () => {
  it("no-ops markInFlight; delegates repointBase + recordReplan", async () => {
    const inner = new RecordingPersistence();
    const wrapped = new MarkerSuppressedBaseShiftPersistence(inner);
    await wrapped.repointBase({ projectId: PROJECT, runId: DEP_RUN, speculativeBase: null });
    await wrapped.markInFlight({ projectId: PROJECT, runId: DEP_RUN, pending: { ancestorSpecId: "x", toSha: "y" } });
    await wrapped.recordReplan({
      projectId: PROJECT,
      specId: DEP_SPEC,
      runId: DEP_RUN,
      ancestorSpecId: "x",
      ancestorSha: "y",
      reason: "r",
    });
    expect(inner.repointCalls).toEqual([DEP_RUN]);
    expect(inner.replanned).toEqual([{ runId: DEP_RUN, specId: DEP_SPEC }]);
    // The marker write — the poller's selector — was DROPPED.
    expect(inner.markedInFlight).toEqual([]);
  });
});
