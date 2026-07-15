// The live jj workspace open for a base-shift rebase (tanren-owns-the-engine.md §3) —
// extracted from `baseShiftLiveSeams.ts` to keep each file under the caps. Allocates a
// live jj workspace (A1's `buildLiveJjWorkspace`), clones the SHIFTED BASE, and prepares
// the dependent's OWN published head branch for an in-place rebase — the SAME workspace
// preparation the `JjWorkspaceConflictApplier.gather()` does (track the remote head
// bookmark locally + empty the immutable set so the published head can be rewritten). The
// returned core + handle are what the coordinator's `rebaseOnto` runs over; `release()` is
// the LOUD-on-leak finalizer the provider runs after the rebase.
//
// FAIL-CLOSED (§0): every jj op here throws LOUDLY on an infra/auth/clone failure (no
// `|| true`); a failure releases the runner (LOUD on leak) before re-throwing — never a
// half-built workspace, never a leaked runner.

import type { RunnerHandle } from "../contracts/allocator.js";
import type { OrgGithubAppInstallation } from "../config/orgConfig.js";
import type { WorkspaceHandle, WorkspaceVcsCore } from "../contracts/workspaceVcsCore.js";
import { buildLiveJjWorkspace } from "../providers/liveJjWorkspace.js";
import { trackPublishedHeadCommands } from "../providers/jjPublishedHead.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { buildActivityWatchdog } from "../ssh/activityWatchdog.js";
import { runWorkspaceSshCommand } from "../workspace/ssh.js";
import type { BaseShiftRunContext } from "./baseShiftLiveContext.js";
import type { LiveBaseShiftDeps } from "./baseShiftLiveSeams.js";

/**
 * The facts a §3.1 CLEAN-rebase push needs: the runner the push runs on + the repo/branch +
 * credential to authenticate it. Carried out of the opener so the provider can push the
 * rebased head onto the forge BEFORE releasing the runner (the re-gate then verifies the
 * PUSHED tree, not the un-rebased forge branch — NEVER-MERGE-UNVERIFIED).
 */
export interface LiveBaseShiftPushFacts {
  target: RunnerHandle;
  workspacePath: string;
  repoUrl: string;
  headBranch: string;
  installation?: OrgGithubAppInstallation;
  githubCredentialRef: string;
}

/** The opened live workspace the coordinator rebases over + the LOUD-on-leak release. */
export interface LiveBaseShiftWorkspaceCore {
  core: WorkspaceVcsCore;
  handle: WorkspaceHandle;
  /**
   * The shifted base's RESOLVED commit sha (a real 40-hex sha). Used BOTH as the
   * `rebaseOnto` -d target (`jj rebase -d <sha>` accepts a sha) AND recorded on the
   * `integration.rebase` event — §3.1 replaces the `<baseRef>@origin` jj revision TOKEN
   * (which polluted the event as if it were a sha) with this resolved sha.
   */
  newBaseSha: string;
  /** The facts the §3.1 clean-rebase push uses (export + authed force-push before release). */
  pushFacts: LiveBaseShiftPushFacts;
  /** Release the live workspace's runner (LOUD on leak) — run after the rebase. */
  release: () => Promise<void>;
}

/**
 * Allocate a live jj workspace, clone `baseRef`, and prepare the dependent's OWN head
 * branch for an in-place rebase onto `<baseRef>@origin`. Mirrors the applier's `gather()`
 * setup verbatim: `jj git clone` imports a non-default branch only as a remote-tracking
 * bookmark, so track the head locally; the published head is jj-immutable, so empty the
 * immutable set for THIS short-lived workspace. FAIL-CLOSED on every step.
 */
export async function openLiveBaseShiftWorkspace(input: {
  deps: LiveBaseShiftDeps;
  ctx: BaseShiftRunContext;
  baseRef: string;
}): Promise<LiveBaseShiftWorkspaceCore> {
  const { deps, ctx, baseRef } = input;
  const live = await buildLiveJjWorkspace({
    facts: {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      repoUrl: ctx.repoUrl,
      runnerImage: ctx.runnerImage,
      ...(ctx.installation !== undefined && { installation: ctx.installation }),
      githubCredentialRef: ctx.githubCredentialRef,
      identitySecretRef: deps.identitySecretRef,
    },
    allocator: deps.allocator,
    ssh: deps.ssh,
    secrets: deps.secrets,
    githubHttp: deps.githubHttp,
    ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
  });
  try {
    const handle = await live.core.openWorkspace({
      repoUrl: ctx.repoUrl,
      baseBranch: baseRef,
      path: live.workspacePath,
    });
    // Prepare the published head for an in-place rebase (SAME as the jj applier's gather()):
    //  1. FETCH + track + assert the remote head bookmark as the LOCAL `<head>` bookmark
    //     `rebaseOnto` names — robust against the "head not in the initial clone" race and
    //     FAIL-CLOSED on a genuinely-missing head (`trackPublishedHeadCommands`, which closes
    //     the apex-v94 silent-no-op that left the rebase `-b <head>` target missing);
    //  2. empty the immutable set so rebasing the published head is allowed in this
    //     short-lived workspace.
    // FAIL-CLOSED: a fetch/track/assert/config failure throws (the resolve aborts — no `|| true`).
    // AUTH: the fetch authenticates the private `origin` remote with the SAME credential the
    // workspace was cloned with (`live.cloneCredential`) — else (public) a bare fetch. The token
    // travels only through the command's stdin, never the logged command string.
    const trackPrep = trackPublishedHeadCommands(ctx.headBranch, live.cloneCredential);
    await runWorkspaceSshCommand(deps.ssh, live.target, {
      label: "base-shift rebase: track the published head + allow rewriting it",
      cwd: live.workspacePath,
      watchdog: buildActivityWatchdog({
        substrate: deps.ssh,
        target: live.target,
        cls: "vcs",
        workspace: live.workspacePath,
      }),
      command: [
        "set -eu",
        ...trackPrep.commands,
        `jj config set --repo ${quoteSshShellArg('revset-aliases."immutable_heads()"')} ${quoteSshShellArg("none()")}`,
      ].join(" && "),
      ...(trackPrep.stdin !== undefined && { stdin: trackPrep.stdin }),
    });
    // §3.1 event-pollution side-fix: resolve the SHIFTED base's REAL commit sha (the
    // `integration.rebase` instrumentation must record an actual sha, not the
    // `<baseRef>@origin` jj revision TOKEN). `jj rebase -d <token>` accepts the token AND a
    // sha; we keep `baseRevision` (the token) as the rebase target but surface `newBaseSha`
    // as the resolved sha for the event. A non-40-hex read is fail-closed (LOUD throw).
    const newBaseSha = await readJjRevSha(deps.ssh, live.target, live.workspacePath, `${baseRef}@origin`);
    return {
      core: live.core,
      handle,
      newBaseSha,
      pushFacts: {
        target: live.target,
        workspacePath: live.workspacePath,
        repoUrl: ctx.repoUrl,
        headBranch: ctx.headBranch,
        ...(ctx.installation !== undefined && { installation: ctx.installation }),
        githubCredentialRef: ctx.githubCredentialRef,
      },
      release: live.release,
    };
  } catch (error) {
    // FAIL-CLOSED: a failed clone/prepare must NOT leak the runner — release loudly before
    // re-throwing (the coordinator maps the throw to a hold; the work survives).
    await live.release();
    throw error;
  }
}

/** Resolve a jj revision's commit sha (the value `jj git export` writes); fail-closed on a non-sha read. */
async function readJjRevSha(
  ssh: LiveBaseShiftDeps["ssh"],
  target: RunnerHandle,
  workspacePath: string,
  rev: string,
): Promise<string> {
  const out = await runWorkspaceSshCommand(ssh, target, {
    label: "base-shift rebase: resolve base sha",
    cwd: workspacePath,
    watchdog: buildActivityWatchdog({ substrate: ssh, target, cls: "vcs", workspace: workspacePath }),
    command: `jj log -r ${quoteSshShellArg(rev)} --no-graph -T 'commit_id'`,
  });
  const sha = out.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`base-shift rebase: revision ${rev} did not resolve a base sha`);
  }
  return sha;
}
