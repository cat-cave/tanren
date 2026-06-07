// A TRIVIAL in-memory reference fake of `WorkspaceVcsCore`
// (`engine/contracts/workspaceVcsCore.ts`) — ONLY to make the
// `workspaceVcsCoreConformance` suite self-runnable in Wave 0. It is NOT a real VCS
// backend: it models JUST the first-class-conflict + stack behaviors the contract
// pins (a conflicting rebase SUCCEEDS + records a conflict; resolving an ANCESTOR +
// restack propagates the resolution to descendants; export refuses a conflicted
// ref; opUndo reverts). The Wave-1 jj/git impls drive the SAME suite.
//
// A "conflict" is simulated deterministically: rebasing onto a base sha that starts
// with `conflict-` records a conflict (no real merge engine). Branch parentage is
// tracked explicitly (the `parent` edge) so a stack A→B→C is real, and an
// ancestor's recorded conflict PROPAGATES to its descendants until restack clears
// it. Fixtures live HERE, never src/.

import type {
  OpenWorkspaceInput,
  RebaseResult,
  RecordedConflict,
  ResolveConflictInput,
  RestackResult,
  WorkspaceHandle,
  WorkspaceVcsCore,
} from "../../../src/engine/contracts/workspaceVcsCore.js";

interface BranchState {
  headSha: string;
  /** The currently-unresolved conflict on this branch, if any. */
  conflict?: RecordedConflict;
  /** The parent branch this one stacks on (undefined for the base). */
  parent?: string;
}

interface WorkspaceState {
  branches: Map<string, BranchState>;
  currentBranch: string;
  /** The operation log: each entry is a snapshot to restore on `opUndo`. */
  opLog: Array<Map<string, BranchState>>;
}

function snapshot(branches: Map<string, BranchState>): Map<string, BranchState> {
  const copy = new Map<string, BranchState>();
  for (const [name, b] of branches) {
    copy.set(name, { headSha: b.headSha, conflict: b.conflict, parent: b.parent });
  }
  return copy;
}

export class InMemoryWorkspaceVcsCore implements WorkspaceVcsCore {
  private readonly workspaces = new Map<string, WorkspaceState>();
  private seq = 0;

  async openWorkspace(input: OpenWorkspaceInput): Promise<WorkspaceHandle> {
    const workspaceId = `ws_${++this.seq}`;
    this.workspaces.set(workspaceId, {
      branches: new Map([[input.baseBranch, { headSha: `sha-${input.baseBranch}` }]]),
      currentBranch: input.baseBranch,
      opLog: [],
    });
    return { workspaceId, path: input.path };
  }

  async branch(workspace: WorkspaceHandle, name: string, atBranch?: string): Promise<void> {
    const st = this.require(workspace);
    this.commitOp(st);
    const parentName = atBranch ?? st.currentBranch;
    const parent = st.branches.get(parentName);
    // A branch created on a conflicted ancestor INHERITS that conflict (a real
    // stack: the descendant is built on broken state until restack propagates).
    st.branches.set(name, {
      headSha: parent?.headSha ?? `sha-${name}`,
      parent: parentName,
      conflict: parent?.conflict,
    });
    st.currentBranch = name;
  }

  async checkout(workspace: WorkspaceHandle, branch: string): Promise<void> {
    const st = this.require(workspace);
    if (!st.branches.has(branch)) throw new Error(`no such branch: ${branch}`);
    st.currentBranch = branch;
  }

  async commit(workspace: WorkspaceHandle, _message: string): Promise<{ headSha: string }> {
    const st = this.require(workspace);
    this.commitOp(st);
    const head = st.branches.get(st.currentBranch);
    if (head === undefined) throw new Error("no current branch");
    head.headSha = `sha-${++this.seq}`;
    return { headSha: head.headSha };
  }

  async rebaseOnto(workspace: WorkspaceHandle, branch: string, baseSha: string): Promise<RebaseResult> {
    const st = this.require(workspace);
    this.commitOp(st);
    const b = st.branches.get(branch);
    if (b === undefined) throw new Error(`no such branch: ${branch}`);
    // First-class conflicts: a conflicting rebase SUCCEEDS + records the conflict.
    if (baseSha.startsWith("conflict-")) {
      const conflict: RecordedConflict = {
        conflictId: `cfl_${++this.seq}`,
        between: { specId: branch, otherSpecId: baseSha },
        paths: ["src/conflicted.ts"],
      };
      b.conflict = conflict;
      b.headSha = `sha-rebased-${++this.seq}`;
      return { outcome: "conflicted", headSha: b.headSha, conflict };
    }
    b.headSha = `sha-rebased-${++this.seq}`;
    return { outcome: "clean", headSha: b.headSha };
  }

  async resolveConflict(input: ResolveConflictInput): Promise<{ headSha: string }> {
    const st = this.require(input.workspace);
    this.commitOp(st);
    const b = st.branches.get(input.branch);
    if (b === undefined || b.conflict?.conflictId !== input.conflictId) {
      throw new Error("no matching recorded conflict to resolve");
    }
    // The conflict is resolved IN the commit (never recreated).
    b.conflict = undefined;
    b.headSha = `sha-resolved-${++this.seq}`;
    return { headSha: b.headSha };
  }

  async restackDescendants(workspace: WorkspaceHandle, branch: string): Promise<RestackResult> {
    const st = this.require(workspace);
    this.commitOp(st);
    const restacked: Array<{ branch: string; headSha: string }> = [];
    const stillConflicted: RecordedConflict[] = [];
    // Walk every transitive descendant of `branch`; PROPAGATE the resolved ancestor
    // state down — a descendant whose only conflict was the inherited one clears.
    for (const [name, b] of st.branches) {
      if (!this.isDescendantOf(st, name, branch)) continue;
      const ancestor = b.parent === undefined ? undefined : st.branches.get(b.parent);
      if (ancestor?.conflict === undefined) {
        b.conflict = undefined;
      }
      b.headSha = `sha-restacked-${++this.seq}`;
      restacked.push({ branch: name, headSha: b.headSha });
      if (b.conflict !== undefined) stillConflicted.push(b.conflict);
    }
    return { restacked, stillConflicted };
  }

  async exportCleanGitRef(workspace: WorkspaceHandle, branch: string): Promise<{ ref: string; headSha: string }> {
    const st = this.require(workspace);
    const b = st.branches.get(branch);
    if (b === undefined) throw new Error(`no such branch: ${branch}`);
    // The §2 boundary: NEVER export a conflicted ref to the host.
    if (b.conflict !== undefined) {
      throw new Error(`refusing to export ${branch}: unresolved conflict ${b.conflict.conflictId}`);
    }
    return { ref: `refs/heads/${branch}`, headSha: b.headSha };
  }

  async opUndo(workspace: WorkspaceHandle): Promise<void> {
    const st = this.require(workspace);
    const prior = st.opLog.pop();
    if (prior !== undefined) st.branches = prior;
  }

  /** Whether `name` is a transitive descendant of `ancestor` (not itself). */
  private isDescendantOf(st: WorkspaceState, name: string, ancestor: string): boolean {
    let cur = st.branches.get(name)?.parent;
    while (cur !== undefined) {
      if (cur === ancestor) return true;
      cur = st.branches.get(cur)?.parent;
    }
    return false;
  }

  private commitOp(st: WorkspaceState): void {
    st.opLog.push(snapshot(st.branches));
  }

  private require(workspace: WorkspaceHandle): WorkspaceState {
    const st = this.workspaces.get(workspace.workspaceId);
    if (st === undefined) throw new Error(`unknown workspace ${workspace.workspaceId}`);
    return st;
  }
}
