/**
 * codexGit — the workspace git-state helpers used by the Codex writer adapter.
 * Extracted from codex.ts to keep that file under the 500-line architecture
 * cap. These run over the runner SSH substrate to capture the baseline sha,
 * commit the writer's changes, and diff/log the result into a WriterResult.
 */
import type { SshTarget } from "../contracts/allocator.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { runWorkspaceSshCommand } from "../workspace/index.js";
import type { Commit, WriterResult } from "./types.js";

export async function captureBaselineSha(
  ssh: SshSubstrate,
  target: SshTarget,
  workspace: string,
  timeoutMs: number,
): Promise<string> {
  const result = await runWorkspaceSshCommand(ssh, target, {
    label: "capture baseline git sha",
    cwd: workspace,
    command: "git rev-parse HEAD",
    timeoutMs,
  });
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`baseline git capture returned invalid sha: ${sha}`);
  }
  return sha;
}

async function commitWorkspaceChangesAfterCodex(
  ssh: SshSubstrate,
  target: SshTarget,
  workspace: string,
  timeoutMs: number,
): Promise<void> {
  await runWorkspaceSshCommand(ssh, target, {
    label: "commit codex workspace changes",
    cwd: workspace,
    command: [
      "set -eu",
      "git add -A",
      "if ! git diff --cached --quiet --exit-code; then",
      "GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' git commit -m 'codex writer'",
      "fi",
    ].join("\n"),
    timeoutMs,
  });
}

export async function captureGitStateAfterCodex(
  ssh: SshSubstrate,
  target: SshTarget,
  workspace: string,
  baselineSha: string,
  timeoutMs: number,
): Promise<Pick<WriterResult, "diff" | "commits">> {
  await commitWorkspaceChangesAfterCodex(ssh, target, workspace, timeoutMs);
  return await captureGitStateAfterBaseline(ssh, target, workspace, baselineSha, timeoutMs);
}

async function captureGitStateAfterBaseline(
  ssh: SshSubstrate,
  target: SshTarget,
  workspace: string,
  baselineSha: string,
  timeoutMs: number,
): Promise<Pick<WriterResult, "diff" | "commits">> {
  const diff = await runWorkspaceSshCommand(ssh, target, {
    label: "capture codex git diff",
    cwd: workspace,
    command: `git diff --no-color ${baselineSha}`,
    timeoutMs,
  });
  const log = await runWorkspaceSshCommand(ssh, target, {
    label: "capture codex git commits",
    cwd: workspace,
    command: `git log --format='%H%x09%s' --reverse ${baselineSha}..HEAD`,
    timeoutMs,
  });
  return { diff: diff.stdout, commits: parseGitLogCommits(log.stdout) };
}

function parseGitLogCommits(stdout: string): Commit[] {
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
