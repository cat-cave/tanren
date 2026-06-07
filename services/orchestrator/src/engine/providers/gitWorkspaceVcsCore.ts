// The git FALLBACK implementation of the `WorkspaceVcsCore` seam
// (engine/contracts/workspaceVcsCore.ts, tanren-owns-the-engine.md §2), for
// environments without jj. jj is the PREFERRED Wave-1 path
// ({@link JjWorkspaceVcsCore}) because its first-class conflicts make "a conflict
// must never brick" true BY CONSTRUCTION; this impl reproduces the SAME contract
// guarantees over plain git, which is universally available.
//
// FIRST-CLASS CONFLICTS over git (the hard part jj gives for free): git rebase
// ABORTS on conflict. So instead of `git rebase`, this impl uses
// `git merge-tree --write-tree` (git ≥ 2.38): a 3-way merge that NEVER touches the
// working tree, ALWAYS produces a tree, and reports the conflicted paths on a
// nonzero exit. On conflict we COMMIT the conflicted tree (markers and all) as the
// branch's new tip and record the conflict in a sidecar ref — the work survives, the
// rebase "succeeds", exactly the contract's §2 guarantee. `exportCleanGitRef`
// REFUSES while that sidecar marks the branch conflicted (fail-closed).
//
// SUBSTRATE: shells `git` through the same {@link CommandSubstrate} the runner
// workspace code uses (engine/workspace/githubPush.ts). COMMIT MATERIALIZATION
// ({@link GitCommitMutator}) is injectable so a `commit` makes a real, content-bearing
// change (production passes the runner's staged working tree; the conformance fixture
// passes a deterministic edit) WITHOUT the engine hard-coding any path.

import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type {
  OpenWorkspaceInput,
  RebaseResult,
  RecordedConflict,
  ResolveConflictInput,
  RestackResult,
  WorkspaceHandle,
  WorkspaceVcsCore,
} from "../contracts/workspaceVcsCore.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { runWorkspaceSshCommand } from "../workspace/ssh.js";

/**
 * Resolves the contract's caller identifiers onto the concrete clone source + git
 * revisions. Production uses {@link identityGitRefResolver}; the conformance harness
 * maps the suite's synthetic tokens onto a local fixture repo's refs.
 */
export interface GitRefResolver {
  cloneSource(repoUrl: string): string;
  baseRevision(baseSha: string): string;
}

export const identityGitRefResolver: GitRefResolver = {
  cloneSource: (repoUrl) => repoUrl,
  baseRevision: (baseSha) => baseSha,
};

/**
 * Materializes a `commit` as a real working-tree change before it is committed.
 * Production stages the runner's working tree (a no-op shell). The conformance
 * fixture writes a deterministic edit so a later rebase exercises a REAL 3-way
 * merge — the engine never hard-codes the path/content.
 */
export type GitCommitMutator = (message: string) => string[];

/**
 * Production mutator: the working tree is ALREADY staged by the caller (the runner's
 * writer wrote the diff), so a `commit` adds no extra edit — it just commits the
 * staged tree. This is the live default, not a stand-in.
 */
export const stagedWorkingTreeCommitMutator: GitCommitMutator = () => [];

export interface GitWorkspaceVcsCoreDeps {
  substrate: CommandSubstrate;
  target: RunnerHandle;
  timeoutMs: number;
  refResolver?: GitRefResolver;
  commitMutator?: GitCommitMutator;
}

interface GitWorkspaceState {
  path: string;
  currentBranch: string;
  /**
   * The ancestor→descendant edges (child branch → parent branch). Tracked
   * EXPLICITLY (not inferred from git ancestry) because resolve/rebase rewrite
   * commits and break commit-ancestry — this is the stable stack graph restack
   * propagation walks, exactly as jj tracks change parentage.
   */
  parents: Map<string, string>;
  /**
   * Per branch, the parent's tip sha at the moment this branch was last stacked on
   * it. It is the 3-way MERGE-BASE a restack uses to replay the child's OWN diff
   * onto the parent's rewritten tip (so an ancestor's rewrite — a resolve — does not
   * re-introduce the child's now-stale view of the parent).
   */
  baseShaOf: Map<string, string>;
}

// The ref namespace that records a branch's conflicted paths (one per line in the
// blob). Absence ⇒ the branch is clean. This is the git stand-in for jj's
// commit-embedded conflict state.
const CONFLICT_NOTE_PREFIX = "refs/tanren-conflict";

export class GitWorkspaceVcsCore implements WorkspaceVcsCore {
  private readonly substrate: CommandSubstrate;
  private readonly target: RunnerHandle;
  private readonly timeoutMs: number;
  private readonly refResolver: GitRefResolver;
  private readonly commitMutator: GitCommitMutator;
  private readonly workspaces = new Map<string, GitWorkspaceState>();
  private readonly opLog = new Map<string, string[]>();
  private seq = 0;

  constructor(deps: GitWorkspaceVcsCoreDeps) {
    this.substrate = deps.substrate;
    this.target = deps.target;
    this.timeoutMs = deps.timeoutMs;
    this.refResolver = deps.refResolver ?? identityGitRefResolver;
    this.commitMutator = deps.commitMutator ?? stagedWorkingTreeCommitMutator;
  }

  async openWorkspace(input: OpenWorkspaceInput): Promise<WorkspaceHandle> {
    const workspaceId = `gitws_${++this.seq}`;
    const source = this.refResolver.cloneSource(input.repoUrl);
    await this.run(input.path, [
      `git clone --quiet ${quoteSshShellArg(source)} ${quoteSshShellArg(input.path)}`,
      // Deterministic author/committer so re-commits of identical trees are stable.
      `git config user.email tanren@local`,
      `git config user.name Tanren`,
      `git checkout --quiet ${quoteSshShellArg(input.baseBranch)}`,
    ]);
    this.workspaces.set(workspaceId, {
      path: input.path,
      currentBranch: input.baseBranch,
      parents: new Map(),
      baseShaOf: new Map(),
    });
    this.opLog.set(workspaceId, []);
    return { workspaceId, path: input.path };
  }

  async branch(workspace: WorkspaceHandle, name: string, atBranch?: string): Promise<void> {
    const st = this.require(workspace);
    const parent = atBranch ?? st.currentBranch;
    await this.run(st.path, [`git checkout --quiet -B ${quoteSshShellArg(name)} ${quoteSshShellArg(parent)}`]);
    // A branch created on a conflicted ancestor INHERITS that conflict (a real stack:
    // the descendant is built on broken state until restack propagation clears it).
    const inherited = await this.conflictPaths(st.path, parent);
    if (inherited.length > 0) {
      await this.writeConflictNote(st.path, name, inherited);
    }
    st.parents.set(name, parent);
    st.baseShaOf.set(name, await this.headSha(st.path, parent));
    st.currentBranch = name;
  }

  async checkout(workspace: WorkspaceHandle, branch: string): Promise<void> {
    const st = this.require(workspace);
    await this.run(st.path, [`git checkout --quiet ${quoteSshShellArg(branch)}`]);
    st.currentBranch = branch;
  }

  async commit(workspace: WorkspaceHandle, message: string): Promise<{ headSha: string }> {
    const st = this.require(workspace);
    await this.snapshotBefore(workspace, st.currentBranch);
    await this.run(st.path, [
      `git checkout --quiet ${quoteSshShellArg(st.currentBranch)}`,
      ...this.commitMutator(message),
      `git add -A`,
      `git commit --quiet --allow-empty -m ${quoteSshShellArg(message)}`,
    ]);
    return { headSha: await this.headSha(st.path, st.currentBranch) };
  }

  async rebaseOnto(workspace: WorkspaceHandle, branch: string, baseSha: string): Promise<RebaseResult> {
    const st = this.require(workspace);
    const base = this.refResolver.baseRevision(baseSha);
    await this.snapshotBefore(workspace, branch);
    // FIRST-CLASS conflicts: a 3-way merge-tree that NEVER aborts. It always writes a
    // tree (with conflict markers on conflict) and exits nonzero listing the
    // conflicted paths. We commit the tree onto the new base — the work survives.
    const merge = await this.runRaw(st.path, [
      `git merge-tree --write-tree --merge-base=$(git merge-base ${quoteSshShellArg(branch)} ${quoteSshShellArg(base)}) ${quoteSshShellArg(base)} ${quoteSshShellArg(branch)}`,
    ]);
    const lines = merge.stdout.split("\n");
    const tree = (lines[0] ?? "").trim();
    if (tree === "") {
      throw new Error(`git merge-tree produced no tree rebasing ${branch} onto ${baseSha}: ${merge.stderr}`);
    }
    const conflictedPaths = this.parseMergeTreeConflicts(lines.slice(1));
    const message = `rebase ${branch} onto ${baseSha}`;
    const headSha = (
      await this.runCapture(st.path, [
        `commit=$(git commit-tree ${quoteSshShellArg(tree)} -p ${quoteSshShellArg(base)} -m ${quoteSshShellArg(message)})`,
        `git update-ref refs/heads/${branch} "$commit"`,
        `printf %s "$commit"`,
      ])
    ).trim();
    if (conflictedPaths.length > 0) {
      await this.writeConflictNote(st.path, branch, conflictedPaths);
      return {
        outcome: "conflicted",
        headSha,
        conflict: this.makeConflict(branch, conflictedPaths),
      };
    }
    await this.clearConflictNote(st.path, branch);
    return { outcome: "clean", headSha };
  }

  async resolveConflict(input: ResolveConflictInput): Promise<{ headSha: string }> {
    const st = this.require(input.workspace);
    await this.snapshotBefore(input.workspace, input.branch);
    // Write the intent-preserving resolution into a new commit on the branch tip, then
    // clear the conflict note. The work is amended forward, never recreated.
    const writes = input.resolutions.map(
      (r) => `printf %s ${quoteSshShellArg(r.content)} > ${quoteSshShellArg(r.path)}`,
    );
    await this.run(st.path, [
      `git checkout --quiet ${quoteSshShellArg(input.branch)}`,
      ...writes,
      `git add -A`,
      `git commit --quiet --allow-empty -m ${quoteSshShellArg(`resolve ${input.conflictId}`)}`,
    ]);
    await this.clearConflictNote(st.path, input.branch);
    return { headSha: await this.headSha(st.path, input.branch) };
  }

  async restackDescendants(workspace: WorkspaceHandle, branch: string): Promise<RestackResult> {
    const st = this.require(workspace);
    await this.snapshotBefore(workspace, branch);
    // Walk the explicit stack graph parent-first and replay each child's OWN diff onto
    // its parent's now-rewritten tip — propagating the ancestor's resolution down. A
    // child with no own-changes simply fast-forwards to the resolved parent tip (its
    // inherited conflict clears); a child with own-changes is 3-way merged.
    const order = this.descendantOrder(st, branch);
    const restacked: Array<{ branch: string; headSha: string }> = [];
    const stillConflicted: RecordedConflict[] = [];
    for (const name of order) {
      const parent = st.parents.get(name);
      if (parent === undefined) {
        continue;
      }
      const newParentTip = await this.headSha(st.path, parent);
      const oldBase = st.baseShaOf.get(name) ?? newParentTip;
      // 3-way: merge-base = the parent tip the child was stacked on (oldBase); replay
      // the child onto the parent's new tip. With no own-changes this yields the new
      // parent tree (a clean fast-forward).
      const merge = await this.runRaw(st.path, [
        `git merge-tree --write-tree --merge-base=${quoteSshShellArg(oldBase)} ${quoteSshShellArg(newParentTip)} ${quoteSshShellArg(name)}`,
      ]);
      const lines = merge.stdout.split("\n");
      const tree = (lines[0] ?? "").trim();
      const conflictedPaths = this.parseMergeTreeConflicts(lines.slice(1));
      const headSha = (
        await this.runCapture(st.path, [
          `commit=$(git commit-tree ${quoteSshShellArg(tree)} -p ${quoteSshShellArg(newParentTip)} -m ${quoteSshShellArg(`restack ${name}`)})`,
          `git update-ref refs/heads/${name} "$commit"`,
          `printf %s "$commit"`,
        ])
      ).trim();
      st.baseShaOf.set(name, newParentTip);
      restacked.push({ branch: name, headSha });
      if (conflictedPaths.length > 0) {
        await this.writeConflictNote(st.path, name, conflictedPaths);
        stillConflicted.push(this.makeConflict(name, conflictedPaths));
      } else {
        await this.clearConflictNote(st.path, name);
      }
    }
    return { restacked, stillConflicted };
  }

  // The transitive descendants of `branch` in the explicit stack graph, ordered
  // parent-before-child (a BFS so a parent is always restacked before its children).
  private descendantOrder(st: GitWorkspaceState, branch: string): string[] {
    const order: string[] = [];
    const queue = [branch];
    while (queue.length > 0) {
      const cur = queue.shift();
      if (cur === undefined) {
        continue;
      }
      for (const [child, parent] of st.parents) {
        if (parent === cur && !order.includes(child)) {
          order.push(child);
          queue.push(child);
        }
      }
    }
    return order;
  }

  async exportCleanGitRef(workspace: WorkspaceHandle, branch: string): Promise<{ ref: string; headSha: string }> {
    const st = this.require(workspace);
    // Fail-closed §2 boundary: NEVER export a ref the sidecar marks conflicted.
    const conflicts = await this.conflictPaths(st.path, branch);
    if (conflicts.length > 0) {
      throw new Error(`refusing to export ${branch}: unresolved conflict on ${conflicts.join(", ")}`);
    }
    return { ref: `refs/heads/${branch}`, headSha: await this.headSha(st.path, branch) };
  }

  async opUndo(workspace: WorkspaceHandle): Promise<void> {
    const st = this.require(workspace);
    const log = this.opLog.get(workspace.workspaceId) ?? [];
    const prior = log.pop();
    if (prior === undefined) {
      return;
    }
    // Each op-log entry is `<branch>\t<priorSha>`; restore that ref to its prior tip.
    const [branch, sha] = prior.split("\t");
    if (branch !== undefined && branch !== "" && sha !== undefined && sha !== "") {
      await this.run(st.path, [`git update-ref refs/heads/${branch} ${quoteSshShellArg(sha)}`]);
    }
  }

  // Snapshot the branch's current tip BEFORE an op mutates it, so opUndo can restore
  // it. AWAITED at the top of every mutating op (never fire-and-forget — the read
  // must complete before the mutation moves the ref).
  private async snapshotBefore(workspace: WorkspaceHandle, branch: string): Promise<void> {
    const st = this.require(workspace);
    const log = this.opLog.get(workspace.workspaceId);
    if (log === undefined) {
      return;
    }
    const current = await this.runRaw(st.path, [`git rev-parse --verify --quiet refs/heads/${branch} || true`]);
    log.push(`${branch}\t${current.stdout.trim()}`);
  }

  private async headSha(path: string, branch: string): Promise<string> {
    return (await this.runCapture(path, [`git rev-parse ${quoteSshShellArg(branch)}`])).trim();
  }

  // Parse `git merge-tree --write-tree`'s conflict report. Line 0 (the tree oid) is
  // stripped by the caller. The rest is the "Conflicted file info" section: each
  // entry is `<mode> <oid> <stage>\t<path>` with stage 1/2/3 (base/ours/theirs).
  // The presence of ANY stage entry is the authoritative conflict signal; we collect
  // the distinct conflicted paths.
  private parseMergeTreeConflicts(lines: string[]): string[] {
    const paths = new Set<string>();
    for (const raw of lines) {
      // `<mode> <oid> <stage>\t<path>` — a tab separates the metadata from the path.
      const tab = raw.indexOf("\t");
      if (tab < 0) {
        continue;
      }
      const meta = raw.slice(0, tab).trim().split(/\s+/u);
      const path = raw.slice(tab + 1).trim();
      // A valid stage entry has exactly mode/oid/stage and a nonzero stage number.
      if (meta.length === 3 && /^[0-7]{6}$/u.test(meta[0] ?? "") && /^[123]$/u.test(meta[2] ?? "") && path !== "") {
        paths.add(path);
      }
    }
    return [...paths];
  }

  private makeConflict(branch: string, paths: string[]): RecordedConflict {
    return {
      conflictId: `cfl_${branch}_${++this.seq}`,
      between: { specId: branch, otherSpecId: "base" },
      paths,
    };
  }

  private async writeConflictNote(path: string, branch: string, paths: string[]): Promise<void> {
    const blob = paths.join("\n");
    await this.run(path, [
      `oid=$(printf %s ${quoteSshShellArg(blob)} | git hash-object -w --stdin)`,
      `git update-ref ${CONFLICT_NOTE_PREFIX}/${branch} "$oid"`,
    ]);
  }

  private async clearConflictNote(path: string, branch: string): Promise<void> {
    await this.run(path, [`git update-ref -d ${CONFLICT_NOTE_PREFIX}/${branch} 2>/dev/null || true`]);
  }

  private async conflictPaths(path: string, branch: string): Promise<string[]> {
    const out = await this.runRaw(path, [`git cat-file -p ${CONFLICT_NOTE_PREFIX}/${branch} 2>/dev/null || true`]);
    return out.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
  }

  private async run(path: string, commands: string[]): Promise<void> {
    await runWorkspaceSshCommand(this.substrate, this.target, {
      label: `git ${commands[0] ?? ""}`,
      cwd: path,
      timeoutMs: this.timeoutMs,
      command: ["set -eu", ...commands].join("\n"),
    });
  }

  private async runCapture(path: string, commands: string[]): Promise<string> {
    const result = await runWorkspaceSshCommand(this.substrate, this.target, {
      label: `git ${commands[0] ?? ""}`,
      cwd: path,
      timeoutMs: this.timeoutMs,
      command: ["set -eu", ...commands].join("\n"),
    });
    return result.stdout;
  }

  private async runRaw(path: string, commands: string[]): Promise<{ stdout: string; stderr: string }> {
    const result = await this.substrate.run(this.target, {
      command: commands.join("\n"),
      cwd: path,
      timeoutMs: this.timeoutMs,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  }

  private require(workspace: WorkspaceHandle): GitWorkspaceState {
    const st = this.workspaces.get(workspace.workspaceId);
    if (st === undefined) {
      throw new Error(`unknown git workspace ${workspace.workspaceId}`);
    }
    return st;
  }
}
