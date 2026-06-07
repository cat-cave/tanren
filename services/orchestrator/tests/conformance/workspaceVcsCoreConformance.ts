// Seam conformance suite for the `WorkspaceVcsCore` contract
// (`engine/contracts/workspaceVcsCore.ts`, tanren-owns-the-engine.md §2). The
// reusable behavior spec EVERY impl (the Wave-1 jj impl + the git fallback) must
// satisfy — the FIRST-CLASS-conflict guarantees that make "a conflict must never
// brick" true by construction:
//   - rebaseOnto a CONFLICTING base SUCCEEDS and RECORDS a conflict (never throws,
//     never discards the work);
//   - resolveConflict + restackDescendants PROPAGATE the resolution down the stack;
//   - exportCleanGitRef THROWS on an unresolved-conflict state — a conflicted ref is
//     NEVER exported to the host (the §2 local/host boundary, fail-closed);
//   - opUndo reverts the last operation (the reproducible operation log).
//
// Parameterized by an impl factory so any Wave-1 backend runs the SAME suite.
// Mirrors the MergeCoordinator / SpeculativeIntegrator / VcsProvider suites.

import { describe, expect, it } from "vitest";
import type { WorkspaceVcsCore } from "../../src/engine/contracts/workspaceVcsCore.js";

export interface WorkspaceVcsCoreConformanceHarness {
  /** A fresh, empty impl per call (no shared state across cases). */
  make(): WorkspaceVcsCore;
}

const REPO = "https://example.com/owner/repo.git";

export function describeWorkspaceVcsCoreConformance(label: string, harness: WorkspaceVcsCoreConformanceHarness): void {
  describe(`WorkspaceVcsCore conformance: ${label}`, () => {
    it("rebaseOnto a CONFLICTING base SUCCEEDS and records a conflict (never throws/discards)", async () => {
      const core = harness.make();
      const ws = await core.openWorkspace({ repoUrl: REPO, baseBranch: "main", path: "/w" });
      await core.branch(ws, "feature");
      await core.commit(ws, "work");

      const result = await core.rebaseOnto(ws, "conflict-base-sha");

      // The rebase SUCCEEDED (it did not throw) AND recorded a conflict — the work survived.
      expect(result.outcome).toBe("conflicted");
      expect(result.conflict).toBeDefined();
      expect(result.headSha).not.toBe("");
    });

    it("a CLEAN rebaseOnto applies with no conflict", async () => {
      const core = harness.make();
      const ws = await core.openWorkspace({ repoUrl: REPO, baseBranch: "main", path: "/w" });
      await core.branch(ws, "feature");
      const result = await core.rebaseOnto(ws, "clean-base-sha");
      expect(result.outcome).toBe("clean");
      expect(result.conflict).toBeUndefined();
    });

    it("resolveConflict + restackDescendants PROPAGATES the resolution down the stack", async () => {
      const core = harness.make();
      const ws = await core.openWorkspace({ repoUrl: REPO, baseBranch: "main", path: "/w" });
      await core.branch(ws, "ancestor");
      await core.commit(ws, "ancestor work");
      // The descendant stacks on the ancestor.
      await core.branch(ws, "descendant");
      await core.commit(ws, "descendant work");

      // Conflict the ancestor, resolve it, then restack: the descendant inherits the fix.
      // (re-enter the ancestor branch by re-opening — the fake stacks descendants on it)
      const rebase = await core.rebaseOnto(ws, "conflict-base-sha");
      expect(rebase.conflict).toBeDefined();
      await core.resolveConflict({
        workspace: ws,
        conflictId: rebase.conflict?.conflictId ?? "",
        resolutions: [{ path: "src/conflicted.ts", content: "resolved" }],
      });

      const restack = await core.restackDescendants(ws, "ancestor");
      // The resolution propagated: no descendant remains conflicted.
      expect(restack.stillConflicted).toEqual([]);
    });

    it("exportCleanGitRef THROWS on an unresolved conflict — NEVER exports a conflicted ref", async () => {
      const core = harness.make();
      const ws = await core.openWorkspace({ repoUrl: REPO, baseBranch: "main", path: "/w" });
      await core.branch(ws, "feature");
      await core.commit(ws, "work");
      // Leaves an unresolved conflict on the branch.
      await core.rebaseOnto(ws, "conflict-base-sha");

      await expect(core.exportCleanGitRef(ws, "feature")).rejects.toThrow(/conflict|refusing|unresolved/iu);
    });

    it("exportCleanGitRef SUCCEEDS once the conflict is resolved", async () => {
      const core = harness.make();
      const ws = await core.openWorkspace({ repoUrl: REPO, baseBranch: "main", path: "/w" });
      await core.branch(ws, "feature");
      await core.commit(ws, "work");
      const rebase = await core.rebaseOnto(ws, "conflict-base-sha");
      await core.resolveConflict({
        workspace: ws,
        conflictId: rebase.conflict?.conflictId ?? "",
        resolutions: [{ path: "src/conflicted.ts", content: "resolved" }],
      });
      const exported = await core.exportCleanGitRef(ws, "feature");
      expect(exported.ref).toContain("feature");
      expect(exported.headSha).not.toBe("");
    });

    it("opUndo REVERTS the last operation (the reproducible operation log)", async () => {
      const core = harness.make();
      const ws = await core.openWorkspace({ repoUrl: REPO, baseBranch: "main", path: "/w" });
      await core.branch(ws, "feature");
      await core.commit(ws, "work");
      const before = await core.exportCleanGitRef(ws, "feature");

      // Advance the head, then undo that commit via the operation log.
      await core.commit(ws, "more work");
      await core.opUndo(ws);

      const after = await core.exportCleanGitRef(ws, "feature");
      expect(after.headSha).toBe(before.headSha);
    });
  });
}
