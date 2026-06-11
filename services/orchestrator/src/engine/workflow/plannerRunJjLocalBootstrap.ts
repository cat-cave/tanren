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
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { RunnerHandle } from "../contracts/allocator.js";
import { githubHttpsRemote, parseGitHubRepository } from "../providers/github.js";
import {
  bootstrapDependentBase,
  type BootstrapDependentBaseSuccess,
  bootstrapLocalIntegrationRef,
  type BuildBootstrapWorkspacePort,
} from "../dag/jjLocalBootstrap.js";
import type { AncestorStack } from "../dag/ancestorStack.js";
import { PgIntegrationNodeModel } from "../dag/integrationNodesPg.js";
import type { LiveJjWorkspace, LiveJjWorkspaceDeps } from "../providers/liveJjWorkspace.js";
import {
  autoSnapshotWorkingEdit,
  identityJjRefResolver,
  type JjCloneCredential,
  JjWorkspaceVcsCore,
} from "../providers/jjWorkspaceVcsCore.js";
import { createLogger } from "../observability/logger.js";
import type { RunPlannerLoopInput } from "./plannerRun.js";
import type { ResolvedCloneCredential } from "./plannerRunWorkspace.js";

const log = createLogger("jj-local-bootstrap");

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
 * WS-A PR-8 (walker-jj-local-integration-design.md §2.3, §6 fork F4) — the facts the
 * dependent bootstrap records the `eager_base` integration node from. The SAME assembly
 * `bootstrapDependentBase` just performed: the org/project tenant key, the real base
 * branch the stack assembled ONTO (`main`), the LOCAL assembly bookmark (`ref`, matching
 * how the batch path uses `integration_nodes.ref`), and the ORDERED members
 * (`{specId, runId, branch, headSha}`) the proof-reuse `memberKey` keys on.
 */
export interface EagerBaseNodeUpsertFacts {
  orgId: string;
  projectId: string;
  /** The real base branch the stack assembled ONTO (the run's `targetBranch` — `main`). */
  baseBranch: string;
  /** The LOCAL assembly bookmark the stack materialized as (NEVER a host ref). */
  ref: string;
  /** The ORDERED ancestor members (DAG order is LOAD-BEARING for the `memberKey`). */
  members: ReadonlyArray<{ specId: string; runId: string; branch: string; headSha: string }>;
  /** The assembled head sha (`main + ordered ancestors`) — the node's materialized head. */
  headSha: string;
  /** The assembled head's git tree hash (the content identity proof reuse keys on). */
  treeHash: string;
}

/**
 * WS-A PR-8 — the OBSERVE-ONLY port the dependent bootstrap UPSERTs its `eager_base`
 * integration node through. It records the node into the SAME proof-reuse substrate the
 * batch path's `merge_batch` node uses (`integration_nodes`), so the host-meaningful
 * identity (`members[].branch` + `headSha`) + the `memberKey` participate in proof reuse.
 *
 * It NEVER gates the run: a failure is loud-logged (the §6-style observability write
 * pattern, mirroring `observeRunAsIntegrationNode`) and swallowed — the proof-reuse
 * substrate is NOT the merge authority. Org-scoped (RLS) — the write carries the org key.
 * Injected as a port so the bootstrap unit/conformance paths drive it without a live DB.
 */
export type EagerBaseNodeUpsert = (facts: EagerBaseNodeUpsertFacts) => Promise<void>;

/**
 * The Pg-backed {@link EagerBaseNodeUpsert} the run worker wires (mirrors
 * `buildNativeQueueEnqueuer`): an org-scoped `PgIntegrationNodeModel.upsertNode` over the
 * worker's real pool. The (org, member_key) unique index makes a re-bootstrap of the SAME
 * base + ordered ancestors IDEMPOTENT (an UPSERT, not a duplicate row).
 */
export function buildEagerBaseNodeUpsert(pool: pg.Pool): EagerBaseNodeUpsert {
  const model = new PgIntegrationNodeModel(pool);
  return async (facts) => {
    await model.upsertNode({
      projectId: facts.projectId,
      orgId: facts.orgId,
      baseBranch: facts.baseBranch,
      // The bootstrap materializes the assembled head, not the pristine `main` sha; the
      // base branch name is the honest base identity (the same convenience
      // `observeRunAsIntegrationNode` records — the assembly carries the head, not the
      // `main` SHA). The `memberKey` keys on this + the ordered member shas.
      baseSha: facts.baseBranch,
      ref: facts.ref,
      // FORK F4: reuse `eager_base` (a valid CHECK value — no migration); the label only
      // tags intent, it NEVER branches control flow.
      purpose: "eager_base",
      members: facts.members.map((m) => ({
        specId: m.specId,
        runId: m.runId,
        branch: m.branch,
        headSha: m.headSha,
      })),
      headSha: facts.headSha,
      treeHash: facts.treeHash,
      // The dependent's base is assembled + ready for the writer to commit onto.
      status: "ready",
    });
  };
}

/**
 * WS-A PR-8c (walker-jj-local-integration-design.md §2.3) — the facts the dependent
 * bootstrap writes the per-ancestor head shas BACK into `runs.ancestor_stack[].headSha`
 * from. At enqueue the walker writes the stack with EMPTY/placeholder `headSha` (it does
 * not yet know the assembled head shas); the bootstrap assembly is where the real
 * per-ancestor pristine PR-head shas are captured (`memberHeadShas`). This write-back
 * folds those shas into the persisted stack so percolation's DIVERGENCE KEY reads them
 * from `ancestor_stack[].headSha` (the read previously came from the legacy
 * `integrated_ancestor_shas` the deleted integrator captured at enqueue).
 */
export interface BootstrapStackHeadShaWriteBackFacts {
  orgId: string;
  runId: string;
  /** The ordered stack with the assembly-captured `headSha` zipped in (DAG order). */
  stack: AncestorStack;
}

/**
 * WS-A PR-8c — the write-back port the dependent bootstrap folds the assembly-captured
 * per-ancestor head shas into `runs.ancestor_stack[].headSha` through. Org-scoped (RLS);
 * IDEMPOTENT (re-writing the same shas is a no-op). Like {@link EagerBaseNodeUpsert} it
 * NEVER gates the run: a failure is loud-logged + swallowed (the divergence key it feeds
 * is recoverable — a missing head sha drops the entry from the detect, never bricks). It
 * is injected as a port so the bootstrap unit/conformance paths drive it without a live DB.
 */
export type BootstrapStackHeadShaWriteBack = (facts: BootstrapStackHeadShaWriteBackFacts) => Promise<void>;

/**
 * WS-A PR-8c — the Pg-backed {@link BootstrapStackHeadShaWriteBack} the run worker wires
 * (mirrors `buildEagerBaseNodeUpsert`): an org-scoped UPDATE of `runs.ancestor_stack` over
 * the worker's real pool, so the write lands RLS-scoped (an off-scope run sees zero rows
 * and updates nothing). It replaces the WHOLE jsonb with the head-sha-filled ordered stack
 * — the assembly is the authoritative source of the stack's per-ancestor shas, and the
 * order is unchanged, so this is idempotent.
 */
export function buildBootstrapStackHeadShaWriteBack(pool: pg.Pool): BootstrapStackHeadShaWriteBack {
  return async (facts) => {
    await runWithOrgScope(pool, facts.orgId, async (client) => {
      await client.query("UPDATE runs SET ancestor_stack = $2::jsonb WHERE run_id = $1", [
        facts.runId,
        JSON.stringify([...facts.stack]),
      ]);
    });
  };
}

/**
 * WS-A PR-8c — fold the assembly-captured per-ancestor head shas back into
 * `runs.ancestor_stack[].headSha`. Zips the ordered ancestor `stack` with the per-ancestor
 * pristine head shas the assembly captured (`memberHeadShas`, keyed by spec id) — the SAME
 * order as the persisted stack — and writes the head-sha-filled stack back so percolation's
 * divergence key reads the shas from `ancestor_stack`. A failure NEVER breaks the run: it is
 * loud-logged + swallowed (the divergence key is recoverable). A null org (no tenant key)
 * is skipped (nothing to RLS-scope to).
 */
async function recordBootstrapStackHeadShas(
  writeBack: BootstrapStackHeadShaWriteBack,
  input: RunPlannerLoopInput,
  stack: AncestorStack,
  bootstrapped: BootstrapDependentBaseSuccess,
): Promise<void> {
  const orgId = input.context.orgId;
  if (orgId === undefined || orgId === null) {
    // A null-org (CLI) run has no tenant key to scope a tenant write to — skip it.
    return;
  }
  try {
    await writeBack({
      orgId,
      runId: input.context.runId,
      stack: stack.map((ancestor) => ({
        specId: ancestor.specId,
        runId: ancestor.runId,
        branch: ancestor.branch,
        // The pristine ancestor PR-head sha captured AT assembly time (the divergence key
        // percolation reads off `ancestor_stack[].headSha`), zipped in by spec id; "" only
        // if the assembly did not surface it (it always does for a real assembly).
        headSha: bootstrapped.memberHeadShas[ancestor.specId] ?? "",
      })),
    });
  } catch (error) {
    // The divergence key is recoverable (a missing head sha drops the entry from the detect,
    // never bricks the run) — a write-back failure must NEVER break the run. Loud-log + go on.
    log.warn(
      "bootstrap ancestor_stack head-sha write-back failed (non-fatal)",
      { runBranch: input.context.runBranch, projectId: input.context.projectId },
      error,
    );
  }
}

/**
 * WS-A PR-8 — OBSERVE-ONLY: record the `eager_base` integration node for the just-assembled
 * dependent base. Zips the ordered ancestor `stack` (`specId`/`runId`/`branch`) with the
 * per-ancestor pristine head shas the assembly captured (`memberHeadShas`, keyed by spec id)
 * — the SAME ordered member shape the batch path records, so the node shares the proof-reuse
 * substrate. A failure NEVER breaks the run: it is loud-logged + swallowed (the substrate is
 * not the merge authority). A null org (no tenant key) is skipped (nothing to RLS-scope to).
 */
async function recordEagerBaseNode(
  upsert: EagerBaseNodeUpsert,
  input: RunPlannerLoopInput,
  stack: AncestorStack,
  bootstrapped: BootstrapDependentBaseSuccess,
): Promise<void> {
  const orgId = input.context.orgId;
  if (orgId === undefined || orgId === null) {
    // A null-org (CLI) run has no tenant key to scope a tenant write to — skip it.
    return;
  }
  try {
    await upsert({
      orgId,
      projectId: input.context.projectId,
      baseBranch: input.context.targetBranch,
      ref: bootstrapped.localRef,
      members: stack.map((ancestor) => ({
        specId: ancestor.specId,
        runId: ancestor.runId,
        branch: ancestor.branch,
        // The pristine ancestor PR-head sha captured AT assembly time (the divergence
        // key the `memberKey` hashes), zipped in by spec id; "" only if the assembly did
        // not surface it (it always does for a real assembly).
        headSha: bootstrapped.memberHeadShas[ancestor.specId] ?? "",
      })),
      headSha: bootstrapped.headSha,
      treeHash: bootstrapped.treeHash,
    });
  } catch (error) {
    // OBSERVE-ONLY: the proof-reuse substrate is NOT the merge authority — a node-write
    // failure must NEVER break the run. Loud-log (don't silently swallow) and continue.
    log.warn(
      "observe-only eager_base integration-node UPSERT failed (non-fatal)",
      { runBranch: input.context.runBranch, projectId: input.context.projectId },
      error,
    );
  }
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
  // WS-A PR-8 (§2.3, fork F4): OBSERVE-ONLY — record the `eager_base` integration node for
  // the assembled base into the SAME proof-reuse substrate the batch path uses. This runs
  // AFTER the assembly succeeded and does NOT gate the run: a failure is loud-logged +
  // swallowed inside `recordEagerBaseNode` (the substrate is not the merge authority). The
  // port is absent on unit paths that do not exercise the node write.
  if (input.eagerBaseNodeUpsert !== undefined) {
    await recordEagerBaseNode(input.eagerBaseNodeUpsert, input, stack, result);
  }
  // WS-A PR-8c (§2.3): fold the assembly-captured per-ancestor head shas BACK into
  // `runs.ancestor_stack[].headSha` (additive — at enqueue the stack entries carry an
  // empty placeholder headSha; the assembly fills them). Percolation's divergence key
  // then reads the shas from `ancestor_stack` (replacing the legacy
  // `integrated_ancestor_shas` the deleted integrator captured at enqueue). Like the
  // eager-base record this does NOT gate the run: a failure is loud-logged + swallowed
  // inside `recordBootstrapStackHeadShas`. The port is absent on unit paths that do not
  // exercise the write-back.
  if (input.bootstrapStackHeadShaWriteBack !== undefined) {
    await recordBootstrapStackHeadShas(input.bootstrapStackHeadShaWriteBack, input, stack, result);
  }
  // The assembled head is the run's clone-HEAD; the LOCAL assembly bookmark is the
  // conflict resolver's merge-time base (a stable, deterministic name — NEVER a host ref).
  return {
    cloneHeadSha: result.headSha,
    bootstrappedBaseRevision: bootstrapLocalIntegrationRef(context.runBranch),
  };
}
