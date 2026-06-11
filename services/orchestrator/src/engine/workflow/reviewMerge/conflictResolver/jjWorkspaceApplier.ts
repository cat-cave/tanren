// The jj-backed `WorkspaceConflictApplier` (tanren-owns-the-engine.md §2, §5) — the
// Wave-3/S1 replacement for the git-merge-abort `SshWorkspaceConflictApplier`. It
// drives the SAME conflict-resolution seam (gather → applyResolution → publishResolved
// / abort) the intent-preserving resolver consumes, but over jj's FIRST-CLASS
// conflicts instead of a `git merge --no-ff || true` / `git merge --abort` dance:
//
//   gather()          → `rebaseOnto(baseSha)` over the live `JjWorkspaceVcsCore`. jj
//                        RECORDS the conflict IN the commit (the rebase SUCCEEDS, never
//                        bricks). There is NO `|| true` swallowing here: a clone /
//                        fetch / rebase INFRA or AUTH failure is a LOUD throw (the
//                        §5-P1 fail-open closure — a failed gather can never degrade to
//                        an empty conflict that false-cleans a merge). The conflicted
//                        files' markers are read back for the Answerer.
//   applyResolution() → `resolveConflict({resolutions})` writes the intent-preserving
//                        answer INTO the conflicted commit (jj auto-snapshots it).
//   publishResolved() → `exportCleanGitRef` (which REFUSES a still-conflicted ref —
//                        the fail-closed §2 host boundary) + an authed git push of the
//                        exported ref onto the PR head branch.
//   abort()           → a no-op: jj conflicts stay LOCAL to the runner workspace and
//                        are torn down with the workspace (`release()`); there is no
//                        in-progress host-side merge to unwind. The work is never
//                        discarded (the never-brick guarantee is structural).
//
// The applier holds the `LiveJjWorkspace` (A1's `buildLiveJjWorkspace` factory output:
// the `JjWorkspaceVcsCore` bound to an allocated runner + a LOUD-on-leak `release()`).
// It opens the workspace lazily on first `gather()` and releases it on the resolver's
// terminal step — the workspace mechanism is the ONLY thing that changed; the
// classify-then-escalate / replan-cap / re-gate logic above it is untouched.

import type { RunnerHandle } from "../../../contracts/allocator.js";
import type { CommandSubstrate } from "../../../contracts/commandSubstrate.js";
import type { SecretStore } from "../../../contracts/secretStore.js";
import type { GitHubHttpClient } from "../../../providers/github.js";
import type { RecordedConflict, WorkspaceHandle, WorkspaceVcsCore } from "../../../contracts/workspaceVcsCore.js";
import type {
  ConflictedFile,
  GatheredConflict,
  WorkspaceConflictApplier,
} from "../../../contracts/conflictResolution.js";
import type { OrgGithubAppInstallation } from "../../../config/orgConfig.js";
import type { GithubAppTokenMinter } from "../../../providers/githubAppTokenMinter.js";
import type { LiveJjWorkspace } from "../../../providers/liveJjWorkspace.js";
import { quoteSshShellArg } from "../../../ssh/command.js";
import { runWorkspaceSshCommand } from "../../../workspace/ssh.js";
import { pushJjHead } from "./jjAuthedPush.js";

/** The repo + branch facts the jj applier rebases the PR head onto the merge-time base. */
export interface JjConflictApplierFacts {
  /** The clone URL the live workspace opened against (also the push remote). */
  repoUrl: string;
  /** The merge-time base branch (the speculative base when set, else the default). */
  baseBranch: string;
  /**
   * The merge-time base the PR head is rebased ONTO (the never-discard rebase). In
   * production this is the freshly-cloned base bookmark (`<baseBranch>@origin`), which
   * `identityJjRefResolver.baseRevision` passes through verbatim to `jj rebase -d`. The
   * conformance substrate maps its synthetic base token onto the fixture's bookmark.
   */
  baseRevision: string;
  /** The PR/run head branch the recorded conflict lives on + the resolution publishes to. */
  headBranch: string;
  /** The org App installation (App-first push token), when the org installed the App. */
  installation?: OrgGithubAppInstallation;
  /** The static fallback push credential ref. */
  githubCredentialRef: string;
}

export interface JjConflictApplierDeps {
  /** The live jj core bound to the allocated runner (A1's `buildLiveJjWorkspace`). */
  core: WorkspaceVcsCore;
  /** The runner the jj commands + the push execute on. */
  target: RunnerHandle;
  /** The runner-local path the workspace clones into. */
  workspacePath: string;
  /** The live SSH substrate (conflict-content reads + the authed push run on it). */
  ssh: CommandSubstrate;
  /** The secret store the push-token resolution reads from. */
  secrets: SecretStore;
  /** The provider that owns the App-first / static push-token resolution policy. */
  /** The shared (timed) GitHub HTTP client the run/merge host seams build over. */
  githubHttp: GitHubHttpClient;
  /** The shared installation-token minter (its cache lives here). */
  githubAppMinter?: GithubAppTokenMinter;
  facts: JjConflictApplierFacts;
  timeoutMs: number;
  /**
   * An ALREADY-open workspace handle to gather over INSTEAD of cloning a fresh one
   * (WS-A PR-6b, walker-jj-local-integration-design.md §2.2). The base-shift resolver's
   * jj-local path assembles `main + ordered ancestors` LOCALLY in its own workspace
   * (`integrateOverWorkspace` leaves it open at the assembled head), then `facts.baseRevision`
   * is that LOCAL assembled-head sha — there is no single host ref to clone. When set,
   * `gather()` skips `openWorkspace` and rebases the head onto the local assembled head in
   * THIS workspace; absent ⇒ the unchanged clone-then-rebase path (every other consumer).
   */
  preOpenedWorkspace?: WorkspaceHandle;
  /** Release the live workspace's runner (LOUD on leak) — run on the terminal step. */
  release: () => Promise<void>;
}

/** The opened-workspace state the applier threads gather → apply → publish. */
interface OpenState {
  workspace: WorkspaceHandle;
  conflict: RecordedConflict;
}

export class JjWorkspaceConflictApplier implements WorkspaceConflictApplier {
  private opened: OpenState | undefined;
  private released = false;

  constructor(private readonly deps: JjConflictApplierDeps) {}

  /**
   * Open the live jj workspace, rebase the PR head onto the merge-time base, and read
   * the recorded conflict's files back (with jj's conflict markers) for the Answerer.
   *
   * FAIL-CLOSED (§5-P1): every jj op here throws LOUDLY on an infra/auth/clone/rebase
   * failure — there is NO `|| true`. The old git applier's `git fetch || true` /
   * `git merge --no-ff || true` could swallow a clone/fetch failure and return an
   * EMPTY conflict set, which the resolver would read as "nothing conflicted" and let
   * the merge proceed false-clean. Here a failed clone/rebase aborts the whole resolve.
   * A CLEAN rebase (no conflict recorded) returns an empty file list — the resolver's
   * own decision core handles that (it is a real "nothing to resolve" state, not a
   * swallowed error).
   */
  async gather(): Promise<GatheredConflict> {
    const { core, facts } = this.deps;
    // WS-A PR-6b (§2.2): the base-shift jj-local resolver hands us an ALREADY-open workspace
    // whose `facts.baseRevision` is a LOCAL assembled-stack head (`main + ordered ancestors`,
    // assembled by `integrateOverWorkspace`) — there is no single host ref to clone, and a
    // re-clone would discard the local assembly. Reuse the open handle; every other consumer
    // (preOpenedWorkspace absent) clones a fresh workspace on `facts.baseBranch` as before.
    const workspace =
      this.deps.preOpenedWorkspace ??
      (await core.openWorkspace({
        repoUrl: facts.repoUrl,
        baseBranch: facts.baseBranch,
        path: this.deps.workspacePath,
      }));
    // Prepare the just-cloned workspace for the rebase of a LIVE published head:
    //  1. `jj git clone` imports a NON-default branch only as a REMOTE-tracking
    //     bookmark (`<head>@origin`), so create the LOCAL `<head>` bookmark that
    //     `rebaseOnto` names by tracking the remote one.
    //  2. The PR head is a PUBLISHED bookmark (jj treats it as immutable), so rebasing
    //     it onto the shifted base would refuse with "would rewrite immutable commits".
    //     The workspace is short-lived + the resolution is pushed back to the SAME head,
    //     so empty the immutable set for THIS workspace.
    // FAIL-CLOSED: this setup runs through the throwing SSH helper — a clone/track/config
    // failure aborts the resolve (no `|| true`). The conformance substrate builds a
    // mutable local feature, so it never needs this; it is the live-published-head path.
    await runWorkspaceSshCommand(this.deps.ssh, this.deps.target, {
      label: "jj conflict-resolve: track the published head + allow rewriting it",
      cwd: this.deps.workspacePath,
      timeoutMs: this.deps.timeoutMs,
      command: [
        "set -eu",
        // jj 0.42 `bookmark track` takes the bare NAME (not `<name>@origin`) + `--remote`.
        `jj bookmark track ${quoteSshShellArg(facts.headBranch)} --remote origin`,
        `jj config set --repo ${quoteSshShellArg('revset-aliases."immutable_heads()"')} ${quoteSshShellArg("none()")}`,
      ].join(" && "),
    });
    const rebase = await core.rebaseOnto(workspace, facts.headBranch, facts.baseRevision);
    if (rebase.outcome === "clean" || rebase.conflict === undefined) {
      // A clean rebase recorded NO conflict. This is a real "nothing to resolve" state
      // (the base shifted but did not collide) — return an empty conflict set, which is
      // distinct from the swallowed-error empty the §5-P1 fix forbids: NO op failed.
      this.opened = undefined;
      return { files: [] };
    }
    this.opened = { workspace, conflict: rebase.conflict };
    const files = await this.readConflictedFiles(rebase.conflict);
    return { files };
  }

  /**
   * Write the intent-preserving resolution INTO the recorded conflict's commit via the
   * core's `resolveConflict`. jj auto-snapshots the resolution in the commit (never
   * recreated) — the never-discard guarantee. Requires a prior `gather()` that recorded
   * a conflict (the resolver only calls this on a `kind: 'apply'` decision).
   */
  async applyResolution(resolved: ReadonlyArray<{ path: string; content: string }>): Promise<void> {
    const open = this.requireOpen("applyResolution");
    await this.deps.core.resolveConflict({
      workspace: open.workspace,
      branch: this.deps.facts.headBranch,
      conflictId: open.conflict.conflictId,
      resolutions: resolved.map((f) => ({ path: f.path, content: f.content })),
    });
  }

  /**
   * Export the resolved ref (which REFUSES a still-conflicted ref — fail-closed) and
   * push it onto the PR head branch with an App-first/static authed git push. The jj
   * workspace is `--colocate`d, so `jj git export` writes a real git ref the push
   * remote already has; the push then lands the resolution on the host. Releases the
   * live workspace's runner after the push (the resolver's terminal success step).
   */
  async publishResolved(): Promise<void> {
    const open = this.requireOpen("publishResolved");
    // exportCleanGitRef THROWS if the head still carries an unresolved conflict — a
    // conflicted ref is NEVER exported to the host (the §2 fail-closed boundary).
    await this.deps.core.exportCleanGitRef(open.workspace, this.deps.facts.headBranch);
    await this.pushResolvedHead();
    await this.releaseWorkspace();
  }

  /**
   * No host-side merge to unwind: jj conflicts stay LOCAL to the runner workspace and
   * are torn down with it. So `abort` is a workspace RELEASE, not a `git merge --abort`
   * — the work is never discarded (the never-brick guarantee is structural to jj).
   * Called by the resolver on the irreconcilable / failed-re-gate tail.
   */
  async abort(): Promise<void> {
    await this.releaseWorkspace();
  }

  /**
   * Read each conflicted path's content WITH jj's conflict markers for the Answerer.
   * jj materializes the markers in the working copy when the conflicted commit is the
   * edited revision, so put the head commit in the working copy (`jj edit`) then read
   * the files. Every read is fail-closed (the throwing SSH helper).
   */
  private async readConflictedFiles(conflict: RecordedConflict): Promise<ConflictedFile[]> {
    await runWorkspaceSshCommand(this.deps.ssh, this.deps.target, {
      label: "jj conflict gather: materialize markers",
      cwd: this.deps.workspacePath,
      timeoutMs: this.deps.timeoutMs,
      command: ["set -eu", `jj edit ${quoteSshShellArg(this.deps.facts.headBranch)}`].join(" && "),
    });
    const files: ConflictedFile[] = [];
    for (const path of conflict.paths) {
      const read = await runWorkspaceSshCommand(this.deps.ssh, this.deps.target, {
        label: `jj conflict gather: read ${path}`,
        cwd: this.deps.workspacePath,
        timeoutMs: this.deps.timeoutMs,
        command: `cat -- ${quoteSshShellArg(path)}`,
      });
      files.push({ path, conflictedContent: read.stdout });
    }
    return files;
  }

  /** Push the jj-exported resolved head onto the PR branch (App-first/static authed). */
  private async pushResolvedHead(): Promise<void> {
    const { facts } = this.deps;
    // FORCE push (inside `pushJjHead`): the rebase REWROTE the head's history (the
    // resolution is a new commit chain on the shifted base), so the push is non-fast-forward
    // by construction. The SAME shared push machinery the §3.1 base-shift clean rebase uses.
    await pushJjHead({
      ssh: this.deps.ssh,
      target: this.deps.target,
      workspacePath: this.deps.workspacePath,
      secrets: this.deps.secrets,
      githubHttp: this.deps.githubHttp,
      ...(this.deps.githubAppMinter !== undefined && { githubAppMinter: this.deps.githubAppMinter }),
      repoUrl: facts.repoUrl,
      headBranch: facts.headBranch,
      ...(facts.installation !== undefined && { installation: facts.installation }),
      githubCredentialRef: facts.githubCredentialRef,
      timeoutMs: this.deps.timeoutMs,
    });
  }

  /** Release the live workspace's runner exactly once (LOUD on leak via A1's release). */
  private async releaseWorkspace(): Promise<void> {
    if (this.released) {
      return;
    }
    this.released = true;
    await this.deps.release();
  }

  private requireOpen(step: string): OpenState {
    if (this.opened === undefined) {
      throw new Error(
        `jj conflict applier: ${step} called without a gathered conflict — gather() must record a conflict first`,
      );
    }
    return this.opened;
  }
}

/** Everything the live jj conflict applier factory needs to bind the applier over a live workspace. */
export interface BuildJjConflictApplierDeps {
  /** The live jj workspace (A1's `buildLiveJjWorkspace`): core + runner + path + release. */
  live: LiveJjWorkspace;
  ssh: CommandSubstrate;
  secrets: SecretStore;
  /** The shared (timed) GitHub HTTP client the run/merge host seams build over. */
  githubHttp: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
  facts: JjConflictApplierFacts;
  timeoutMs: number;
  /**
   * WS-A PR-6b (§2.2): an already-open workspace handle the applier gathers over instead of
   * cloning a fresh one — the base-shift jj-local resolver's locally-assembled stack workspace.
   * Absent ⇒ the applier clones a fresh workspace on `facts.baseBranch` (every other consumer).
   */
  preOpenedWorkspace?: WorkspaceHandle;
}

/**
 * Build a live {@link JjWorkspaceConflictApplier} over an already-allocated live jj
 * workspace (A1's `buildLiveJjWorkspace` output): the `JjWorkspaceVcsCore` bound to the
 * runner + the LOUD-on-leak `release()`. The applier opens the workspace on its first
 * `gather()` (cloning into `live.workspacePath` on `live.target`) and owns running
 * `release()` on its terminal `publishResolved` / `abort`. Both wiring sites (in-loop
 * `direct_merge` + the drive pass) share this shape: they build the live workspace, run
 * the resolver's adapters + re-gate over the SAME `target` + `workspacePath` (so the
 * re-gate judges the jj-resolved tree), and hand this applier the workspace mechanism.
 */
export function buildJjConflictApplier(deps: BuildJjConflictApplierDeps): JjWorkspaceConflictApplier {
  return new JjWorkspaceConflictApplier({
    core: deps.live.core,
    target: deps.live.target,
    workspacePath: deps.live.workspacePath,
    ssh: deps.ssh,
    secrets: deps.secrets,
    githubHttp: deps.githubHttp,
    ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
    facts: deps.facts,
    timeoutMs: deps.timeoutMs,
    ...(deps.preOpenedWorkspace !== undefined && { preOpenedWorkspace: deps.preOpenedWorkspace }),
    release: deps.live.release,
  });
}
