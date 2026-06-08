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

import type { WorkspaceHandle, WorkspaceVcsCore } from "../contracts/workspaceVcsCore.js";
import { buildLiveJjWorkspace } from "../providers/liveJjWorkspace.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { runWorkspaceSshCommand } from "../workspace/ssh.js";
import type { BaseShiftRunContext } from "./baseShiftLiveContext.js";
import type { LiveBaseShiftDeps } from "./baseShiftLiveSeams.js";

/** The opened live workspace the coordinator rebases over + the LOUD-on-leak release. */
export interface LiveBaseShiftWorkspaceCore {
  core: WorkspaceVcsCore;
  handle: WorkspaceHandle;
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
  timeoutMs: number;
}): Promise<LiveBaseShiftWorkspaceCore> {
  const { deps, ctx, baseRef, timeoutMs } = input;
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
    vcsProvider: deps.vcsProvider,
    ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
    timeoutMs,
  });
  try {
    const handle = await live.core.openWorkspace({
      repoUrl: ctx.repoUrl,
      baseBranch: baseRef,
      path: live.workspacePath,
    });
    // Prepare the published head for an in-place rebase (SAME as the jj applier's gather()):
    //  1. track the remote head bookmark as the LOCAL `<head>` bookmark `rebaseOnto` names;
    //  2. empty the immutable set so rebasing the published head is allowed in this
    //     short-lived workspace.
    // FAIL-CLOSED: a track/config failure throws (the resolve aborts — no `|| true`).
    await runWorkspaceSshCommand(deps.ssh, live.target, {
      label: "base-shift rebase: track the published head + allow rewriting it",
      cwd: live.workspacePath,
      timeoutMs,
      command: [
        "set -eu",
        `jj bookmark track ${quoteSshShellArg(ctx.headBranch)} --remote origin`,
        `jj config set --repo ${quoteSshShellArg('revset-aliases."immutable_heads()"')} ${quoteSshShellArg("none()")}`,
      ].join(" && "),
    });
    return { core: live.core, handle, release: live.release };
  } catch (error) {
    // FAIL-CLOSED: a failed clone/prepare must NOT leak the runner — release loudly before
    // re-throwing (the coordinator maps the throw to a hold; the work survives).
    await live.release();
    throw error;
  }
}
