// The SSH/git-backed WorkspaceConflictApplier (autonomy-engine.md §2b step 2 +
// the apply step). The VcsProvider's `updateBranch` only tells us a conflict
// EXISTS; to resolve while preserving intent the Answerer needs the actual hunks, so
// here we perform the merge of the base branch INTO the PR branch over the runner
// workspace and read the conflicted files back WITH their markers. After the
// Answerer resolves, we write the resolved contents into the SAME tree (markers
// removed) and re-gate before publishing — never pushing an unverified tree.
//
// The git operations run over the existing CommandSubstrate seam in the run's
// workspace (the same path the writer/gate/push use). `gather` runs `git merge`
// WITHOUT throwing on the expected non-zero conflict exit (it reads the conflict
// state instead); the other operations use the throwing helper since a failure
// there is a real fault.

import type { RunnerHandle } from "../../../contracts/allocator.js";
import type { CommandSubstrate } from "../../../contracts/commandSubstrate.js";
import type {
  ConflictedFile,
  GatheredConflict,
  WorkspaceConflictApplier,
} from "../../../contracts/conflictResolution.js";
import { runWorkspaceSshCommand } from "../../../workspace/ssh.js";

export interface SshConflictApplierDeps {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  /** The base branch to merge into the PR branch to surface the hunks. */
  baseBranch: string;
  /** The PR/run branch the resolution is published onto. */
  headBranch: string;
  timeoutMs: number;
}

export class SshWorkspaceConflictApplier implements WorkspaceConflictApplier {
  constructor(private readonly deps: SshConflictApplierDeps) {}

  async gather(): Promise<GatheredConflict> {
    const { ssh, target, workspacePath, baseBranch, timeoutMs } = this.deps;
    // Fetch + attempt the merge of base into the working tree. The merge exits
    // non-zero on a conflict (expected), so we DON'T use the throwing helper —
    // we read the conflict state directly afterward.
    await ssh.run(target, {
      cwd: workspacePath,
      command: [
        "set -u",
        "git fetch origin " + shellSingleQuote(baseBranch) + " || true",
        // A non-fast-forward merge with conflicts leaves the tree with markers;
        // a clean merge exits 0 (no conflict to gather). `|| true` keeps going.
        "git merge --no-edit --no-ff FETCH_HEAD || true",
      ].join("\n"),
      timeoutMs,
    });
    const namesResult = await ssh.run(target, {
      cwd: workspacePath,
      command: "git diff --name-only --diff-filter=U",
      timeoutMs,
    });
    const paths = (namesResult.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const files: ConflictedFile[] = [];
    for (const path of paths) {
      const content = await runWorkspaceSshCommand(ssh, target, {
        label: `conflict gather: read ${path}`,
        cwd: workspacePath,
        // Read the working-tree file (conflict markers intact).
        command: `cat -- ${shellSingleQuote(path)}`,
        timeoutMs,
      });
      files.push({ path, conflictedContent: content.stdout });
    }
    return { files };
  }

  async applyResolution(resolved: ReadonlyArray<{ path: string; content: string }>): Promise<void> {
    const { ssh, target, workspacePath, timeoutMs } = this.deps;
    for (const file of resolved) {
      await runWorkspaceSshCommand(ssh, target, {
        label: `conflict apply: write ${file.path}`,
        cwd: workspacePath,
        // Write the resolved content via stdin → the file, then stage it.
        command: `cat > ${shellSingleQuote(file.path)} && git add -- ${shellSingleQuote(file.path)}`,
        stdin: file.content,
        timeoutMs,
      });
    }
  }

  async publishResolved(): Promise<void> {
    const { ssh, target, workspacePath, headBranch, timeoutMs } = this.deps;
    await runWorkspaceSshCommand(ssh, target, {
      label: "conflict publish: commit + push resolved tree",
      cwd: workspacePath,
      command: [
        "set -eu",
        // Conclude the in-progress merge with the staged resolution.
        "GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' git commit --no-edit -m 'Tanren: intent-preserving conflict resolution'",
        `git push origin HEAD:${shellSingleQuote(headBranch)}`,
      ].join("\n"),
      timeoutMs,
    });
  }

  async abort(): Promise<void> {
    const { ssh, target, workspacePath, timeoutMs } = this.deps;
    // Abandon the in-progress merge so the workspace is clean for any retry. The
    // merge may not be in progress (a no-op abort is fine), so don't throw.
    await ssh.run(target, {
      cwd: workspacePath,
      command: "git merge --abort || true",
      timeoutMs,
    });
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
