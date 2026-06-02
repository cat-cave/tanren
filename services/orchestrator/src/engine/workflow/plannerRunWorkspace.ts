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
import { githubHttpsRemote, parseGitHubRepository } from "../providers/github.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { bootstrapWorkspace, commitBootstrapState, runWorkspaceSshCommand } from "../workspace/index.js";
import { gitAuthedCommand, gitTokenAuthPrelude } from "../workspace/githubPush.js";
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
//
// When a GitHub token is threaded (`input.githubToken`) the clone authenticates
// over HTTPS as `x-access-token:<token>` so a PRIVATE target repo can be cloned.
// The token is fed to the command over SSH stdin via the shared git credential
// helper (the same mechanism `githubPush.ts` uses) — it never appears in the
// command string, the process args, or any emitted `workspace.*` event. Without
// a token the clone runs unauthenticated against the repo URL as-is (public-repo
// path), unchanged.
async function cloneWorkspace(input: RunPlannerLoopInput, target: SshTarget, workspacePath: string): Promise<string> {
  const token = await resolveCloneToken(input);
  const result = await runWorkspaceSshCommand(input.ssh, target, {
    label: "prepare planner-loop workspace",
    timeoutMs: input.timeoutMs,
    command: buildCloneCommand(input.context.repoUrl, input.context.targetBranch, token, workspacePath),
    ...(token === undefined ? {} : { stdin: token }),
  });
  return result.stdout.trim();
}

// Resolves the run's GitHub token for the clone through the SAME VcsProvider
// seam the rest of the run path uses (`resolveToken`), so the clone is
// APP-FIRST: a caller-injected `githubToken` (test seam) wins; otherwise the
// provider mints an auto-rotating App installation token when the org installed
// the App (`context.installation`), else reads the static `github_token` at the
// run's resolved credential ref. This is a deliberate behavior change from the
// prior static-ref-only clone — clone now prefers the App token when an App is
// present, matching the CI-poll / merge stages (no more asymmetry).
//
// When NEITHER an App nor a static credential ref is configured the clone must
// still run for the public-repo path, so we return undefined (unauthenticated
// clone) instead of throwing; a missing secret at a CONFIGURED ref still
// propagates so a misconfigured private run fails loudly. The token is only
// returned (fed to the clone over stdin) — never logged.
async function resolveCloneToken(input: RunPlannerLoopInput): Promise<string | undefined> {
  if (input.githubToken !== undefined) {
    return input.githubToken;
  }
  const staticRef = input.context.githubCredentialRef;
  // No App installation AND no static ref → unauthenticated public-repo clone.
  if (input.context.installation === undefined && staticRef.trim() === "") {
    return undefined;
  }
  const resolved = await input.vcsProvider.resolveToken({
    secrets: input.secrets,
    ...(input.context.installation !== undefined && { installation: input.context.installation }),
    ...(staticRef.trim() !== "" && { staticRef }),
    ...(input.githubAppMinter !== undefined && { minter: input.githubAppMinter }),
  });
  return resolved.token;
}

function buildCloneCommand(
  repoUrl: string,
  targetBranch: string,
  token: string | undefined,
  workspacePath: string,
): string {
  const branch = quoteSshShellArg(targetBranch);
  const dest = quoteSshShellArg(workspacePath);
  const post = [
    `cd ${dest}`,
    "git config user.name 'Tanren Planner'",
    "git config user.email 'planner@tanren.invalid'",
    "git rev-parse HEAD",
  ];

  // No token → plain unauthenticated clone of the repo URL as configured.
  if (token === undefined) {
    return [
      "set -eu",
      `rm -rf ${dest}`,
      `git clone --depth 1 --branch ${branch} ${quoteSshShellArg(repoUrl)} ${dest}`,
      ...post,
    ].join(" && ");
  }

  // Token present → authenticate over HTTPS via the stdin-fed credential helper
  // (token never on the command line). Normalize the repo URL to the HTTPS
  // remote the helper authenticates against.
  const remote = quoteSshShellArg(githubHttpsRemote(parseGitHubRepository(repoUrl)));
  return [
    "set -eu",
    ...gitTokenAuthPrelude(),
    `rm -rf ${dest}`,
    gitAuthedCommand(["clone", "--depth", "1", "--branch", branch, remote, dest]),
    ...post,
  ].join(" && ");
}
