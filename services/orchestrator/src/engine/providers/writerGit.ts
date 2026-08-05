import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { runWorkspaceSshCommand } from "../workspace/index.js";
import { buildActivityWatchdog } from "../ssh/activityWatchdog.js";
import { runCommitThroughProjectGate, writerExitReasonFor } from "./writerCommitGate.js";
// Re-exported so each adapter imports it from the module it ALREADY imports — the
// 500-line architecture cap leaves no room for another import line in codex/claude.
export { writerExitReasonFor };
import type { Commit, CommitRejection, WriterResult } from "./types.js";

// shared baseline/diff/commit capture for CLI writer adapters that,
// like Codex, edit the workspace in place and let us derive the result from git
// state after the CLI exits. Codex keeps its own copy (so the Codex path is not
// refactored); new adapters (Claude, opencode) share this module.
//
// These are workspace-bound VCS commands: each builds its `vcs` ActivityWatchdog
// (output-driven + workspace liveness probe) via the shared factory — never a
// wall-clock kill (feedback_no_timeouts_progress_based).

export async function captureBaselineSha(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  workspace: string,
): Promise<string> {
  const result = await runWorkspaceSshCommand(ssh, target, {
    label: "capture baseline git sha",
    cwd: workspace,
    command: "git rev-parse HEAD",
    watchdog: buildActivityWatchdog({ substrate: ssh, target, cls: "vcs", workspace }),
  });
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`baseline git capture returned invalid sha: ${sha}`);
  }
  return sha;
}

export async function captureGitStateAfterWriter(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  workspace: string,
  baselineSha: string,
  commitMessage: string,
): Promise<Pick<WriterResult, "diff" | "commits" | "commitRejection">> {
  const commitRejection = await commitWorkspaceChanges(ssh, target, workspace, commitMessage);
  // Captured even on a rejection — see the twin in codexGit.ts. `git add -A` succeeded
  // and only `git commit` was refused, so the work is still in the tree and the diff
  // against the baseline still shows it (the convergence detector's work signature).
  const diff = await runWorkspaceSshCommand(ssh, target, {
    label: "capture writer git diff",
    cwd: workspace,
    command: `git diff --no-color ${baselineSha}`,
    watchdog: buildActivityWatchdog({ substrate: ssh, target, cls: "vcs", workspace }),
  });
  const log = await runWorkspaceSshCommand(ssh, target, {
    label: "capture writer git commits",
    cwd: workspace,
    command: `git log --format='%H%x09%s' --reverse ${baselineSha}..HEAD`,
    watchdog: buildActivityWatchdog({ substrate: ssh, target, cls: "vcs", workspace }),
  });
  const state = { diff: diff.stdout, commits: parseGitLogCommits(log.stdout) };
  return commitRejection === undefined ? state : { ...state, commitRejection };
}

async function commitWorkspaceChanges(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  workspace: string,
  commitMessage: string,
): Promise<CommitRejection | undefined> {
  // Hooks stay LIVE here (this commit carries the writer's content into the PR), and the
  // hook's NO vote comes back as a VALUE (writerCommitGate.ts), not a throw, so the
  // subtask loop can re-drive the writer with it. Substrate faults still throw.
  return await runCommitThroughProjectGate(async () =>
    runWorkspaceSshCommand(ssh, target, {
      label: "commit writer workspace changes",
      cwd: workspace,
      command: [
        "set -eu",
        "git add -A",
        "if ! git diff --cached --quiet --exit-code; then",
        `GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' git commit -m ${shellSingleQuote(commitMessage)}`,
        "fi",
      ].join("\n"),
      watchdog: buildActivityWatchdog({ substrate: ssh, target, cls: "vcs", workspace }),
    }),
  );
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function parseGitLogCommits(stdout: string): Commit[] {
  return stdout
    .trimEnd()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const separator = line.indexOf("\t");
      if (separator === -1) {
        throw new Error("git commit capture did not include sha/message separator");
      }
      const sha = line.slice(0, separator);
      const message = line.slice(separator + 1);
      if (!/^[0-9a-f]{40}$/u.test(sha)) {
        throw new Error(`git commit capture returned invalid sha: ${sha}`);
      }
      if (message === "") {
        throw new Error("git commit capture returned an empty commit message");
      }
      return { sha, message };
    });
}
