// The `WorkspaceVcsCore` seam (tanren-owns-the-engine.md §1, §2) — the LOCAL
// VCS-core half of the GitHub-shaped `VcsProvider` decomposition. It owns the
// runner-local working copy: clone/import, branch, commit, rebase-onto-a-shifting-
// base, FIRST-CLASS conflict recording, conflict resolution + descendant restack,
// the clean-ref export, and operation undo.
//
// WHY this seam (the audit it addresses): §2 + §7. jj's native primitives ARE the
// machinery Tanren was hand-rolling — a rebase that conflicts STILL SUCCEEDS and
// records the conflict IN the commit (so "a conflict must never brick" is true by
// construction, not by a `git merge --abort` dance), automatic descendant rebase +
// resolution propagation, and a reproducible/undoable operation log. The contract
// is shaped so BOTH a jj impl (Wave 1, jj-lib as the state authority — never CLI
// text-parsing per the §7 guardrail) AND a git fallback impl satisfy it. The
// BOUNDARY (§2): conflicted states stay LOCAL to the runner; only resolved,
// git-compatible refs are exported for the host — `exportCleanGitRef` REFUSES a
// ref that still carries an unresolved conflict. This directly closes the live
// apex stall (a merge-queue conflict the resolver never engaged) by making
// "work is never discarded" a property of the core, not a hoped-for behavior.

import type { Finding } from "./findings.js";

/**
 * A handle to a runner-local workspace (an opened working copy). Opaque to
 * callers: the impl (jj or git) owns what is inside. Threaded through every op so
 * the seam is stateless at the contract level (the impl holds the working copy).
 */
export interface WorkspaceHandle {
  /** The workspace's stable id (also the operation-log scope for `opUndo`). */
  workspaceId: string;
  /** The runner-local path of the working copy (diagnostics + host export). */
  path: string;
}

/** Input to opening a workspace by cloning/importing a repo at a base branch. */
export interface OpenWorkspaceInput {
  repoUrl: string;
  baseBranch: string;
  /** The runner-local destination path for the working copy. */
  path: string;
}

/** A recorded conflict from a rebase that conflicted but SUCCEEDED (§2). */
export interface RecordedConflict {
  /** Stable id of this conflict (so resolution + restack reference it). */
  conflictId: string;
  /** The two sides in tension (ancestor/dependent specs, for intent-preserving resolve). */
  between: { specId: string; otherSpecId: string };
  /** The conflicted paths, for the resolver + diagnostics. */
  paths: ReadonlyArray<string>;
}

/**
 * The outcome of `rebaseOnto`. CRITICAL (§2, first-class conflicts): a rebase that
 * conflicts SUCCEEDS — `outcome: 'conflicted'` is a SUCCESS that RECORDS the
 * conflict in the commit, NOT a thrown error and NOT a discarded rebase. `clean`
 * means the rebase applied with no conflict. Either way the work survives.
 */
export interface RebaseResult {
  outcome: "clean" | "conflicted";
  /** The branch head after the rebase (carries the recorded conflict when conflicted). */
  headSha: string;
  /** Present on `conflicted`: the recorded conflict the resolver will engage. */
  conflict?: RecordedConflict;
}

/** Input to resolving a recorded conflict with the intent-preserving resolution. */
export interface ResolveConflictInput {
  workspace: WorkspaceHandle;
  /** The branch carrying the recorded conflict (explicit — never implicit-current). */
  branch: string;
  conflictId: string;
  /** The per-path resolved content the resolver produced (intent + vision preserving). */
  resolutions: ReadonlyArray<{ path: string; content: string }>;
}

/**
 * The result of restacking descendants after an ancestor was resolved/landed. jj
 * auto-restacks the whole stack and PROPAGATES the resolution down; this reports
 * which descendant branches were restacked and whether any still carry a conflict.
 */
export interface RestackResult {
  restacked: ReadonlyArray<{ branch: string; headSha: string }>;
  /** Descendants that STILL carry an unresolved conflict after propagation. */
  stillConflicted: ReadonlyArray<RecordedConflict>;
}

/**
 * The `WorkspaceVcsCore` contract. Every op is local to the runner workspace; NO op
 * here touches the host (that is `CodeHost`). The impl owns the VCS backend (jj —
 * preferred, Wave 1; git — fallback). A Wave-1 impl is validated against
 * `workspaceVcsCoreConformance` (the behaviors below are the acceptance criteria).
 */
export interface WorkspaceVcsCore {
  /** Clone/import a repo at `baseBranch` into a runner-local working copy. */
  openWorkspace(input: OpenWorkspaceInput): Promise<WorkspaceHandle>;

  /**
   * Create a branch `name` at `atBranch`'s head (or the current head when
   * `atBranch` is omitted) AND check it out as current. Naming the parent
   * explicitly is what makes a stack A→B→C expressible: branch B at A, branch C at
   * B records the ancestor→descendant edges restack propagation walks.
   */
  branch(workspace: WorkspaceHandle, name: string, atBranch?: string): Promise<void>;

  /** Check out `branch` as the current branch (explicit stack navigation). */
  checkout(workspace: WorkspaceHandle, branch: string): Promise<void>;

  /** Commit the working changes on the current branch; returns the new head sha. */
  commit(workspace: WorkspaceHandle, message: string): Promise<{ headSha: string }>;

  /**
   * Rebase `branch` ONTO `baseSha` (a shifted base — an ancestor landed, or an
   * unrelated spec landed). The branch is named EXPLICITLY (never implicit-current)
   * so a specific ancestor in a stack can be rebased. FIRST-CLASS conflicts (§2): a
   * rebase that conflicts SUCCEEDS and RECORDS the conflict (never throws, never
   * discards). The never-discard guarantee lives HERE.
   */
  rebaseOnto(workspace: WorkspaceHandle, branch: string, baseSha: string): Promise<RebaseResult>;

  /**
   * Resolve a recorded conflict on `input.branch` with the intent-preserving
   * resolution. The conflict transitions from recorded → resolved IN the commit;
   * the work is never recreated. After resolving an ANCESTOR, `restackDescendants`
   * propagates the resolution DOWN to its descendants.
   */
  resolveConflict(input: ResolveConflictInput): Promise<{ headSha: string }>;

  /**
   * Auto-restack the resolved branch's descendants and PROPAGATE the resolution
   * down the stack (jj-native). Reports the restacked descendants and any that
   * still carry a conflict (those are held, not bricked).
   */
  restackDescendants(workspace: WorkspaceHandle, branch: string): Promise<RestackResult>;

  /**
   * Export a resolved, git-compatible ref for the host to fetch/land. REFUSES
   * (THROWS) if the branch still carries an UNRESOLVED conflict — a conflicted ref
   * is NEVER exported to the host (the §2 boundary: conflicts stay local). This is
   * the fail-closed gate between the local core and `CodeHost`.
   */
  exportCleanGitRef(workspace: WorkspaceHandle, branch: string): Promise<{ ref: string; headSha: string }>;

  /**
   * Undo the last operation via the operation log (jj-native). Every op is
   * reproducible/undoable; this reverts the workspace to the prior operation state.
   */
  opUndo(workspace: WorkspaceHandle): Promise<void>;
}

/**
 * Adapt a {@link RecordedConflict} into the {@link Finding} currency the rest of
 * the engine reasons over (the resolver routes, `MergeAuthority` gates on
 * conflicts-resolved). A recorded conflict is a P0 finding — it must block the land
 * until resolved (fail-closed). PURE: no I/O, so it composes anywhere.
 */
export function conflictToFinding(conflict: RecordedConflict): Finding {
  return {
    id: `conflict:${conflict.conflictId}`,
    severity: "P0",
    title: `Unresolved conflict between ${conflict.between.specId} and ${conflict.between.otherSpecId}`,
    body: `Conflicted paths: ${conflict.paths.join(", ")}`,
    fixHint: "Resolve the recorded conflict (intent-preserving) before export/land.",
  };
}
