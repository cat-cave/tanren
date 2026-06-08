// Drives the FROZEN WorkspaceVcsCore conformance suite
// (workspaceVcsCoreConformance.ts, tanren-owns-the-engine.md §2) against the REAL +
// ONLY `JjWorkspaceVcsCore` over an ACTUAL `jj` process (the LocalCommandSubstrate) +
// a real local git fixture jj clones — NOT the in-memory fake. This proves jj's
// native first-class-conflict guarantees end to end: a conflicting rebase SUCCEEDS +
// records the conflict IN the commit, an ancestor resolution auto-PROPAGATES to
// descendants on restack, export REFUSES a conflicted ref, opUndo reverts.
//
// Plus impl-specific regression cases (Codex round-2): opUndo restores in-memory
// state (a stale `currentBranch` would brick the next op); `RecordedConflict.conflictId`
// is STABLE across reads; `openWorkspace` OWNS its destination dir (no pre-creation).
//
// UNCONDITIONAL: jj is the sole WorkspaceVcsCore backend, so this IS the seam's
// real-backend proof — it runs in `just fast-check` like any test. jj is on the dev
// PATH and installed by both the runner Dockerfile and the monorepo CI workflow.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JjRefResolver, JjWorkingEdit } from "../../src/engine/providers/jjWorkspaceVcsCore.js";
import type {
  OpenWorkspaceInput,
  WorkspaceHandle,
  WorkspaceVcsCore,
} from "../../src/engine/contracts/workspaceVcsCore.js";
import { JjWorkspaceVcsCore } from "../../src/engine/providers/jjWorkspaceVcsCore.js";
import { LOCAL_HANDLE, LocalCommandSubstrate } from "./fakes/localCommandSubstrate.js";
import { makeGitFixture } from "./fakes/gitWorkspaceFixtureRepo.js";
import { describeWorkspaceVcsCoreConformance } from "./workspaceVcsCoreConformance.js";

let wsCounter = 0;

// Map the suite's synthetic base tokens onto the jj clone's imported bookmarks (jj
// imports the git fixture's `conflict-base` / `clean-base` branches as bookmarks).
// `cloneSource` is identity — the PathRemappingJjCore below injects the fixture's
// real origin path as the repoUrl before this resolver sees it.
const jjRefResolver: JjRefResolver = {
  cloneSource: (repoUrl) => repoUrl,
  baseRevision: (baseSha) => {
    // jj imports the fixture's git branches as REMOTE bookmarks (`<name>@origin`).
    if (baseSha.startsWith("conflict-")) return "conflict-base@origin";
    if (baseSha.startsWith("clean-")) return "clean-base@origin";
    return baseSha;
  },
};

const jjWorkingEdit: JjWorkingEdit = (message) => [
  `mkdir -p src`,
  `printf %s ${shellQuote(`ours:${message}\n`)} > src/conflicted.ts`,
];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Remaps the harness's fixed `/w` path onto a fresh per-workspace path AND points the
// clone at the per-workspace fixture origin. Pure test plumbing. The remapped path is
// deliberately NON-PRE-CREATED — `openWorkspace` must OWN creating it (issue #3), so
// pre-creating here would mask the bug.
class PathRemappingJjCore implements WorkspaceVcsCore {
  constructor(
    private readonly inner: JjWorkspaceVcsCore,
    private readonly origin: string,
    private readonly scratchRoot: string,
  ) {}

  async openWorkspace(input: OpenWorkspaceInput): Promise<WorkspaceHandle> {
    const path = join(this.scratchRoot, `ws-${++wsCounter}`);
    return this.inner.openWorkspace({ ...input, repoUrl: this.origin, path });
  }
  branch(ws: WorkspaceHandle, name: string, atBranch?: string): Promise<void> {
    return this.inner.branch(ws, name, atBranch);
  }
  checkout(ws: WorkspaceHandle, branch: string): Promise<void> {
    return this.inner.checkout(ws, branch);
  }
  commit(ws: WorkspaceHandle, message: string): ReturnType<WorkspaceVcsCore["commit"]> {
    return this.inner.commit(ws, message);
  }
  rebaseOnto(ws: WorkspaceHandle, branch: string, baseSha: string): ReturnType<WorkspaceVcsCore["rebaseOnto"]> {
    return this.inner.rebaseOnto(ws, branch, baseSha);
  }
  resolveConflict(
    input: Parameters<WorkspaceVcsCore["resolveConflict"]>[0],
  ): ReturnType<WorkspaceVcsCore["resolveConflict"]> {
    return this.inner.resolveConflict(input);
  }
  restackDescendants(ws: WorkspaceHandle, branch: string): ReturnType<WorkspaceVcsCore["restackDescendants"]> {
    return this.inner.restackDescendants(ws, branch);
  }
  exportCleanGitRef(ws: WorkspaceHandle, branch: string): ReturnType<WorkspaceVcsCore["exportCleanGitRef"]> {
    return this.inner.exportCleanGitRef(ws, branch);
  }
  opUndo(ws: WorkspaceHandle): Promise<void> {
    return this.inner.opUndo(ws);
  }
}

function makeJjCore(): WorkspaceVcsCore {
  const fixture = makeGitFixture();
  const scratch = mkdtempSync(join(tmpdir(), "tanren-jj-ws-"));
  const core = new JjWorkspaceVcsCore({
    substrate: new LocalCommandSubstrate(),
    target: LOCAL_HANDLE,
    timeoutMs: 60_000,
    refResolver: jjRefResolver,
    workingEdit: jjWorkingEdit,
  });
  return new PathRemappingJjCore(core, fixture.originPath, scratch);
}

describe("WorkspaceVcsCore real-jj conformance", () => {
  describeWorkspaceVcsCoreConformance("JjWorkspaceVcsCore (real jj)", { make: makeJjCore });
});

// Impl-specific regression cases (Codex round-2) the FROZEN harness does not cover.
describe("JjWorkspaceVcsCore real-jj regressions", () => {
  it("opUndo restores in-memory currentBranch — a later op works after branch();opUndo()", async () => {
    const core = makeJjCore();
    const ws = await core.openWorkspace({ repoUrl: "https://example.com/o/r.git", baseBranch: "main", path: "/w" });
    // branch() sets currentBranch="feature"; opUndo() must revert it to "main". After
    // the jj op restore the "feature" bookmark is GONE, so a stale currentBranch would
    // brick the next op that defaults to it. branch() with NO atBranch defaults to
    // currentBranch — it must resolve to "main" (the reverted value), not "feature".
    await core.branch(ws, "feature", "main");
    await core.opUndo(ws);
    // atBranch omitted → branch() defaults to the reverted currentBranch ("main").
    await core.branch(ws, "feature2");
    await expect(core.commit(ws, "post-undo")).resolves.toBeDefined();
  });

  it("RecordedConflict.conflictId is STABLE across re-reads of the same conflict", async () => {
    const core = makeJjCore();
    const ws = await core.openWorkspace({ repoUrl: "https://example.com/o/r.git", baseBranch: "main", path: "/w" });
    await core.branch(ws, "feature", "main");
    await core.commit(ws, "work");
    // Read the SAME unresolved conflict twice (a fresh rebaseOnto onto the same base is
    // idempotent on an already-conflicted branch) — the conflictId must be equal.
    const first = await core.rebaseOnto(ws, "feature", "conflict-base-sha");
    const second = await core.rebaseOnto(ws, "feature", "conflict-base-sha");
    expect(first.conflict).toBeDefined();
    expect(second.conflict).toBeDefined();
    expect(second.conflict?.conflictId).toBe(first.conflict?.conflictId);
  });

  it("RecordedConflict.conflictId is DISTINCT for distinct conflicts (no over-stability)", async () => {
    const core = makeJjCore();
    const ws = await core.openWorkspace({ repoUrl: "https://example.com/o/r.git", baseBranch: "main", path: "/w" });
    // Two DISTINCT branches each produce their OWN conflict (different jj change_id) —
    // the ids must DIFFER, proving the stable derivation does not collapse distinct
    // conflicts onto a single id.
    await core.branch(ws, "feat-a", "main");
    await core.commit(ws, "work-a");
    const a = await core.rebaseOnto(ws, "feat-a", "conflict-base-sha");
    await core.branch(ws, "feat-b", "main");
    await core.commit(ws, "work-b");
    const b = await core.rebaseOnto(ws, "feat-b", "conflict-base-sha");
    expect(a.conflict).toBeDefined();
    expect(b.conflict).toBeDefined();
    expect(b.conflict?.conflictId).not.toBe(a.conflict?.conflictId);
  });

  it("openWorkspace OWNS its destination dir (no pre-created dir needed)", async () => {
    // The path-remapping wrapper hands openWorkspace a NON-PRE-CREATED path; a
    // successful open + branch + commit proves openWorkspace created the dir itself.
    const core = makeJjCore();
    const ws = await core.openWorkspace({ repoUrl: "https://example.com/o/r.git", baseBranch: "main", path: "/w" });
    await core.branch(ws, "feature", "main");
    await expect(core.commit(ws, "work")).resolves.toBeDefined();
  });
});
