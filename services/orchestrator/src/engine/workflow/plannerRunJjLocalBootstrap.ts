// WS-A PR-4 (walker-jj-local-integration-design.md §2.1, §4) — the jj-LOCAL base bootstrap
// variant of the run's workspace clone, extracted from plannerRunWorkspace.ts to keep that
// file under the 500-line architecture cap.
//
// When a DEPENDENT speculative run carries a non-empty ancestor stack AND
// `WALKER_JJ_LOCAL_BASE` is on (default-OFF), its base is jj-ASSEMBLED LOCALLY from the
// real ancestor PR-head refs on the run's OWN runner (`bootstrapDependentBase`) — REPLACING
// the legacy single-ref clone of an orchestrator-synthesized `tanren/integ/<dep>` host ref.
// The chooser lives in plannerRunWorkspace's `cloneWorkspace`; this module owns the
// bootstrap arm + the shared `ClonedWorkspace` result.
import type { RunnerHandle } from "../contracts/allocator.js";
import { githubHttpsRemote, parseGitHubRepository } from "../providers/github.js";
import {
  bootstrapDependentBase,
  bootstrapLocalIntegrationRef,
  type BuildBootstrapWorkspacePort,
} from "../dag/jjLocalBootstrap.js";
import type { AncestorStack } from "../dag/ancestorStack.js";
import type { LiveJjWorkspace, LiveJjWorkspaceDeps } from "../providers/liveJjWorkspace.js";
import {
  autoSnapshotWorkingEdit,
  identityJjRefResolver,
  type JjCloneCredential,
  JjWorkspaceVcsCore,
} from "../providers/jjWorkspaceVcsCore.js";
import type { RunPlannerLoopInput } from "./plannerRun.js";
import type { ResolvedCloneCredential } from "./plannerRunWorkspace.js";

/**
 * The clone outcome: the workspace's clone-HEAD sha, plus (WS-A PR-4, jj-local bootstrap
 * path ONLY) the LOCAL assembly bookmark name the conflict resolver's merge-time base
 * rebases onto. Absent `bootstrappedBaseRevision` ⇒ the legacy single-ref clone ran.
 */
export interface ClonedWorkspace {
  cloneHeadSha: string;
  bootstrappedBaseRevision?: string;
}

/**
 * WS-A PR-4 (walker-jj-local-integration-design.md §2.1) — the jj-local bootstrap variant
 * of the run's workspace clone. Assembles `default_branch + ordered ancestor PR-head refs`
 * jj-LOCALLY on the run's OWN allocated runner + `workspacePath` (NO extra allocation),
 * creates the run branch AT the assembled head, and KEEPS the workspace's checkout in place
 * for the writer loop — exactly the §2.1 bootstrap. The assembled head sha becomes the
 * run's clone-HEAD (the writer's replay base), and the LOCAL assembly bookmark name becomes
 * the conflict resolver's merge-time `baseRevision`.
 *
 * WORKSPACE HANDOFF: `bootstrapDependentBase` opens its workspace via an injected
 * {@link BuildBootstrapWorkspacePort}. Here that port hands back a {@link LiveJjWorkspace}
 * bound to the RUN's existing runner (`target`) + `workspacePath` — so the jj `--colocate`
 * clone materializes the assembled base as a REAL git checkout AT the run's `workspacePath`,
 * and every downstream plain-`git` SSH op (bootstrap install, contract files, the gate, the
 * PR push, cleanup) runs against it UNCHANGED. Its `release` is a no-op: the run's own
 * `finally` owns releasing `allocation.target`, so the bootstrap must NOT release the runner
 * the writer loop is about to use. A conflict during assembly is a fail-closed THROW here —
 * the walker's HOLD/route control flow gates this at enqueue (§2.1.4), so a dependent that
 * reaches bootstrap is expected to assemble cleanly; a conflict at this late point is a real
 * fault, not a silent degrade.
 */
export async function bootstrapDependentWorkspace(
  input: RunPlannerLoopInput,
  target: RunnerHandle,
  workspacePath: string,
  resolved: ResolvedCloneCredential,
  stack: AncestorStack,
): Promise<ClonedWorkspace> {
  const context = input.context;
  // The clone credential `jj git clone` authenticates the multi-ref FETCH with — the SAME
  // App-first/static token the legacy clone uses, normalized to the HTTPS remote (absent on
  // a genuinely public/anonymous clone). The token rides only through the core's stdin-fed
  // askpass helper, never the command line.
  const cloneCredential: JjCloneCredential | undefined =
    resolved.token === undefined
      ? undefined
      : { token: resolved.token, httpsRemote: githubHttpsRemote(parseGitHubRepository(context.repoUrl)) };
  // The port that hands `bootstrapDependentBase` a workspace bound to the RUN's OWN runner +
  // path (no allocation) with a NO-OP release (the run's `finally` owns the real release).
  const buildWorkspace: BuildBootstrapWorkspacePort = async (): Promise<LiveJjWorkspace> => ({
    core: new JjWorkspaceVcsCore({
      substrate: input.ssh,
      target,
      timeoutMs: input.timeoutMs,
      refResolver: identityJjRefResolver,
      workingEdit: autoSnapshotWorkingEdit,
      ...(cloneCredential !== undefined && { cloneCredential }),
    }),
    target,
    workspacePath,
    tokenSource: resolved.token === undefined ? "anonymous" : "static",
    // NO-OP: the run's own `finally` releases `allocation.target`; the bootstrap must not
    // release the runner the writer loop is about to commit on.
    release: async () => {},
  });
  // `integrateOverWorkspace` reads only `ssh` off the deps; the workspace itself comes from
  // the port above (the run's runner), so no runner is allocated here.
  const workspaceDeps = { ssh: input.ssh } as unknown as LiveJjWorkspaceDeps;
  const result = await bootstrapDependentBase(
    stack,
    workspaceDeps,
    {
      repoUrl: context.repoUrl,
      // The stack assembles ONTO the run's `targetBranch` (the real history root — under the
      // jj-local model this is `default_branch`, NOT a synthesized integration ref).
      baseBranch: context.targetBranch,
      runBranch: context.runBranch,
      timeoutMs: input.timeoutMs,
    },
    buildWorkspace,
  );
  if (result.outcome !== "bootstrapped") {
    // FAIL-CLOSED: a spec-vs-spec assembly conflict at bootstrap is a hard fault. The walker
    // pre-checks the stack at enqueue (§2.1.4) + HOLDS a conflicting dependent, so a clean
    // dependent reaching here is the invariant; a conflict is never a silent degrade.
    throw new Error(
      `jj-local bootstrap: ancestor stack for ${context.runBranch} conflicts ` +
        `(${result.conflictBetween.specId} vs ${result.conflictBetween.otherSpecId}): ${result.message}`,
    );
  }
  // The assembled head is the run's clone-HEAD; the LOCAL assembly bookmark is the
  // conflict resolver's merge-time base (a stable, deterministic name — NEVER a host ref).
  return {
    cloneHeadSha: result.headSha,
    bootstrappedBaseRevision: bootstrapLocalIntegrationRef(context.runBranch),
  };
}
