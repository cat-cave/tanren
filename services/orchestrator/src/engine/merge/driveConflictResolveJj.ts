// The jj-backed drive-path conflict resolve (tanren-owns-the-engine.md §2/§5,
// Wave-3/S1 cutover). Extracted from driveConflictResolve.ts to keep BOTH files under
// the 500-line + 12-dependency architecture caps: this owns the jj branch (allocate a
// live jj workspace, build the jj applier, run the resolver over jj's FIRST-CLASS
// conflicts), while driveConflictResolve.ts keeps the classify/cap/yield wrapper + the
// git kill-switch path. The flag (`conflictResolverJjLive`) selects between them.

import type { RunnerHandle } from "../contracts/allocator.js";
import type { OrgGithubAppInstallation } from "../config/orgConfig.js";
import type { ConflictResolverHook } from "../workflow/reviewMerge/index.js";
import {
  buildJjConflictApplier,
  type JjConflictApplierFacts,
} from "../workflow/reviewMerge/conflictResolver/jjWorkspaceApplier.js";
import { buildLiveJjWorkspace } from "../providers/liveJjWorkspace.js";

/** The repo/branch + tenancy facts the jj drive resolve allocates + rebases against. */
export interface DriveJjResolveFacts {
  orgId: string;
  projectId: string;
  repoUrl: string;
  baseBranch: string;
  headBranch: string;
  runnerImage: string;
  installation?: OrgGithubAppInstallation;
  githubCredentialRef: string;
  identitySecretRef: string;
}

/** Everything the jj drive resolve needs to provision the live workspace + assemble the resolver. */
export interface DriveJjResolveDeps {
  facts: DriveJjResolveFacts;
  allocator: Parameters<typeof buildLiveJjWorkspace>[0]["allocator"];
  ssh: Parameters<typeof buildLiveJjWorkspace>[0]["ssh"];
  secrets: Parameters<typeof buildLiveJjWorkspace>[0]["secrets"];
  vcsProvider: Parameters<typeof buildLiveJjWorkspace>[0]["vcsProvider"];
  githubAppMinter?: Parameters<typeof buildLiveJjWorkspace>[0]["githubAppMinter"];
  timeoutMs: number;
  /**
   * Assemble the intent-preserving resolver over the live workspace's runner + path +
   * the jj applier. The caller (driveConflictResolve) owns building the adapters + the
   * re-gate over the SAME runner + path the applier resolves into, so the re-gate
   * judges the jj-resolved tree. `baseSha` is the re-gate baseline (the merge-time base
   * branch the resolved tree sits on).
   */
  buildResolver: (input: {
    target: RunnerHandle;
    workspacePath: string;
    baseSha: string;
    applier: ReturnType<typeof buildJjConflictApplier>;
  }) => ConflictResolverHook;
}

/**
 * The jj-backed drive resolve (the Wave-3/S1 cutover default): allocate a live jj
 * workspace, build the jj applier over it, assemble the resolver over the SAME runner +
 * path (so the re-gate judges the jj-resolved tree), and run it. The jj applier owns
 * releasing the live workspace on its terminal step, so the workspace is released
 * exactly once — here we only release on a build/run failure BEFORE the applier took
 * ownership (its `gather()` had not yet run). FAIL-CLOSED throughout: `buildLiveJjWorkspace`
 * never returns a half-built workspace, and a failure releases the runner loudly.
 */
export async function driveResolveOverJj(
  deps: DriveJjResolveDeps,
  conflictContext: Parameters<ConflictResolverHook>[0],
): Promise<{ resolved: boolean }> {
  const { facts } = deps;
  const live = await buildLiveJjWorkspace({
    facts: {
      orgId: facts.orgId,
      projectId: facts.projectId,
      repoUrl: facts.repoUrl,
      runnerImage: facts.runnerImage,
      ...(facts.installation !== undefined && { installation: facts.installation }),
      githubCredentialRef: facts.githubCredentialRef,
      identitySecretRef: facts.identitySecretRef,
    },
    allocator: deps.allocator,
    ssh: deps.ssh,
    secrets: deps.secrets,
    vcsProvider: deps.vcsProvider,
    ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
    timeoutMs: deps.timeoutMs,
  });
  const applier = buildJjConflictApplier({
    live,
    ssh: deps.ssh,
    secrets: deps.secrets,
    vcsProvider: deps.vcsProvider,
    ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
    facts: jjApplierFacts(facts),
    timeoutMs: deps.timeoutMs,
  });
  try {
    // The re-gate baseline is the merge-time base branch tip (the resolved tree sits on
    // it after the rebase). The adapters + re-gate run over the jj workspace's runner +
    // path so they judge the jj-resolved tree the applier produced.
    const resolver = deps.buildResolver({
      target: live.target,
      workspacePath: live.workspacePath,
      baseSha: facts.baseBranch,
      applier,
    });
    return await resolver(conflictContext);
  } catch (error) {
    // FAIL-CLOSED: a failure BEFORE the applier's gather() took workspace ownership
    // would leak the runner — release it loudly. (Once gather() runs, the applier's
    // terminal publish/abort owns release; releasing twice is a no-op there.)
    await live.release();
    throw error;
  }
}

/** The jj applier's repo/branch facts for the drive pass (rebase onto the base bookmark). */
function jjApplierFacts(facts: DriveJjResolveFacts): JjConflictApplierFacts {
  return {
    repoUrl: facts.repoUrl,
    baseBranch: facts.baseBranch,
    // The freshly-cloned base bookmark jj imports (`<baseBranch>@origin`) — the
    // merge-time base the PR head is rebased onto (never-discard, conflict recorded).
    baseRevision: `${facts.baseBranch}@origin`,
    headBranch: facts.headBranch,
    ...(facts.installation !== undefined && { installation: facts.installation }),
    githubCredentialRef: facts.githubCredentialRef,
  };
}
