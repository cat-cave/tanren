// plannerRunWorkspace — the run's workspace-prep + bootstrap stage, extracted
// from plannerRun.ts to keep it under the 500-line architecture cap.
//
// It clones the target branch (capturing the clone HEAD), installs deps
// (P3-0006 bootstrap), and commits the bootstrap-generated tree as ONE synthetic
// commit. The bootstrap commit's sha becomes the writer's diff base, so the
// checker/auditor and the captured diff see only the writer's real changes —
// the install artifacts (lockfiles, node_modules) sit below the base. The
// `cloneHeadSha` is threaded onward so the PR-branch cleanup can replay the
// writer commits onto it (dropping the bootstrap commit) before the push.
import type { SshTarget } from "../contracts/allocator.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { bootstrapWorkspace, commitBootstrapState, runWorkspaceSshCommand } from "../workspace/index.js";
import { resolveBootstrapCommand } from "./gate/index.js";
import type { BootstrapStepInput, CommitBootstrapStepInput, RunPlannerLoopInput } from "./plannerRun.js";

export interface PreparedRunWorkspace {
  // The clone HEAD (base-branch tip). The writer commits replay onto this before
  // the PR is pushed, so the PR carries only the writer's source changes.
  cloneHeadSha: string;
  // The synthetic post-bootstrap commit (or "" on a fake SSH). The PR-branch
  // cleanup drops this commit.
  bootstrapSha: string;
  // The writer's diff base: the bootstrap commit, or the clone HEAD when the
  // bootstrap step yielded no sha (fake SSH unit paths).
  baseSha: string;
}

// Clones the target branch + installs deps + commits the bootstrap state, and
// returns the run's clone-HEAD / bootstrap / base shas.
export async function prepareRunWorkspace(
  input: RunPlannerLoopInput,
  target: SshTarget,
  workspacePath: string,
): Promise<PreparedRunWorkspace> {
  const cloneHeadSha = await cloneWorkspace(input, target, workspacePath);

  // Command precedence: an explicit input.bootstrapCommand override wins;
  // otherwise resolve the repo's tanren-ci.yml `bootstrap.run` (P3-0004); when
  // the repo ships no tanren-ci.yml the resolver yields undefined and the
  // bootstrap step falls back to its pnpm/npm-detecting DEFAULT_BOOTSTRAP_COMMAND.
  const resolvedBootstrapCommand =
    input.bootstrapCommand ??
    (await resolveBootstrapCommand({ ssh: input.ssh, target, workspacePath, timeoutMs: input.timeoutMs }));
  const runBootstrap =
    input.runBootstrap ?? ((stepInput: BootstrapStepInput) => bootstrapWorkspace(stepInput).then(() => {}));
  await runBootstrap({
    ssh: input.ssh,
    target,
    workspacePath,
    command: resolvedBootstrapCommand,
    timeoutMs: input.timeoutMs,
  });

  // Commit the bootstrap-generated tree as ONE synthetic commit on top of the
  // clone HEAD; its sha is the writer's diff base. When bootstrap produced
  // nothing the commit is empty (sha != cloneHeadSha); on a fake SSH the step
  // yields "" and baseSha falls back to cloneHeadSha.
  const commitBootstrap =
    input.commitBootstrap ?? ((stepInput: CommitBootstrapStepInput) => commitBootstrapState(stepInput));
  const bootstrapSha = await commitBootstrap({ ssh: input.ssh, target, workspacePath, timeoutMs: input.timeoutMs });
  const baseSha = bootstrapSha === "" ? cloneHeadSha : bootstrapSha;

  return { cloneHeadSha, bootstrapSha, baseSha };
}

// Clones the target branch and returns the clone HEAD. `git rev-parse HEAD` runs
// LAST in the chain and is the only stdout-producing step, so the returned
// stdout is the clone HEAD sha. Returns "" only on a fake SSH that yields no
// output; the real runner always returns a 40-hex sha.
async function cloneWorkspace(input: RunPlannerLoopInput, target: SshTarget, workspacePath: string): Promise<string> {
  const result = await runWorkspaceSshCommand(input.ssh, target, {
    label: "prepare planner-loop workspace",
    timeoutMs: input.timeoutMs,
    command: [
      "set -eu",
      `rm -rf ${quoteSshShellArg(workspacePath)}`,
      `git clone --depth 1 --branch ${quoteSshShellArg(input.context.targetBranch)} ${quoteSshShellArg(input.context.repoUrl)} ${quoteSshShellArg(workspacePath)}`,
      `cd ${quoteSshShellArg(workspacePath)}`,
      "git config user.name 'Tanren Planner'",
      "git config user.email 'planner@tanren.invalid'",
      "git rev-parse HEAD",
    ].join(" && "),
  });
  return result.stdout.trim();
}
