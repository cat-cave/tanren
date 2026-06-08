// Wave-3 Slice A1 — the PREREQUISITE de-risking harness. ONE tested factory that
// hands back a `JjWorkspaceVcsCore` (engine/providers/jjWorkspaceVcsCore.ts) bound to
// a REAL allocated runner over the live SSH `CommandSubstrate`, with the GitHub clone
// credential resolved App-first. It isolates THE biggest risk of Wave 3 — jj driven
// against a live runner cloning a real repo over SSH — into a single place the later
// slices (1–3) consume.
//
// WHAT'S NEW vs WHAT'S REUSED: the jj-CLI semantics are ALREADY conformance-pinned
// (tests/conformance/workspaceVcsCore.jj.conformance.test.ts passes against real jj),
// and `JjWorkspaceVcsCore` already owns clone/branch/commit/rebase/resolve/export. So
// this factory adds NOTHING to that surface — its ONLY new responsibility is the
// runner-allocation + SSH-clone + clone-credential thread, and even that REUSES the
// proven primitives from engine/merge/driveConflictResolve.ts VERBATIM in shape:
//   • the RUNLESS allocation (a synthetic naming handle so a retained `runner_<runId>`
//     row can't collide), mirrored from driveConflictResolve's `allocate({ runless })`;
//   • the App-first / static-fallback clone-token resolution via
//     `vcsProvider.resolveToken`, mirrored from `cloneHeadForResolve`;
//   • the LOUD-on-leak `release()` finalizer, mirrored from driveConflictResolve's
//     `allocator.release(...).catch(...){ throw }`.
//
// FAIL-CLOSED: an allocation / token / clone failure throws LOUDLY. The factory never
// returns a half-built workspace, and if it allocated a runner but then failed before
// returning, it releases that runner (LOUD on a leak) before re-throwing — a partial
// allocation never leaks.
//
// NO live consumer is wired here (additive; slices 1–3 wire it) and there is NO feature
// flag — so it cannot regress the engine.

import type { Allocator, RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import type { WorkspaceVcsCore } from "../contracts/workspaceVcsCore.js";
import type { OrgGithubAppInstallation } from "../config/orgConfig.js";
import { workspaceRepoPathForRun } from "../workspace/paths.js";
import { autoSnapshotWorkingEdit, identityJjRefResolver, JjWorkspaceVcsCore } from "./jjWorkspaceVcsCore.js";
import type { GithubAppTokenMinter } from "./githubAppTokenMinter.js";

/** The terminal runner image a live jj workspace allocates against when none is given. */
const DEFAULT_LIVE_JJ_RUNNER_IMAGE = "ghcr.io/tanren/runner:latest";

/** The default per-jj-command timeout (ms) the live workspace runs SSH ops under. */
const DEFAULT_LIVE_JJ_TIMEOUT_MS = 600_000;

/**
 * The repo + tenancy facts the factory clones + allocates against. These are exactly
 * what a run already knows (mirrors `DriveConflictResolveFacts` + the run context the
 * drive resolver loads), kept flat so a caller threads them straight through.
 */
export interface LiveJjWorkspaceFacts {
  /** The org the runner is allocated under (org-scoped persistence). */
  orgId: string;
  /** The project the runner is allocated under. */
  projectId: string;
  /** The clone URL `jj git clone` resolves the credential for + clones. */
  repoUrl: string;
  /** The runner image to allocate (defaults to the terminal runner image). */
  runnerImage?: string;
  /** The org App installation, when the org installed the App (App-first clone token). */
  installation?: OrgGithubAppInstallation;
  /** The static fallback credential ref (a project/org GitHub credential). */
  githubCredentialRef: string;
  /** The runner identity key ref (same value the worker boot seeds). */
  identitySecretRef: string;
}

/** Everything the factory needs to allocate a runner + resolve a clone credential. */
export interface LiveJjWorkspaceDeps {
  facts: LiveJjWorkspaceFacts;
  /** The runner allocator (a short-lived runless runner is allocated against it). */
  allocator: Allocator;
  /** The live SSH substrate jj is shelled through (like git). */
  ssh: CommandSubstrate;
  /** The secret store the clone-token resolution reads from. */
  secrets: SecretStore;
  /** The provider that owns the App-first / static clone-token resolution policy. */
  vcsProvider: VcsProvider;
  /** The shared installation-token minter (its cache lives here). */
  githubAppMinter?: GithubAppTokenMinter;
  /** Per-jj-command timeout (ms); defaults to {@link DEFAULT_LIVE_JJ_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * A live jj workspace: the `JjWorkspaceVcsCore` bound to the allocated runner, plus a
 * `release()` finalizer the caller MUST run to release the runner. `release()` is LOUD
 * on a leak/failure (it re-throws after logging) — mirroring driveConflictResolve, a
 * leaked runner is a real cost+capacity fault, never silently swallowed. The clone-token
 * source ("github_app" | "static") is surfaced for diagnostics.
 */
export interface LiveJjWorkspace {
  core: WorkspaceVcsCore;
  /** The allocated runner the jj commands execute on. */
  target: RunnerHandle;
  /** The runner-local path the caller passes to `openWorkspace` for the clone. */
  workspacePath: string;
  /** Which credential the clone token came from (diagnostics). */
  tokenSource: "github_app" | "static" | "anonymous";
  /** Release the allocated runner. LOUD on a leak (re-throws after logging). */
  release: () => Promise<void>;
}

/**
 * Build a {@link LiveJjWorkspace}: (a) allocate a short-lived RUNLESS runner via the
 * `Allocator` (the same runless pattern driveConflictResolve uses — a synthetic naming
 * handle so a retained `runner_<runId>` row can't collide); (b) resolve the GitHub clone
 * token App-first then static via `vcsProvider.resolveToken` (the same thread
 * `cloneHeadForResolve` uses); (c) construct `JjWorkspaceVcsCore` over the live SSH
 * substrate + the allocated runner + the PRODUCTION `identityJjRefResolver` +
 * `autoSnapshotWorkingEdit` (real URL, real sha, jj auto-snapshot — no test seams); (d)
 * return the core + a LOUD-on-leak `release()` finalizer.
 *
 * FAIL-CLOSED: if the token resolution fails AFTER the runner was allocated, the runner
 * is released (LOUD on a leak) before the error re-throws — never a half-built workspace
 * and never a leaked runner. The caller still owns calling `release()` on success.
 */
export async function buildLiveJjWorkspace(deps: LiveJjWorkspaceDeps): Promise<LiveJjWorkspace> {
  const { facts } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_LIVE_JJ_TIMEOUT_MS;
  // RUNLESS: a synthetic `run_*` naming handle (satisfies `workspaceRepoPathForRun`'s
  // safe-id gate) so retained `runner_<runId>` rows from a real run can't collide with
  // this short-lived workspace, and the persisted FK columns stay NULL (no `runs` row).
  const handle = `run_live_jj_${crypto.randomUUID().replaceAll("-", "")}`;
  const allocation = await deps.allocator.allocate({
    runId: handle,
    projectId: facts.projectId,
    runnerImage: facts.runnerImage ?? DEFAULT_LIVE_JJ_RUNNER_IMAGE,
    identitySecretRef: facts.identitySecretRef,
    orgId: facts.orgId,
    runless: true,
    persistedRunId: null,
    persistedProjectId: facts.projectId,
  });

  // The LOUD-on-leak release finalizer (driveConflictResolve's exact shape): a leaked
  // runner is a real cost+capacity fault, so surface it rather than swallow it.
  const release = async (): Promise<void> => {
    await deps.allocator.release(allocation.runnerId, "completed").catch((error: unknown) => {
      console.error(
        `[live-jj-workspace] FAILED to release runner ${allocation.runnerId} for ${handle} — leaked runner:`,
        error,
      );
      throw error;
    });
  };

  try {
    // App-first, static fallback, anonymous only when NEITHER is configured — the same
    // policy `cloneHeadForResolve` threads. The provider owns the policy; we only decide
    // whether to ask at all (no installation AND no static ref ⇒ a public clone).
    const staticRef = facts.githubCredentialRef.trim();
    const tokenSource = await resolveCloneTokenSource(deps, staticRef);

    // Construct the jj core over the LIVE substrate + allocated runner with the
    // PRODUCTION defaults — identity ref resolver (real URL/sha) + auto-snapshot edit.
    // The conformance suite has already pinned every jj-CLI behavior; this is just the
    // live binding.
    const core = new JjWorkspaceVcsCore({
      substrate: deps.ssh,
      target: allocation.target,
      timeoutMs,
      refResolver: identityJjRefResolver,
      workingEdit: autoSnapshotWorkingEdit,
    });

    return {
      core,
      target: allocation.target,
      workspacePath: workspaceRepoPathForRun(handle),
      tokenSource,
      release,
    };
  } catch (error) {
    // FAIL-CLOSED: a half-built workspace must NOT leave a runner allocated. Release the
    // runner we already allocated (LOUD on a leak) before re-throwing the original error.
    await release().catch((releaseError: unknown) => {
      console.error(`[live-jj-workspace] release after a build failure ALSO failed for ${handle}:`, releaseError);
    });
    throw error;
  }
}

/**
 * Resolve the clone credential App-first / static-fallback (the policy
 * `cloneHeadForResolve` threads), returning ONLY which source it came from — the jj
 * `git clone` itself authenticates via the runner's own credential helper, so the factory
 * does not hold the token; it resolves to PROVE the credential exists (fail-closed: a
 * required-but-missing credential is a LOUD throw inside the provider) and to surface the
 * source for diagnostics. When neither an installation nor a static ref is configured the
 * target is public — anonymous clone, no resolution.
 */
async function resolveCloneTokenSource(
  deps: LiveJjWorkspaceDeps,
  staticRef: string,
): Promise<"github_app" | "static" | "anonymous"> {
  const { facts } = deps;
  if (facts.installation === undefined && staticRef === "") {
    return "anonymous";
  }
  const resolved = await deps.vcsProvider.resolveToken({
    secrets: deps.secrets,
    ...(facts.installation !== undefined && { installation: facts.installation }),
    ...(staticRef !== "" && { staticRef }),
    ...(deps.githubAppMinter !== undefined && { minter: deps.githubAppMinter }),
  });
  return resolved.source;
}
