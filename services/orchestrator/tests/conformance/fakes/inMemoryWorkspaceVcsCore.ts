// A TRIVIAL in-memory reference fake of `WorkspaceVcsCore`
// (`engine/contracts/workspaceVcsCore.ts`) — ONLY to make the
// `workspaceVcsCoreConformance` suite self-runnable in Wave 0. It is NOT a real VCS
// backend: it models JUST the first-class-conflict behaviors the contract pins (a
// conflicting rebase SUCCEEDS + records a conflict; resolve + restack propagate;
// export refuses a conflicted ref; opUndo reverts). The Wave-1 jj/git impls drive
// the SAME suite — this fake exists so the contract behaviors are executable today.
//
// A "conflict" is simulated deterministically: rebasing onto a base sha that starts
// with `conflict-` records a conflict (no real merge engine). Fixtures live HERE,
// never src/.

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
  /** Descendants restacked onto this branch (for restack propagation). */
  descendants: string[];
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
    copy.set(name, { headSha: b.headSha, conflict: b.conflict, descendants: [...b.descendants] });
  }
  return copy;
}

export class InMemoryWorkspaceVcsCore implements WorkspaceVcsCore {
  private readonly workspaces = new Map<string, WorkspaceState>();
  private seq = 0;

  async openWorkspace(input: OpenWorkspaceInput): Promise<WorkspaceHandle> {
    const workspaceId = `ws_${++this.seq}`;
    this.workspaces.set(workspaceId, {
      branches: new Map([[input.baseBranch, { headSha: `sha-${input.baseBranch}`, descendants: [] }]]),
      currentBranch: input.baseBranch,
      opLog: [],
    });
    return { workspaceId, path: input.path };
  }

  async branch(workspace: WorkspaceHandle, name: string): Promise<void> {
    const st = this.require(workspace);
    this.commitOp(st);
    const head = st.branches.get(st.currentBranch);
    st.branches.set(name, { headSha: head?.headSha ?? `sha-${name}`, descendants: [] });
    head?.descendants.push(name);
    st.currentBranch = name;
  }

  async commit(workspace: WorkspaceHandle, _message: string): Promise<{ headSha: string }> {
    const st = this.require(workspace);
    this.commitOp(st);
    const head = st.branches.get(st.currentBranch);
    if (head === undefined) throw new Error("no current branch");
    head.headSha = `sha-${++this.seq}`;
    return { headSha: head.headSha };
  }

  async rebaseOnto(workspace: WorkspaceHandle, baseSha: string): Promise<RebaseResult> {
    const st = this.require(workspace);
    this.commitOp(st);
    const head = st.branches.get(st.currentBranch);
    if (head === undefined) throw new Error("no current branch");
    // First-class conflicts: a conflicting rebase SUCCEEDS + records the conflict.
    if (baseSha.startsWith("conflict-")) {
      const conflict: RecordedConflict = {
        conflictId: `cfl_${++this.seq}`,
        between: { specId: st.currentBranch, otherSpecId: baseSha },
        paths: ["src/conflicted.ts"],
      };
      head.conflict = conflict;
      head.headSha = `sha-rebased-${++this.seq}`;
      return { outcome: "conflicted", headSha: head.headSha, conflict };
    }
    head.headSha = `sha-rebased-${++this.seq}`;
    return { outcome: "clean", headSha: head.headSha };
  }

  async resolveConflict(input: ResolveConflictInput): Promise<{ headSha: string }> {
    const st = this.require(input.workspace);
    this.commitOp(st);
    const head = st.branches.get(st.currentBranch);
    if (head === undefined || head.conflict?.conflictId !== input.conflictId) {
      throw new Error("no matching recorded conflict to resolve");
    }
    // The conflict is resolved IN the commit (never recreated).
    head.conflict = undefined;
    head.headSha = `sha-resolved-${++this.seq}`;
    return { headSha: head.headSha };
  }

  async restackDescendants(workspace: WorkspaceHandle, branch: string): Promise<RestackResult> {
    const st = this.require(workspace);
    this.commitOp(st);
    const parent = st.branches.get(branch);
    const restacked: Array<{ branch: string; headSha: string }> = [];
    const stillConflicted: RecordedConflict[] = [];
    for (const name of parent?.descendants ?? []) {
      const d = st.branches.get(name);
      if (d === undefined) continue;
      // Resolution PROPAGATES down: a descendant inherits the resolved state.
      d.conflict = undefined;
      d.headSha = `sha-restacked-${++this.seq}`;
      restacked.push({ branch: name, headSha: d.headSha });
      if (d.conflict !== undefined) stillConflicted.push(d.conflict);
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

  private commitOp(st: WorkspaceState): void {
    st.opLog.push(snapshot(st.branches));
  }

  private require(workspace: WorkspaceHandle): WorkspaceState {
    const st = this.workspaces.get(workspace.workspaceId);
    if (st === undefined) throw new Error(`unknown workspace ${workspace.workspaceId}`);
    return st;
  }
}
