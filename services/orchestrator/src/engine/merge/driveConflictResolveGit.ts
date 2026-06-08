// The git-clone + `SshWorkspaceConflictApplier` drive-path conflict resolve — the
// kill-switch path (`CONFLICT_RESOLVER_JJ_LIVE=0`), the pre-cutover mechanism unchanged.
// Extracted from driveConflictResolve.ts to keep that file under the 500-line +
// 12-dependency caps (the jj cutover added the live-jj branch); this owns the legacy git
// clone-head + the runless allocate/release wrapper. The flag (`conflictResolverJjLive`)
// selects between this and driveConflictResolveJj.ts.

import type { Allocator, RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import type { OrgGithubAppInstallation } from "../config/orgConfig.js";
import type { ConflictResolverHook } from "../workflow/reviewMerge/index.js";
import { githubHttpsRemote, parseGitHubRepository } from "../providers/github.js";
import { gitAuthedCommand, gitTokenAuthPrelude } from "../workspace/githubPush.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { runWorkspaceSshCommand, workspaceRepoPathForRun } from "../workspace/index.js";

/** The repo/branch + tenancy facts the git drive resolve clones + allocates against. */
export interface DriveGitResolveFacts {
  orgId: string;
  projectId: string;
  runId: string;
  repoUrl: string;
  headBranch: string;
  runnerImage: string;
  installation?: OrgGithubAppInstallation;
  githubCredentialRef: string;
  identitySecretRef: string;
}

/** Everything the git drive resolve needs to allocate the runner + clone the head. */
export interface DriveGitResolveDeps {
  facts: DriveGitResolveFacts;
  allocator: Allocator;
  ssh: CommandSubstrate;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  githubAppMinter?: GithubAppTokenMinter;
  timeoutMs: number;
  /**
   * Assemble the intent-preserving resolver over the freshly-cloned runner + path.
   * Production passes the real `buildResolverForDrive`; a test injects a scripted hook
   * (the `buildResolver` seam) so the classify/cap/yield wrapper is asserted without a
   * live model/runner. Receives the clone HEAD as the re-gate diff base.
   */
  buildResolver: (target: RunnerHandle, workspacePath: string, baseSha: string) => ConflictResolverHook;
}

/**
 * Allocate a short-lived RUNLESS resolver runner, clone the PR HEAD into its workspace,
 * run the resolver, and release the runner (LOUD on leak). The runless synthetic naming
 * handle keeps a retained `runner_${runId}` row from the original run from colliding.
 */
export async function driveResolveOverGit(
  deps: DriveGitResolveDeps,
  conflictContext: Parameters<ConflictResolverHook>[0],
): Promise<{ resolved: boolean }> {
  const { facts } = deps;
  const resolverHandle = `${facts.runId}-resolve-${crypto.randomUUID()}`;
  const allocation = await deps.allocator.allocate({
    // Runless: use a synthetic naming handle so retained `runner_${runId}` rows
    // from the original run cannot collide with this short-lived resolver.
    runId: resolverHandle,
    projectId: facts.projectId,
    runnerImage: facts.runnerImage,
    identitySecretRef: facts.identitySecretRef,
    orgId: facts.orgId,
    runless: true,
    persistedRunId: null,
    persistedProjectId: facts.projectId,
  });
  const workspacePath = workspaceRepoPathForRun(resolverHandle);
  try {
    // Clone the HEAD (PR) branch into the workspace; the resolver's
    // SshWorkspaceConflictApplier.gather() then merges base INTO it to surface
    // the conflict hunks (it needs the head checked out as HEAD).
    const baseSha = await cloneHeadForResolve(deps, allocation.target, workspacePath);
    const resolver = deps.buildResolver(allocation.target, workspacePath, baseSha);
    return await resolver(conflictContext);
  } finally {
    // LOUD on release error: a leaked runner is a real fault (cost + capacity), so
    // surface it rather than swallow it (no silent leak).
    await deps.allocator.release(allocation.runnerId, "completed").catch((error: unknown) => {
      console.error(
        `[merge-coordinator] FAILED to release drive-path resolver runner ${allocation.runnerId} for run ${facts.runId} — leaked runner:`,
        error,
      );
      throw error;
    });
  }
}

/**
 * Clone the PR HEAD branch into the runner workspace so the resolver's applier can
 * merge base INTO it to surface the hunks. Authenticates App-first (the same seam
 * the run-loop clone uses) so a PRIVATE target clones; returns the clone HEAD as
 * the diff base the re-gate reasons against. Reuses the run-loop clone primitives
 * (gitTokenAuthPrelude / gitAuthedCommand) so the token never hits the command line.
 */
async function cloneHeadForResolve(
  deps: DriveGitResolveDeps,
  target: RunnerHandle,
  workspacePath: string,
): Promise<string> {
  const { facts } = deps;
  const staticRef = facts.githubCredentialRef;
  const token =
    facts.installation === undefined && staticRef.trim() === ""
      ? undefined
      : (
          await deps.vcsProvider.resolveToken({
            secrets: deps.secrets,
            ...(facts.installation !== undefined && { installation: facts.installation }),
            ...(staticRef.trim() !== "" && { staticRef }),
            ...(deps.githubAppMinter !== undefined && { minter: deps.githubAppMinter }),
          })
        ).token;
  const result = await runWorkspaceSshCommand(deps.ssh, target, {
    label: "prepare conflict-resolve workspace",
    timeoutMs: deps.timeoutMs,
    command: buildCloneHeadCommand(facts.repoUrl, facts.headBranch, token, workspacePath),
    ...(token === undefined ? {} : { stdin: token }),
  });
  return result.stdout.trim();
}

/** The git clone of the HEAD branch (authenticated via stdin when a token is present). */
function buildCloneHeadCommand(
  repoUrl: string,
  headBranch: string,
  token: string | undefined,
  workspacePath: string,
): string {
  const branch = quoteSshShellArg(headBranch);
  const dest = quoteSshShellArg(workspacePath);
  // Configure a non-attributable resolver identity for the in-progress merge
  // commit (the resolution is published on the PR branch, attributed by the push
  // token's account; the local commit author is set by the applier's publish step).
  const post = [
    `cd ${dest}`,
    "git config user.name 'Tanren Conflict Resolver'",
    "git config user.email 'resolver@tanren.invalid'",
    "git rev-parse HEAD",
  ];
  if (token === undefined) {
    return [
      "set -eu",
      `rm -rf ${dest}`,
      `git clone --branch ${branch} ${quoteSshShellArg(repoUrl)} ${dest}`,
      ...post,
    ].join(" && ");
  }
  const remote = quoteSshShellArg(githubHttpsRemote(parseGitHubRepository(repoUrl)));
  return [
    "set -eu",
    ...gitTokenAuthPrelude(),
    `rm -rf ${dest}`,
    gitAuthedCommand(["clone", "--branch", branch, remote, dest]),
    ...post,
  ].join(" && ");
}
