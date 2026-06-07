// Seam conformance suite for the `WorkspaceVcsCore` contract
// (`engine/contracts/workspaceVcsCore.ts`, tanren-owns-the-engine.md §2). The
// reusable behavior spec EVERY impl (the Wave-1 jj impl + the git fallback) must
// satisfy — the FIRST-CLASS-conflict guarantees that make "a conflict must never
// brick" true by construction:
//   - rebaseOnto a CONFLICTING base SUCCEEDS and RECORDS a conflict (never throws,
//     never discards the work);
//   - resolving a conflict on an ANCESTOR + restackDescendants PROPAGATES the
//     resolution DOWN a real stack A→B→C (the descendant was conflicted by the
//     ancestor and clears only after restack — NOT a same-branch shortcut);
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
      await core.branch(ws, "feature", "main");
      await core.commit(ws, "work");

      const result = await core.rebaseOnto(ws, "feature", "conflict-base-sha");

      // The rebase SUCCEEDED (it did not throw) AND recorded a conflict — the work survived.
      expect(result.outcome).toBe("conflicted");
      expect(result.conflict).toBeDefined();
      expect(result.headSha).not.toBe("");
    });

    it("a CLEAN rebaseOnto applies with no conflict", async () => {
      const core = harness.make();
      const ws = await core.openWorkspace({ repoUrl: REPO, baseBranch: "main", path: "/w" });
      await core.branch(ws, "feature", "main");
      const result = await core.rebaseOnto(ws, "feature", "clean-base-sha");
      expect(result.outcome).toBe("clean");
      expect(result.conflict).toBeUndefined();
    });

    it("resolving an ANCESTOR conflict + restackDescendants PROPAGATES the fix down a stack A→B→C", async () => {
      const core = harness.make();
      const ws = await core.openWorkspace({ repoUrl: REPO, baseBranch: "main", path: "/w" });
      // Build a real stack: ancestor (A) on main, then B on A, then C on B.
      await core.branch(ws, "ancestor", "main");
      await core.commit(ws, "ancestor work");
      // Conflict the ANCESTOR first — the descendants built on it inherit the conflict.
      const rebase = await core.rebaseOnto(ws, "ancestor", "conflict-base-sha");
      expect(rebase.conflict).toBeDefined();
      await core.branch(ws, "mid", "ancestor");
      await core.branch(ws, "leaf", "mid");

      // The descendants are conflicted (inherited) — they CANNOT export yet.
      await expect(core.exportCleanGitRef(ws, "leaf")).rejects.toThrow(/conflict|refusing|unresolved/iu);

      // Resolve on the ANCESTOR (not the descendant), then restack the descendants.
      await core.resolveConflict({
        workspace: ws,
        branch: "ancestor",
        conflictId: rebase.conflict?.conflictId ?? "",
        resolutions: [{ path: "src/conflicted.ts", content: "resolved" }],
      });
      const restack = await core.restackDescendants(ws, "ancestor");

      // The resolution PROPAGATED down: every restacked descendant is now clean.
      expect(restack.stillConflicted).toEqual([]);
      expect(restack.restacked.map((r) => r.branch).sort()).toEqual(["leaf", "mid"]);
      // And a descendant now exports clean (the fix reached the leaf).
      const exported = await core.exportCleanGitRef(ws, "leaf");
      expect(exported.headSha).not.toBe("");
    });

    it("exportCleanGitRef THROWS on an unresolved conflict — NEVER exports a conflicted ref", async () => {
      const core = harness.make();
      const ws = await core.openWorkspace({ repoUrl: REPO, baseBranch: "main", path: "/w" });
      await core.branch(ws, "feature", "main");
      await core.commit(ws, "work");
      // Leaves an unresolved conflict on the branch.
      await core.rebaseOnto(ws, "feature", "conflict-base-sha");

      await expect(core.exportCleanGitRef(ws, "feature")).rejects.toThrow(/conflict|refusing|unresolved/iu);
    });

    it("exportCleanGitRef SUCCEEDS once the conflict is resolved", async () => {
      const core = harness.make();
      const ws = await core.openWorkspace({ repoUrl: REPO, baseBranch: "main", path: "/w" });
      await core.branch(ws, "feature", "main");
      await core.commit(ws, "work");
      const rebase = await core.rebaseOnto(ws, "feature", "conflict-base-sha");
      await core.resolveConflict({
        workspace: ws,
        branch: "feature",
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
      await core.branch(ws, "feature", "main");
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
