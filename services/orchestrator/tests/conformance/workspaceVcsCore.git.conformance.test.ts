// Drives the FROZEN WorkspaceVcsCore conformance suite
// (workspaceVcsCoreConformance.ts, tanren-owns-the-engine.md §2) against the REAL
// `GitWorkspaceVcsCore` over an ACTUAL git process (the LocalCommandSubstrate) and a
// REAL local fixture repo — NOT the in-memory fake. This proves the contract's
// first-class-conflict guarantees with real VCS plumbing: a conflicting rebase
// SUCCEEDS + records the conflict, an ancestor resolution PROPAGATES to descendants
// on restack, export REFUSES a conflicted ref, opUndo reverts.
//
// git is universally available, so this runs UNCONDITIONALLY in CI / `just
// fast-check` — it is the always-on real-backend proof. The jj sibling
// (workspaceVcsCore.jj.conformance.test.ts) is env-gated on `jj` being installed.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  OpenWorkspaceInput,
  WorkspaceHandle,
  WorkspaceVcsCore,
} from "../../src/engine/contracts/workspaceVcsCore.js";
import { GitWorkspaceVcsCore } from "../../src/engine/providers/gitWorkspaceVcsCore.js";
import { LOCAL_HANDLE, LocalCommandSubstrate } from "./fakes/localCommandSubstrate.js";
import { makeGitFixture } from "./fakes/gitWorkspaceFixtureRepo.js";
import { describeWorkspaceVcsCoreConformance } from "./workspaceVcsCoreConformance.js";

// The conformance edits via `commit("work")` with no content, so the git impl needs
// a real change to make a rebase conflict. The fixture's `conflict-base` edits
// `src/conflicted.ts`; this mutator makes every commit edit the SAME file so a
// conflicting rebase is genuinely a 3-way conflict (the engine never hard-codes this
// — production stages the runner's working tree instead).
function fixtureCommitMutator(message: string): string[] {
  return [`mkdir -p src`, `printf %s ${shellQuote(`ours:${message}\n`)} > src/conflicted.ts`];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Rewrites the harness's fixed `/w` path onto a fresh temp dir per workspace so the
// real clone lands somewhere writable + isolated. Pure test plumbing.
class PathRemappingGitCore implements WorkspaceVcsCore {
  constructor(
    private readonly inner: GitWorkspaceVcsCore,
    private readonly scratchRoot: string,
  ) {}

  async openWorkspace(input: OpenWorkspaceInput): Promise<WorkspaceHandle> {
    const path = mkdtempSync(join(this.scratchRoot, "ws-"));
    return this.inner.openWorkspace({ ...input, path });
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

describeWorkspaceVcsCoreConformance("GitWorkspaceVcsCore (real git)", {
  make: (): WorkspaceVcsCore => {
    const fixture = makeGitFixture();
    const scratch = mkdtempSync(join(tmpdir(), "tanren-wvcs-ws-"));
    const core = new GitWorkspaceVcsCore({
      substrate: new LocalCommandSubstrate(),
      target: LOCAL_HANDLE,
      timeoutMs: 30_000,
      refResolver: fixture.refResolver,
      commitMutator: fixtureCommitMutator,
    });
    return new PathRemappingGitCore(core, scratch);
  },
});
