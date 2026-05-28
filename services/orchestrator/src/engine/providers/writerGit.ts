import type { SshTarget } from "../contracts/allocator.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { runWorkspaceSshCommand } from "../workspace/index.js";
import type { Commit, WriterResult } from "./types.js";

// P3-0012: shared baseline/diff/commit capture for CLI writer adapters that,
// like Codex, edit the workspace in place and let us derive the result from git
// state after the CLI exits. Codex keeps its own copy (so the Codex path is not
// refactored); new adapters (Claude, opencode) share this module.

export async function captureBaselineSha(
  ssh: SshSubstrate,
  target: SshTarget,
  workspace: string,
  timeoutMs: number
): Promise<string> {
  const result = await runWorkspaceSshCommand(ssh, target, {
    label: "capture baseline git sha",
    cwd: workspace,
    command: "git rev-parse HEAD",
    timeoutMs
  });
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`baseline git capture returned invalid sha: ${sha}`);
  }
  return sha;
}

export async function captureGitStateAfterWriter(
  ssh: SshSubstrate,
  target: SshTarget,
  workspace: string,
  baselineSha: string,
  commitMessage: string,
  timeoutMs: number
): Promise<Pick<WriterResult, "diff" | "commits">> {
  await commitWorkspaceChanges(ssh, target, workspace, commitMessage, timeoutMs);
  const diff = await runWorkspaceSshCommand(ssh, target, {
    label: "capture writer git diff",
    cwd: workspace,
    command: `git diff --no-color ${baselineSha}`,
    timeoutMs
  });
  const log = await runWorkspaceSshCommand(ssh, target, {
    label: "capture writer git commits",
    cwd: workspace,
    command: `git log --format='%H%x09%s' --reverse ${baselineSha}..HEAD`,
    timeoutMs
  });
  return { diff: diff.stdout, commits: parseGitLogCommits(log.stdout) };
}

async function commitWorkspaceChanges(
  ssh: SshSubstrate,
  target: SshTarget,
  workspace: string,
  commitMessage: string,
  timeoutMs: number
): Promise<void> {
  await runWorkspaceSshCommand(ssh, target, {
    label: "commit writer workspace changes",
    cwd: workspace,
    command: [
      "set -eu",
      "git add -A",
      "if ! git diff --cached --quiet --exit-code; then",
      `GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' git commit -m ${shellSingleQuote(commitMessage)}`,
      "fi"
    ].join("\n"),
    timeoutMs
  });
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
      if (!/^[0-9a-f]{40}$/.test(sha)) {
        throw new Error(`git commit capture returned invalid sha: ${sha}`);
      }
      if (message === "") {
        throw new Error("git commit capture returned an empty commit message");
      }
      return { sha, message };
    });
}
