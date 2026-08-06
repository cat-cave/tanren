/**
 * codexGit — the workspace git-state helpers used by the Codex writer adapter.
 * Extracted from codex.ts to keep that file under the 500-line architecture
 * cap. These run over the runner SSH substrate to capture the baseline sha,
 * commit the writer's changes, and diff/log the result into a WriterResult.
 *
 * These are workspace-bound VCS commands: each builds its `vcs` ActivityWatchdog
 * (output-driven, with the workspace as the silent-stretch liveness probe) via the
 * shared factory — never a wall-clock kill (feedback_no_timeouts_progress_based).
 */
import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { runWorkspaceSshCommand } from "../workspace/index.js";
import { buildActivityWatchdog } from "../ssh/activityWatchdog.js";
import { runCommitThroughProjectGate, stageWorkspaceChanges, writerExitReasonFor } from "./writerCommitGate.js";
import type { Commit, CommitRejection, WriterResult } from "./types.js";

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

async function commitWorkspaceChangesAfterCodex(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  workspace: string,
): Promise<CommitRejection | undefined> {
  // Staging runs as its own command so ONLY the commit's exit can be read as a hook
  // verdict — an `index.lock` conflict or a permission error is a substrate fault and must
  // keep throwing, not be re-told to the writer as "your work was rejected". See
  // `stageWorkspaceChanges`.
  await stageWorkspaceChanges(ssh, target, workspace, "stage codex workspace changes");
  // This commit leaves the repo's hook path LIVE — deliberately, because it carries the
  // writer's content into the PR — so the project's pre-commit gate votes on Tanren's
  // output. The hook's NO vote comes back as a VALUE (writerCommitGate.ts), not a throw:
  // it is the project telling us precisely what is wrong with the work, and the subtask
  // loop re-drives the writer with it. A substrate failure or watchdog stall still throws.
  return await runCommitThroughProjectGate(async () =>
    runWorkspaceSshCommand(ssh, target, {
      label: "commit codex workspace changes",
      cwd: workspace,
      command: [
        "set -eu",
        "if ! git diff --cached --quiet --exit-code; then",
        "GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' git commit -m 'codex writer'",
        "fi",
      ].join("\n"),
      watchdog: buildActivityWatchdog({ substrate: ssh, target, cls: "vcs", workspace }),
    }),
  );
}

export async function captureGitStateAfterCodex(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  workspace: string,
  baselineSha: string,
): Promise<Pick<WriterResult, "diff" | "commits" | "commitRejection"> & { exitReason: CodexGitExitReason }> {
  const commitRejection = await commitWorkspaceChangesAfterCodex(ssh, target, workspace);
  // Captured even on a rejection. Staging succeeded and only `git commit` was refused, so
  // the writer's work is still in the tree and `git diff <baseline>` (working tree vs
  // baseline) still shows it — the diff is the WORK SIGNATURE the convergence detector
  // needs to tell "the writer changed something this iteration" from a fixed point.
  // `git log baseline..HEAD` is simply empty: no commit was made.
  const base = await captureGitStateAfterBaseline(ssh, target, workspace, baselineSha);
  const state = { ...base, exitReason: writerExitReasonFor({ commitRejection }) };
  return commitRejection === undefined ? state : { ...state, commitRejection };
}

/** See the twin in writerGit.ts — derived beside the commit that produced the verdict. */
type CodexGitExitReason = ReturnType<typeof writerExitReasonFor>;

async function captureGitStateAfterBaseline(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  workspace: string,
  baselineSha: string,
): Promise<Pick<WriterResult, "diff" | "commits">> {
  const diff = await runWorkspaceSshCommand(ssh, target, {
    label: "capture codex git diff",
    cwd: workspace,
    command: `git diff --no-color ${baselineSha}`,
    watchdog: buildActivityWatchdog({ substrate: ssh, target, cls: "vcs", workspace }),
  });
  const log = await runWorkspaceSshCommand(ssh, target, {
    label: "capture codex git commits",
    cwd: workspace,
    command: `git log --format='%H%x09%s' --reverse ${baselineSha}..HEAD`,
    watchdog: buildActivityWatchdog({ substrate: ssh, target, cls: "vcs", workspace }),
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
