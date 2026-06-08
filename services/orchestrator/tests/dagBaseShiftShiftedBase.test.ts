// Wave-3/Slice-2 P0 FIX — the live base-shift conflict resolution gathers + re-gates against
// the SHIFTED base the initial rebase used (the speculative integration ref, or plain
// default_branch when non-speculative), NEVER the project default. Resolving against the
// WRONG base then recording `rebased_resolved` is a fail-OPEN (unproven work marked
// resolved). Pinned WITHOUT module mocking (it is frozen) via two real seams:
//   (1) `baseShiftApplierFacts` (the pure BASE-WIRING the live resolver uses) gathers the
//       conflict against `shiftedBase`, NOT `ctx.defaultBranch`;
//   (2) the BaseShiftCoordinator THREADS `newBaseRef` + `nonSpeculative` into the resolver
//       (so the shifted base actually reaches the resolution seam) — a recording resolver
//       captures exactly what the coordinator handed it.

import { describe, expect, it } from "vitest";
import type { SpeculativeDependent } from "../src/engine/contracts/changePercolation.js";
import type { IntegrationNode } from "../src/engine/contracts/integrationNodes.js";
import type { RebaseResult, RecordedConflict, WorkspaceVcsCore } from "../src/engine/contracts/workspaceVcsCore.js";
import {
  BaseShiftCoordinator,
  type BaseShiftConflictResolver,
  type BaseShiftEventEmitter,
  type BaseShiftNodeReader,
  type BaseShiftPersistence,
  type BaseShiftReGate,
  type BaseShiftWorkspaceOpener,
  type ConflictResolution,
} from "../src/engine/dag/baseShiftCoordinator.js";
import { baseShiftApplierFacts } from "../src/engine/dag/baseShiftLiveResolve.js";
import type { BaseShiftRunContext } from "../src/engine/dag/baseShiftLiveContext.js";

const DEFAULT_BRANCH = "main";
const SHIFTED_BASE = "tanren/integ/spec_b";

function ctx(): BaseShiftRunContext {
  return {
    orgId: "org_1",
    projectId: "project_1",
    specId: "spec_b",
    runId: "run_b",
    repoUrl: "https://github.com/acme/app",
    headBranch: "tanren/run_b",
    defaultBranch: DEFAULT_BRANCH,
    runnerImage: "ghcr.io/tanren/runner:latest",
    governancePosture: "moderate",
    githubCredentialRef: "credential/github/acme",
    specTitle: "B",
    specDescription: "the dependent spec",
    acceptanceCriteria: ["does B"],
    routing: {} as never,
    defaultLlm: {} as never,
  };
}

describe("baseShiftApplierFacts — P0: gather against the SHIFTED base, never the project default", () => {
  it("the speculative integration ref ⇒ gather/rebase onto <shiftedBase>@origin, NOT main", () => {
    const facts = baseShiftApplierFacts(ctx(), SHIFTED_BASE);
    expect(facts.baseBranch).toBe(SHIFTED_BASE);
    expect(facts.baseRevision).toBe(`${SHIFTED_BASE}@origin`);
    // THE P0 GUARD: a regression to ctx.defaultBranch would make this `main`.
    expect(facts.baseBranch).not.toBe(DEFAULT_BRANCH);
    expect(facts.headBranch).toBe("tanren/run_b");
  });

  it("a non-speculative shift (every ancestor merged) ⇒ gather onto default_branch (the real base)", () => {
    // The non-speculative caller passes ctx.defaultBranch AS the shifted base — which is then
    // the genuine base it lands on, not a wrong substitution.
    const facts = baseShiftApplierFacts(ctx(), DEFAULT_BRANCH);
    expect(facts.baseBranch).toBe(DEFAULT_BRANCH);
    expect(facts.baseRevision).toBe(`${DEFAULT_BRANCH}@origin`);
  });
});

// ---- The coordinator THREADS the shifted base into the resolver (so the fix reaches it) ----

function dependent(): SpeculativeDependent {
  return {
    specId: "spec_b",
    runId: "run_b",
    speculativeBase: SHIFTED_BASE,
    integratedAncestorShas: { spec_a: "sha-old" },
    verifiedAncestorShas: { spec_a: "sha-old" },
    lifecycleState: "building",
    openFindingMaxSeverity: "unaudited",
  };
}

/** A jj core fake whose rebase CONFLICTS (so the coordinator engages the resolver). */
class ConflictingCore implements WorkspaceVcsCore {
  async openWorkspace(): Promise<{ workspaceId: string; path: string }> {
    return { workspaceId: "ws_1", path: "/scratch/ws_1" };
  }
  async branch(): Promise<void> {}
  async checkout(): Promise<void> {}
  async commit(): Promise<{ headSha: string }> {
    return { headSha: "sha" };
  }
  async rebaseOnto(_ws: { workspaceId: string }, branch: string): Promise<RebaseResult> {
    const conflict: RecordedConflict = {
      conflictId: "cfl_1",
      between: { specId: branch, otherSpecId: "base" },
      paths: ["src/x.ts"],
    };
    return { outcome: "conflicted", headSha: "sha-conflicted", conflict };
  }
  async resolveConflict(): Promise<{ headSha: string }> {
    return { headSha: "sha-resolved" };
  }
  async restackDescendants(): Promise<{ restacked: never[]; stillConflicted: never[] }> {
    return { restacked: [], stillConflicted: [] };
  }
  async exportCleanGitRef(): Promise<{ ref: string; headSha: string }> {
    return { ref: "r", headSha: "sha" };
  }
  async opUndo(): Promise<void> {}
}

/** A resolver that RECORDS the shifted base the coordinator handed it. */
function recordingResolver(): BaseShiftConflictResolver & {
  seen: Array<{ newBaseRef: string; nonSpeculative: boolean }>;
} {
  const seen: Array<{ newBaseRef: string; nonSpeculative: boolean }> = [];
  return {
    seen,
    async resolve(input) {
      seen.push({ newBaseRef: input.newBaseRef, nonSpeculative: input.nonSpeculative });
      return { resolved: true, headSha: "sha-resolved" } satisfies ConflictResolution;
    },
  };
}

const passingReGate: BaseShiftReGate = {
  async reGate() {
    return "passed";
  },
};
const noNodes: BaseShiftNodeReader = {
  async nodesForDependent(): Promise<IntegrationNode[]> {
    return [];
  },
};
const noopPersistence: BaseShiftPersistence = {
  async repointBase() {},
  async markInFlight() {},
  async recordReplan() {},
};
const noopEvents: BaseShiftEventEmitter = {
  async emitRebase() {},
};

const SPEC_OPENER: BaseShiftWorkspaceOpener = {
  async open(input) {
    // The opener resolves the dependent's branch + the shifted-base sha; the coordinator
    // passes `newBaseRef` straight through to the resolver (the value under test).
    return {
      workspaceId: "ws_1",
      path: "/scratch/ws_1",
      branch: "tanren/run_b",
      newBaseSha: `${input.newBaseRef}@origin`,
    };
  },
};

describe("BaseShiftCoordinator — threads the SHIFTED base (newBaseRef + nonSpeculative) to the resolver", () => {
  it("a speculative shift hands the resolver newBaseRef (the integration ref), NOT defaultBranch", async () => {
    const resolver = recordingResolver();
    const coord = new BaseShiftCoordinator({
      workspace: new ConflictingCore(),
      opener: SPEC_OPENER,
      reGate: passingReGate,
      resolver,
      persistence: noopPersistence,
      nodes: noNodes,
      events: noopEvents,
    });
    await coord.rebaseOnto({
      projectId: "project_1",
      dependent: dependent(),
      newBaseRef: SHIFTED_BASE,
      nonSpeculative: false,
      ancestorSpecId: "spec_a",
      toSha: "sha-new",
    });
    // The resolver was handed the SHIFTED base — so the live resolve gathers against it.
    expect(resolver.seen).toEqual([{ newBaseRef: SHIFTED_BASE, nonSpeculative: false }]);
    expect(resolver.seen[0]?.newBaseRef).not.toBe(DEFAULT_BRANCH);
  });

  it("a non-speculative shift hands the resolver nonSpeculative:true (resolve onto default_branch)", async () => {
    const resolver = recordingResolver();
    const coord = new BaseShiftCoordinator({
      workspace: new ConflictingCore(),
      opener: SPEC_OPENER,
      reGate: passingReGate,
      resolver,
      persistence: noopPersistence,
      nodes: noNodes,
      events: noopEvents,
    });
    await coord.rebaseOnto({
      projectId: "project_1",
      dependent: dependent(),
      newBaseRef: DEFAULT_BRANCH,
      nonSpeculative: true,
      ancestorSpecId: "spec_a",
      toSha: "sha-new",
    });
    expect(resolver.seen).toEqual([{ newBaseRef: DEFAULT_BRANCH, nonSpeculative: true }]);
  });
});
