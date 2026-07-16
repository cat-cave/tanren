// WS-A PR-4 (walker-jj-local-integration-design.md §2.1, §4) — the jj-LOCAL base bootstrap
// variant of the run's workspace clone, extracted from plannerRunWorkspace.ts to keep that
// file under the 500-line architecture cap.
//
// When a DEPENDENT speculative run carries a non-empty ancestor stack, its base
// is jj-ASSEMBLED LOCALLY from the
// real ancestor PR-head refs on the run's OWN runner (`bootstrapDependentBase`) — REPLACING
// the legacy single-ref clone of an orchestrator-synthesized `tanren/integ/<dep>` host ref.
// The chooser lives in plannerRunWorkspace's `cloneWorkspace`; this module owns the
// bootstrap arm + the shared `ClonedWorkspace` result.
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { RunnerHandle } from "../contracts/allocator.js";
import { githubHttpsRemote, parseGitHubRepository } from "../providers/github.js";
import {
  type AncestorPhaseBySpecId,
  bootstrapDependentBase,
  type BootstrapDependentBaseSuccess,
  bootstrapLocalIntegrationRef,
  type BuildBootstrapWorkspacePort,
} from "../dag/jjLocalBootstrap.js";
import type { AncestorStack } from "../dag/ancestorStack.js";
import { SpeculativeAssemblyError } from "../dag/speculativeAssemblyError.js";
import { classifySpecStatus } from "../dag/walkerPg.js";
import type { AncestorSpecPhase } from "../dag/jjLocalIntegration.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { LiveJjWorkspace, LiveJjWorkspaceDeps } from "../providers/liveJjWorkspace.js";
import {
  autoSnapshotWorkingEdit,
  identityJjRefResolver,
  type JjCloneCredential,
  type JjCommitIdentity,
  JjWorkspaceVcsCore,
} from "../providers/jjWorkspaceVcsCore.js";
import { createLogger } from "../observability/logger.js";
import type { RunPlannerLoopInput } from "./plannerRun.js";
import { recordEagerBaseNode } from "./plannerRunEagerBaseNode.js";
import type { ResolvedCloneCredential } from "./plannerRunWorkspace.js";

export {
  buildEagerBaseNodeUpsert,
  type EagerBaseNodeUpsert,
  type EagerBaseNodeUpsertFacts,
} from "./plannerRunEagerBaseNode.js";

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
 * WS-A PR-8c — the Pg-backed {@link BootstrapStackHeadShaWriteBack} the run worker wires:
 * an UPDATE of `runs.ancestor_stack` with the head-sha-filled ordered stack. It replaces
 * the WHOLE jsonb — the assembly is the authoritative source of the stack's per-ancestor
 * shas, and the order is unchanged, so this is idempotent.
 *
 * PLANE-SPLIT: `runs` is a CONTROL-PLANE table the de-privileged data plane can no longer
 * write directly (migration 0035). So when a `RunStateWriter` is wired (remote-writes on)
 * this routes through it — reusing `setRunSpeculativeBase`, whose SQL is BYTE-IDENTICAL
 * (`UPDATE runs SET ancestor_stack = $2::jsonb WHERE run_id = $1`). Absent a writer (the
 * in-process dev path), it runs the same org-scoped UPDATE on the worker pool directly.
 */
export function buildBootstrapStackHeadShaWriteBack(
  pool: pg.Pool,
  writer?: RunStateWriter,
): BootstrapStackHeadShaWriteBack {
  return async (facts) => {
    if (writer !== undefined) {
      await writer.setRunSpeculativeBase({ runId: facts.runId, orgId: facts.orgId, ancestorStack: facts.stack });
      return;
    }
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
 * The facts the ancestor-phase read needs: the org tenant key (RLS) + the ancestor spec ids
 * to classify. Mirrors {@link EagerBaseNodeUpsertFacts}'s org-scoped-port shape.
 */
export interface AncestorPhaseReadFacts {
  orgId: string;
  /** The distinct ancestor spec ids whose lifecycle bucket the assembly needs. */
  specIds: ReadonlyArray<string>;
}

/**
 * A port that reads each ancestor spec's LIFECYCLE BUCKET (`classifySpecStatus` of
 * `specs.status`) at bootstrap time, org-scoped (RLS). Threaded into the assembly so the
 * "ancestor branch gone, not merged" case can benign-WAIT (re-driven) when the ancestor spec
 * is still non-terminal (`pending`/`in_flight` — it WILL publish a head) instead of TERMINALLY
 * stranding the dependent — vs. a LOUD fault for a TERMINAL ancestor (`terminal_blocked`) that
 * never will. Injected as a port (like {@link EagerBaseNodeUpsert}) so the bootstrap
 * unit/conformance paths drive it without a live DB, and so it gets a REAL `pg.Pool` (the run
 * loop's `input.pool` is only a query client, not a connect-capable pool for `runWithOrgScope`).
 */
export type AncestorPhaseReader = (facts: AncestorPhaseReadFacts) => Promise<AncestorPhaseBySpecId>;

/**
 * The Pg-backed {@link AncestorPhaseReader} the run worker wires: an org-scoped read of
 * `specs.status` mapped through `classifySpecStatus`. FAIL-CLOSED: a spec the scoped read does
 * NOT return (off-scope, deleted, unreadable) is simply ABSENT from the map ⇒ the assembly's
 * loud-throw default (we never assume a non-terminal phase we could not read).
 */
export function buildAncestorPhaseReader(pool: pg.Pool): AncestorPhaseReader {
  return async (facts) => {
    const phases = new Map<string, AncestorSpecPhase>();
    if (facts.specIds.length === 0) return phases;
    await runWithOrgScope(pool, facts.orgId, async (client) => {
      const result = await client.query<{ spec_id: string; status: string }>(
        "SELECT spec_id, status FROM specs WHERE spec_id = ANY($1::text[])",
        [[...facts.specIds]],
      );
      for (const row of result.rows) {
        phases.set(row.spec_id, classifySpecStatus(row.status));
      }
    });
    return phases;
  };
}

/**
 * Resolve the ancestor specs' lifecycle buckets via the injected {@link AncestorPhaseReader}
 * (when wired). Returns an EMPTY map — the assembly's fail-closed loud default — when no reader
 * is wired (a unit path), the run has no org (CLI), the stack is empty, or the read FAILS.
 *
 * FAIL-CLOSED: a read failure is loud-logged + treated as "no phases known" (the loud default
 * everywhere it matters), NEVER silently turning a real missing-ancestor fault into a benign
 * wait — only a phase we positively READ as non-terminal makes a member benign.
 */
async function readAncestorPhases(input: RunPlannerLoopInput, stack: AncestorStack): Promise<AncestorPhaseBySpecId> {
  const reader = input.ancestorPhaseReader;
  const orgId = input.context.orgId;
  if (reader === undefined || orgId === undefined || orgId === null || stack.length === 0) {
    return new Map();
  }
  const specIds = [...new Set(stack.map((ancestor) => ancestor.specId))];
  try {
    return await reader({ orgId, specIds });
  } catch (error) {
    log.warn(
      "ancestor-phase read for the dependent bootstrap failed (members default to fail-closed loud)",
      { runBranch: input.context.runBranch, projectId: input.context.projectId },
      error,
    );
    return new Map();
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
  // MERGE-SAFETY (self-identity): thread the resolved BOT identity into the jj core as its
  // `commitIdentity` so EVERY commit this assembly authors attributes to the bot login the
  // external-change gate recognizes as Tanren's. Without this the core falls back to its
  // `tanren@local` default — so `core.branch(ws, runBranch, localRef)`'s `jj new` working
  // commit (the run branch head the writer commits onto, which lands on the dependent's PR
  // branch) is authored `tanren@local` → GitHub reports a NULL author → the gate keys it
  // `<unknown>` → external → an `autonomy: auto` PR BLOCKS with no operator to approve it
  // (the no-PR-ever-merged root cause for a dependent/template build). `resolved.identity`
  // is the SAME identity the run's git writer commits as (resolveCloneCredential), so the
  // jj-authored run-branch head and the git-authored writer commits agree on the bot login.
  //
  // FAIL-CLOSED: an AUTHENTICATED clone (a token is present) MUST carry a resolved bot
  // identity — `resolveCloneCredential` throws loudly when an authenticated run cannot
  // resolve one, so a token WITHOUT an identity here is an invariant breach (mirrors
  // `resolveBotPushIdentity`'s loud-throw contract); we refuse rather than silently fall
  // back to `tanren@local`. The genuinely UNAUTHENTICATED public path (no token) has no
  // identity and uses the core's non-attributable default (it never pushes as Tanren).
  if (resolved.token !== undefined && resolved.identity === undefined) {
    throw new SpeculativeAssemblyError(
      "missing_clone_identity",
      `jj-local bootstrap: authenticated clone of ${context.runBranch} resolved a token but NO bot ` +
        `identity — refusing to author the assembled run branch as the unattributable tanren@local ` +
        `default (it would block the PR as an <unknown> external change)`,
    );
  }
  const commitIdentity: JjCommitIdentity | undefined =
    resolved.identity === undefined
      ? undefined
      : { name: resolved.identity.login, email: resolved.identity.noreplyEmail };
  // The port that hands `bootstrapDependentBase` a workspace bound to the RUN's OWN runner +
  // path (no allocation) with a NO-OP release (the run's `finally` owns the real release).
  const buildWorkspace: BuildBootstrapWorkspacePort = async (): Promise<LiveJjWorkspace> => ({
    core: new JjWorkspaceVcsCore({
      substrate: input.ssh,
      target,
      refResolver: identityJjRefResolver,
      workingEdit: autoSnapshotWorkingEdit,
      ...(commitIdentity !== undefined && { commitIdentity }),
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
  // The ancestor specs' lifecycle buckets at bootstrap time — so a missing-but-not-merged
  // ancestor whose SPEC is still non-terminal benign-WAITS (re-driven) rather than stranding.
  const phaseBySpecId = await readAncestorPhases(input, stack);
  const result = await bootstrapDependentBase(
    stack,
    workspaceDeps,
    {
      repoUrl: context.repoUrl,
      // The stack assembles ONTO the run's `targetBranch` (the real history root — under the
      // jj-local model this is `default_branch`, NOT a synthesized integration ref).
      baseBranch: context.targetBranch,
      runBranch: context.runBranch,
    },
    phaseBySpecId,
    buildWorkspace,
  );
  if (result.outcome !== "bootstrapped") {
    // FAIL-CLOSED: a spec-vs-spec assembly conflict at bootstrap is a hard fault. The walker
    // pre-checks the stack at enqueue (§2.1.4) + HOLDS a conflicting dependent, so a clean
    // dependent reaching here is the invariant; a conflict is never a silent degrade.
    throw new SpeculativeAssemblyError(
      "bootstrap_conflict",
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
