// WS-A PR-6 (walker-jj-local-integration-design.md §2.2) — the LOCAL ancestor-stack
// assembly for a never-discard base shift. The opener's only coupling to the deleted
// orchestrator-synthesized `tanren/integ/<dep>` ref was cloning `${newBaseRef}@origin` as
// a single fetchable base; under the jj-local model the "shifted base" is the RE-RESOLVED
// ancestor stack (ancestors that merged dropped; the rest at their new heads), assembled
// LOCALLY on the dependent's own short-lived runner — exactly as the run-bootstrap path
// (`jjLocalBootstrap.ts`) and the batch path (`jjLocalIntegration.ts`) already do.
//
// This module is the base-shift counterpart of `openLiveBaseShiftWorkspace`
// (`baseShiftLiveRebase.ts`): it allocates a live jj workspace, jj-`--colocate` clones
// `default_branch + each ancestor PR-head bookmark`, STACKS the ordered ancestors onto the
// default branch via `integrateOverWorkspace` (jj-native rebase — a spec-vs-spec assembly
// conflict surfaces the SAME `conflict` outcome, fail-closed), and additionally tracks the
// dependent's OWN published head branch so the coordinator's `rebaseOnto(headBranch,
// assembledHeadSha)` rebases the dependent's work onto the assembled head IN PLACE
// (never-discard). The returned `newBaseSha` is the assembled head's REAL commit sha (the
// `rebaseOnto -d` target AND a clean `integration.rebase` event field — no token pollution).
//
// FAIL-CLOSED (§0): every jj op throws LOUDLY on infra/auth/clone failure; a failure (or a
// spec-vs-spec assembly conflict) releases the runner LOUDLY before re-throwing — never a
// half-built workspace, never a leaked runner. (The empty/single-ancestor fallback lives
// in `baseShiftLiveSeams.ts`; this module is the assembly itself.)

import { quoteSshShellArg } from "../ssh/command.js";
import { runWorkspaceSshCommand } from "../workspace/ssh.js";
import { buildLiveJjWorkspace, type LiveJjWorkspace } from "../providers/liveJjWorkspace.js";
import type { WorkspaceHandle } from "../contracts/workspaceVcsCore.js";
import { integrateOverWorkspace, type JjIntegrationMember } from "./jjLocalIntegration.js";
import type { AncestorStack } from "./ancestorStack.js";
import type { BaseShiftRunContext } from "./baseShiftLiveContext.js";
import type { LiveBaseShiftDeps } from "./baseShiftLiveSeams.js";
import type { LiveBaseShiftWorkspaceCore } from "./baseShiftLiveRebase.js";

/** The local bookmark name the re-resolved stack materializes as in the base-shift workspace. */
export function baseShiftStackLocalRef(headBranch: string): string {
  return `tanren-base-shift-stack-${headBranch.replaceAll(/[^A-Za-z0-9_-]/gu, "_")}`;
}

/** A spec-vs-spec conflict surfaced WHILE assembling the re-resolved stack (fail-closed). */
export class BaseShiftStackAssemblyConflictError extends Error {
  constructor(
    readonly conflictBetween: { specId: string; otherSpecId: string },
    message: string,
  ) {
    super(message);
    this.name = "BaseShiftStackAssemblyConflictError";
  }
}

/** Map the re-resolved ancestor stack to the ordered jj-local integration members. */
function membersForStack(stack: AncestorStack): JjIntegrationMember[] {
  return stack.map((ancestor) => ({ specId: ancestor.specId, branch: ancestor.branch }));
}

/**
 * Open a live jj workspace and ASSEMBLE the re-resolved ancestor stack LOCALLY (`main +
 * ordered ancestors`), preparing the dependent's OWN published head branch for an in-place
 * rebase onto the assembled head. The returned core + handle are what the coordinator's
 * `rebaseOnto(headBranch, newBaseSha)` runs over; `newBaseSha` is the assembled head's real
 * commit sha. Mirrors `openLiveBaseShiftWorkspace` for the multi-ref case — clone the base,
 * track + stack the ancestors, track the head bookmark, empty the immutable set — but the
 * rebase TARGET is the locally-assembled stack head, NOT `${newBaseRef}@origin`.
 *
 * FAIL-CLOSED: a clone/track/stack failure (or a spec-vs-spec assembly conflict) releases
 * the runner LOUDLY before re-throwing. (`stack` is the caller's already-non-empty
 * re-resolved stack — the empty/flag-off cases never reach here.)
 */
export async function assembleBaseShiftStackWorkspace(input: {
  deps: LiveBaseShiftDeps;
  ctx: BaseShiftRunContext;
  /** The re-resolved ordered ancestor stack (non-empty — DAG order, ancestors first). */
  stack: AncestorStack;
  timeoutMs: number;
}): Promise<LiveBaseShiftWorkspaceCore> {
  const { ctx } = input;
  const assembled = await assembleBaseShiftStackLive(input);
  // Wrap the open assembly into the coordinator-facing `LiveBaseShiftWorkspaceCore` (the
  // SAME shape `openLiveBaseShiftWorkspace` returns for the single-ref path): the rebase
  // TARGET is the LOCALLY-assembled stack head, not `${newBaseRef}@origin`.
  return {
    core: assembled.live.core,
    handle: assembled.workspace,
    newBaseSha: assembled.assembledHeadSha,
    pushFacts: {
      target: assembled.live.target,
      workspacePath: assembled.live.workspacePath,
      repoUrl: ctx.repoUrl,
      headBranch: ctx.headBranch,
      ...(ctx.installation !== undefined && { installation: ctx.installation }),
      githubCredentialRef: ctx.githubCredentialRef,
    },
    release: assembled.live.release,
  };
}

/** An OPEN base-shift stack assembly: the live workspace, the integrated head handle, the assembled head sha. */
export interface AssembledBaseShiftStack {
  /** The OPEN live jj workspace the stack was assembled in (the caller owns `release()`). */
  live: LiveJjWorkspace;
  /** The open workspace handle `integrateOverWorkspace` assembled the stack in. */
  workspace: WorkspaceHandle;
  /** The assembled stack head's REAL commit sha — the `rebaseOnto -d` target (NOT a host ref). */
  assembledHeadSha: string;
}

/**
 * WS-A PR-6 / PR-6b (§2.2) — the SHARED local stack assembly both the base-shift OPENER
 * (`assembleBaseShiftStackWorkspace`) and the base-shift CONFLICT RESOLVER
 * (`baseShiftLiveResolve.ts`) drive. Open a live jj workspace, jj-`--colocate` clone
 * `default_branch + each ancestor PR-head bookmark`, STACK the ordered ancestors onto the
 * default branch via `integrateOverWorkspace`, and prepare the dependent's OWN published
 * head for an in-place rebase onto the assembled head. Returns the OPEN workspace + the
 * assembled head sha — the caller (opener OR resolver) rebases the dependent's branch onto
 * `assembledHeadSha` and owns `live.release()`.
 *
 * FAIL-CLOSED: a clone/track/stack failure (or a spec-vs-spec assembly conflict) releases
 * the runner LOUDLY before re-throwing. (`stack` is the caller's already-non-empty
 * re-resolved stack — the empty/flag-off cases never reach here.)
 */
export async function assembleBaseShiftStackLive(input: {
  deps: LiveBaseShiftDeps;
  ctx: BaseShiftRunContext;
  /** The re-resolved ordered ancestor stack (non-empty — DAG order, ancestors first). */
  stack: AncestorStack;
  timeoutMs: number;
}): Promise<AssembledBaseShiftStack> {
  const { deps, ctx, stack, timeoutMs } = input;
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
    const localRef = baseShiftStackLocalRef(ctx.headBranch);
    // Stack `default_branch + ordered ancestors` LOCALLY (the SAME assembly the run-bootstrap
    // + batch paths run). `integrateOverWorkspace` opens the workspace on the base, tracks +
    // rebase-stacks each member, and materializes the clean assembled head — or surfaces a
    // spec-vs-spec conflict (fail-closed: nothing to rebase the dependent onto).
    const integration = await integrateOverWorkspace(live, deps.ssh, {
      baseBranch: ctx.defaultBranch,
      repoUrl: ctx.repoUrl,
      members: membersForStack(stack),
      localRef,
      timeoutMs,
    });
    if (integration.outcome === "conflict") {
      throw new BaseShiftStackAssemblyConflictError(
        integration.conflictBetween,
        `base-shift stack assembly for ${ctx.headBranch} conflicts ` +
          `(${integration.conflictBetween.specId} vs ${integration.conflictBetween.otherSpecId}): ${integration.message}`,
      );
    }
    const workspace = integration.workspace;
    if (workspace === undefined) {
      throw new Error(
        `base-shift stack assembly for ${ctx.headBranch} on ${ctx.defaultBranch} did not surface an open workspace handle`,
      );
    }
    // Prepare the dependent's OWN published head for an in-place rebase onto the assembled
    // head (the SAME track + immutable-heads prep `openLiveBaseShiftWorkspace` does for the
    // single-ref path): `jj git clone` imported the head only as a remote-tracking bookmark,
    // so track it as the LOCAL `<headBranch>` `rebaseOnto` names; the published head is
    // jj-immutable, so empty the immutable set for THIS short-lived workspace. (The member
    // bookmarks + immutable set were already prepared by `integrateOverWorkspace`; this adds
    // the dependent's head, which is NOT a stack member.) FAIL-CLOSED: a failure throws.
    await runWorkspaceSshCommand(deps.ssh, live.target, {
      label: "base-shift stack assembly: track the dependent's published head + allow rewriting it",
      cwd: live.workspacePath,
      timeoutMs,
      command: [
        "set -eu",
        `jj bookmark track ${quoteSshShellArg(ctx.headBranch)} --remote origin`,
        `jj config set --repo ${quoteSshShellArg('revset-aliases."immutable_heads()"')} ${quoteSshShellArg("none()")}`,
      ].join(" && "),
    });
    return { live, workspace, assembledHeadSha: integration.headSha };
  } catch (error) {
    // FAIL-CLOSED: a failed clone/assembly/prep must NOT leak the runner — release loudly
    // before re-throwing (the coordinator maps the throw to a hold; the work survives).
    await live.release();
    throw error;
  }
}
