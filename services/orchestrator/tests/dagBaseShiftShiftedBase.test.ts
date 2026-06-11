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

import { afterEach, describe, expect, it } from "vitest";
import type { SpeculativeDependent } from "../src/engine/contracts/changePercolation.js";
import type { IntegrationNode } from "../src/engine/contracts/integrationNodes.js";
import type { AncestorStack } from "../src/engine/dag/ancestorStack.js";
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

/** A resolver that RECORDS the shifted base + the re-resolved stack the coordinator handed it. */
function recordingResolver(): BaseShiftConflictResolver & {
  seen: Array<{ newBaseRef: string; nonSpeculative: boolean; ancestorStack?: AncestorStack }>;
} {
  const seen: Array<{ newBaseRef: string; nonSpeculative: boolean; ancestorStack?: AncestorStack }> = [];
  return {
    seen,
    async resolve(input) {
      seen.push({
        newBaseRef: input.newBaseRef,
        nonSpeculative: input.nonSpeculative,
        ...(input.ancestorStack !== undefined && { ancestorStack: input.ancestorStack }),
      });
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

/** A recording opener that captures the re-resolved ancestor stack (WS-A PR-6 §2.2). */
function stackRecordingOpener(): BaseShiftWorkspaceOpener & { seen: Array<AncestorStack | undefined> } {
  const seen: Array<AncestorStack | undefined> = [];
  return {
    seen,
    async open(input) {
      seen.push(input.ancestorStack);
      return { workspaceId: "ws_1", path: "/scratch/ws_1", branch: "tanren/run_b", newBaseSha: "sha-assembled-head" };
    },
  };
}

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

  // WS-A PR-6b (§2.2): the coordinator THREADS the re-resolved stack into the RESOLVER (not
  // just the opener) so the live resolver assembles the SAME `main + ordered ancestors`
  // LOCALLY instead of cloning `${newBaseRef}@origin` when it gathers the recorded conflict.
  it("a CONFLICTED speculative shift hands the resolver the re-resolved stack (for the LOCAL assembly)", async () => {
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
      ancestorStack: RESOLVED_STACK,
      ancestorSpecId: "spec_a",
      toSha: "sha-new",
    });
    // The resolver received the SAME re-resolved stack the opener did — so the live resolve
    // assembles `main + ordered ancestors` LOCALLY (no `${newBaseRef}@origin` clone).
    expect(resolver.seen).toEqual([{ newBaseRef: SHIFTED_BASE, nonSpeculative: false, ancestorStack: RESOLVED_STACK }]);
  });
});

// ---- WS-A PR-6 (§2.2): the coordinator THREADS the re-resolved stack to the opener ----

/** A clean-rebase jj core (so the coordinator reaches keepRun, not the resolver). */
class CleanCore implements WorkspaceVcsCore {
  async openWorkspace(): Promise<{ workspaceId: string; path: string }> {
    return { workspaceId: "ws_1", path: "/scratch/ws_1" };
  }
  async branch(): Promise<void> {}
  async checkout(): Promise<void> {}
  async commit(): Promise<{ headSha: string }> {
    return { headSha: "sha" };
  }
  async rebaseOnto(): Promise<RebaseResult> {
    return { outcome: "clean", headSha: "sha-rebased-clean" };
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

const RESOLVED_STACK: AncestorStack = [
  { specId: "spec_a", runId: "run_a", branch: "tanren/run_a", headSha: "sha-a-new" },
];

describe("BaseShiftCoordinator — threads the re-resolved ancestor stack to the opener (WS-A PR-6)", () => {
  afterEach(() => {
    delete process.env["WALKER_JJ_LOCAL_BASE"];
  });

  it("the opener RECEIVES the re-resolved stack ⇒ the live opener assembles it locally (not the synthesized ref)", async () => {
    const opener = stackRecordingOpener();
    const coord = new BaseShiftCoordinator({
      workspace: new CleanCore(),
      opener,
      reGate: passingReGate,
      resolver: recordingResolver(),
      persistence: noopPersistence,
      nodes: noNodes,
      events: noopEvents,
    });
    await coord.rebaseOnto({
      projectId: "project_1",
      dependent: dependent(),
      newBaseRef: SHIFTED_BASE,
      nonSpeculative: false,
      ancestorStack: RESOLVED_STACK,
      ancestorSpecId: "spec_a",
      toSha: "sha-new",
    });
    // The opener was handed the re-resolved stack — so the live opener assembles `main +
    // ordered ancestors` LOCALLY instead of cloning `${newBaseRef}@origin`.
    expect(opener.seen).toEqual([RESOLVED_STACK]);
  });
});
