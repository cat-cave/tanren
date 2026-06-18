// TEST FIXTURE ONLY. Synthetic git-workspace helpers — a deterministic `git init`
// baseline (`prepareGitWorkspace`), a fixed HELLO.md mutation + diff capture
// (`runFakeWriterMutation` / `captureGitMutation`), and the git-log commit
// parser they share. These are connectivity/test stand-ins and MUST NOT exist in
// any production/runtime path: production code prepares workspaces and captures
// diffs through the real writer adapters (codexGit / writerGit). They live under
// tests/ so they are unreachable from src/.
import type { RunnerHandle } from "../../src/engine/contracts/allocator.js";
import type { CommandSubstrate } from "../../src/engine/contracts/commandSubstrate.js";
import type { Commit, WriterResult } from "../../src/engine/providers/types.js";
import { quoteSshShellArg } from "../../src/engine/ssh/command.js";
import { runWorkspaceSshCommand } from "../../src/engine/workspace/index.js";

const authorEnv = "GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z'";
const fakeTokenUsage = {
  inputTokens: 32,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 16,
  reasoningOutputTokens: 0,
  totalTokens: 48,
};

export interface WorkspaceGitInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
}

export async function prepareGitWorkspace(input: WorkspaceGitInput): Promise<void> {
  const path = quoteSshShellArg(input.workspacePath);
  await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "prepare workspace",
    command: [
      "set -eu",
      `rm -rf ${path}`,
      `mkdir -p ${path}`,
      `cd ${path}`,
      "git init -b main",
      "git config user.name 'Tanren Fake Writer'",
      "git config user.email 'fake-writer@tanren.invalid'",
      "printf '%s\\n' '# Tanren workspace baseline' > README.md",
      "git add README.md",
      `${authorEnv} git commit -m baseline`,
    ].join(" && "),
  });
}

export async function runFakeWriterMutation(input: WorkspaceGitInput): Promise<void> {
  await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "fake writer mutation",
    cwd: input.workspacePath,
    command: [
      "set -eu",
      "printf '%s\\n' '# Hello from Tanren' '' 'hello world' > HELLO.md",
      "git add HELLO.md",
      `${authorEnv} git commit -m 'hello world'`,
    ].join(" && "),
  });
}

export async function captureGitMutation(input: WorkspaceGitInput): Promise<WriterResult> {
  const diff = await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "capture git diff",
    cwd: input.workspacePath,
    command: "git diff --no-color HEAD~1..HEAD",
  });
  const log = await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "capture git commit",
    cwd: input.workspacePath,
    command: "git log -1 --format='%H%x09%s' HEAD",
  });

  return {
    diff: diff.stdout,
    commits: [parseGitLogCommit(log.stdout)],
    exitReason: "completed",
    tokenUsage: fakeTokenUsage,
  };
}

export function parseGitLogCommit(stdout: string): Commit {
  const line = stdout.trimEnd().split("\n")[0] ?? "";
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
}
