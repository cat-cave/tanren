// The one jj-local integration assembly used by the batch, speculative-base, and
// authorized-subset paths. It works only through WorkspaceVcsCore plus the runner
// substrate needed to inspect immutable remote bookmarks and the exported git tree.

import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import {
  AncestorNotReadyError,
  type AssembleWorkspaceIntegrationInput,
  type WorkspaceIntegrationAssembly,
  type WorkspaceIntegrationMember,
  type WorkspaceVcsCore,
} from "../contracts/workspaceVcsCore.js";
import { SpeculativeAssemblyError } from "../dag/speculativeAssemblyError.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { buildActivityWatchdog } from "../ssh/activityWatchdog.js";
import { runWorkspaceSshCommand } from "./ssh.js";

export interface JjIntegrationAssemblyDeps {
  readonly core: Pick<WorkspaceVcsCore, "openWorkspace" | "branch" | "checkout" | "rebaseOnto" | "exportCleanGitRef">;
  readonly ssh: CommandSubstrate;
  readonly target: RunnerHandle;
}

/** Assemble a local jj bookmark from the clone's actual base and PR-head refs. */
export async function assembleJjWorkspaceIntegration(
  deps: JjIntegrationAssemblyDeps,
  input: AssembleWorkspaceIntegrationInput,
): Promise<WorkspaceIntegrationAssembly> {
  const workspace = await deps.core.openWorkspace({
    repoUrl: input.repoUrl,
    baseBranch: input.baseBranch,
    path: input.path,
  });
  const baseSha = await readBookmarkSha(deps, input.path, input.baseBranch);
  const members = await resolveLiveMembers(deps, input.path, input.baseBranch, input.members);
  await prepareMemberBookmarks(deps, input.path, members);
  await deps.core.branch(workspace, input.localRef, input.baseBranch);
  let accumulatedHead = await readBookmarkSha(deps, input.path, input.localRef);
  const memberHeadShas: Record<string, string> = {};
  const merged: string[] = [];

  for (const member of members) {
    memberHeadShas[member.specId] = await readBookmarkSha(deps, input.path, `${member.branch}@origin`);
    const rebase = await deps.core.rebaseOnto(workspace, member.branch, accumulatedHead);
    accumulatedHead = rebase.headSha;
    await setBookmark(deps, input.path, input.localRef, accumulatedHead);
    if (rebase.outcome === "conflicted") {
      const otherSpecId = merged.at(-1) ?? input.baseBranch;
      return {
        outcome: "conflict",
        conflictBetween: { specId: member.specId, otherSpecId },
        message:
          `member ${member.specId} (${member.branch}) conflicts with the integration of ${otherSpecId} ` +
          `on ${input.localRef} (jj-local)`,
      };
    }
    merged.push(member.specId);
  }

  await deps.core.checkout(workspace, input.localRef);
  const exported = await deps.core.exportCleanGitRef(workspace, input.localRef);
  return {
    outcome: "integrated",
    workspace,
    localRef: input.localRef,
    baseSha,
    headSha: exported.headSha,
    treeHash: await readTreeHash(deps, input.path, exported.headSha),
    memberHeadShas,
  };
}

async function prepareMemberBookmarks(
  deps: JjIntegrationAssemblyDeps,
  workspacePath: string,
  members: ReadonlyArray<WorkspaceIntegrationMember>,
): Promise<void> {
  const trackCommands = members.map((member) => `jj bookmark track ${quoteSshShellArg(member.branch)} --remote origin`);
  await runWorkspaceSshCommand(deps.ssh, deps.target, {
    label: "jj-local integration: track member bookmarks + allow rewriting them",
    cwd: workspacePath,
    watchdog: watchdog(deps, workspacePath),
    command: [
      "set -eu",
      ...trackCommands,
      `jj config set --repo ${quoteSshShellArg('revset-aliases."immutable_heads()"')} ${quoteSshShellArg("none()")}`,
    ].join(" && "),
  });
}

async function resolveLiveMembers(
  deps: JjIntegrationAssemblyDeps,
  workspacePath: string,
  baseBranch: string,
  members: ReadonlyArray<WorkspaceIntegrationMember>,
): Promise<WorkspaceIntegrationMember[]> {
  const live: WorkspaceIntegrationMember[] = [];
  for (const member of members) {
    if (await revisionExists(deps, workspacePath, `${member.branch}@origin`)) {
      live.push(member);
      continue;
    }
    const knownHeadSha = member.knownHeadSha;
    const merged =
      knownHeadSha !== undefined &&
      /^[0-9a-f]{40}$/u.test(knownHeadSha) &&
      (await commitContainedInBase(deps, workspacePath, knownHeadSha, baseBranch));
    if (merged) continue;
    if (member.ancestorPhase === "pending" || member.ancestorPhase === "in_flight") {
      throw new AncestorNotReadyError(member.specId, member.branch, member.ancestorPhase, baseBranch);
    }
    throw new SpeculativeAssemblyError(
      "missing_ancestor_ref",
      `jj-local integration: member ${member.specId} (${member.branch}) has no ${member.branch}@origin ref ` +
        `and did NOT merge into ${baseBranch} (knownHeadSha=${knownHeadSha ?? "<none>"}, ancestorPhase=` +
        `${member.ancestorPhase ?? "<unknown>"}) — refusing to silently drop a genuinely missing ancestor branch`,
    );
  }
  return live;
}

async function revisionExists(deps: JjIntegrationAssemblyDeps, workspacePath: string, rev: string): Promise<boolean> {
  const result = await deps.ssh.run(deps.target, {
    cwd: workspacePath,
    watchdog: watchdog(deps, workspacePath),
    command: `jj log -r ${quoteSshShellArg(rev)} --no-graph -T 'commit_id'`,
  });
  return (
    result.failure === undefined &&
    result.stalled !== true &&
    result.exitCode === 0 &&
    /^[0-9a-f]{40}$/u.test(result.stdout.trim())
  );
}

async function commitContainedInBase(
  deps: JjIntegrationAssemblyDeps,
  workspacePath: string,
  headSha: string,
  baseBranch: string,
): Promise<boolean> {
  const base = await deps.ssh.run(deps.target, {
    cwd: workspacePath,
    watchdog: watchdog(deps, workspacePath),
    command: `jj log -r ${quoteSshShellArg(`${baseBranch}@origin`)} --no-graph -T 'commit_id'`,
  });
  const baseSha = base.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(baseSha)) return false;
  const result = await deps.ssh.run(deps.target, {
    cwd: workspacePath,
    watchdog: watchdog(deps, workspacePath),
    command: `git merge-base --is-ancestor ${quoteSshShellArg(headSha)} ${quoteSshShellArg(baseSha)}`,
  });
  return result.failure === undefined && result.stalled !== true && result.exitCode === 0;
}

async function readBookmarkSha(deps: JjIntegrationAssemblyDeps, workspacePath: string, rev: string): Promise<string> {
  const out = await runWorkspaceSshCommand(deps.ssh, deps.target, {
    label: "jj read bookmark sha",
    cwd: workspacePath,
    watchdog: watchdog(deps, workspacePath),
    command: `jj log -r ${quoteSshShellArg(rev)} --no-graph -T 'commit_id'`,
  });
  const sha = out.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new SpeculativeAssemblyError(
      "head_sha_unresolved",
      `jj-local integration: revision ${rev} did not resolve a head sha`,
    );
  }
  return sha;
}

async function setBookmark(
  deps: JjIntegrationAssemblyDeps,
  workspacePath: string,
  bookmark: string,
  sha: string,
): Promise<void> {
  await runWorkspaceSshCommand(deps.ssh, deps.target, {
    label: "jj set integration bookmark",
    cwd: workspacePath,
    watchdog: watchdog(deps, workspacePath),
    command: `jj bookmark set ${quoteSshShellArg(bookmark)} -r ${quoteSshShellArg(sha)} --allow-backwards`,
  });
}

async function readTreeHash(deps: JjIntegrationAssemblyDeps, workspacePath: string, headSha: string): Promise<string> {
  const out = await runWorkspaceSshCommand(deps.ssh, deps.target, {
    label: "jj-local integration: read tree hash",
    cwd: workspacePath,
    watchdog: watchdog(deps, workspacePath),
    command: `git rev-parse ${quoteSshShellArg(`${headSha}^{tree}`)}`,
  });
  const treeHash = out.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(treeHash)) {
    throw new SpeculativeAssemblyError(
      "tree_hash_unresolved",
      `jj-local integration: ${headSha} did not resolve a git tree hash`,
    );
  }
  return treeHash;
}

function watchdog(deps: JjIntegrationAssemblyDeps, workspacePath: string) {
  return buildActivityWatchdog({ substrate: deps.ssh, target: deps.target, cls: "vcs", workspace: workspacePath });
}
