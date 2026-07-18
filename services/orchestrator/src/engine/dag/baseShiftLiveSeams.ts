// The LIVE base-shift seams (tanren-owns-the-engine.md §3 never-discard, §0 fail-closed) —
// the ONE unconditional base-shift mechanism. A base shift ACTUALLY
// rebases the dependent's existing branch onto the shifted base over a live allocated
// runner, re-gates it, and resolves a recorded conflict in place — never-discard, never a
// silent merge. Three seams, each fail-closed (any infra/alloc/clone/gate/resolver failure
// throws, which the coordinator maps to a loud `BaseShiftHeldError`: the work SURVIVES):
//
//   • LiveBaseShiftWorkspaceProvider — BOTH the `BaseShiftWorkspaceOpener` (allocate a live
//     jj workspace via A1's `buildLiveJjWorkspace`, clone the shifted base, track the
//     dependent's OWN head branch, resolve the rebase target) AND the `WorkspaceVcsCore`
//     the coordinator's `rebaseOnto` runs over (it delegates to the per-shift live core,
//     then RELEASES the runner — the coordinator only ever calls `workspace.rebaseOnto`,
//     once, so release-after-rebase leaks nothing).
//   • LiveBaseShiftReGate — the fresh-runner native gate (`runFreshRunnerMergeGate`, the
//     SAME re-gate machinery the queued-run / drive re-gates use) over the rebased head;
//     `passed`→clean, `failed`→replan-or-hold, a throw→HOLD (never merge unverified).
//   • LiveBaseShiftConflictResolver — the answerer-backed Slice-1 jj resolver
//     (`buildDefaultConflictResolver` + the `JjWorkspaceConflictApplier`) over a freshly
//     provisioned live jj workspace (mirroring `driveResolveOverJj`); on a fit it reads the
//     resolved head sha back from the forge, else `irreconcilable` → the coordinator
//     replans (keeping the work alive).

import { runWithJobOrgId } from "@tanren/db";
import type pg from "pg";
import type { Allocator } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { EventStore } from "../eventStore.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SpeculativeDependent } from "../contracts/changePercolation.js";
import type { GateReworkRouteResult } from "../contracts/conflictResolution.js";
import type { GitHubHttpClient } from "../providers/github.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import {
  type BaseShiftConflictResolver,
  type BaseShiftGateReworkRouter,
  type BaseShiftReGate,
  type BaseShiftWorkspaceOpener,
  type ConflictResolution,
  type ReGateResult,
} from "./baseShiftCoordinator.js";
import { SpecStatusGateReworkRouter } from "../workflow/reviewMerge/conflictResolver/gateReworkRouter.js";
import {
  buildPriorGateReworkReader,
  buildReplanEnqueuer,
} from "../workflow/reviewMerge/conflictResolver/replanEnqueuerPg.js";
import type { AncestorStack } from "./ancestorStack.js";
import { loadBaseShiftRunContext, type BaseShiftRunContext } from "./baseShiftLiveContext.js";
import { openLiveBaseShiftWorkspace, type LiveBaseShiftWorkspaceCore } from "./baseShiftLiveRebase.js";
import { assembleBaseShiftStackWorkspace } from "./baseShiftStackAssembly.js";
import { resolveBaseShiftConflict } from "./baseShiftLiveResolve.js";
import { runFreshRunnerMergeGate } from "../merge/freshRunnerGate.js";
import { pushJjHead } from "../workflow/reviewMerge/conflictResolver/jjAuthedPush.js";

/** Everything the live base-shift seams need to allocate runners + clone + re-gate + resolve. */
export interface LiveBaseShiftDeps {
  /** The raw pool (the system/credential bootstrap context read runs on it). */
  pool: pg.Pool;
  allocator: Allocator;
  ssh: CommandSubstrate;
  secrets: SecretStore;
  /** The shared (timed) GitHub HTTP client the run/merge host seams build over. */
  githubHttp: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
  /**
   * REQUIRED (audit D-R3.2 sweep): the writer is the single way to write under the
   * de-privileged data plane. PR #714 made the writer-undefined fallback unreachable
   * in production.
   */
  runStateWriter: RunStateWriter;
  /** The event store the re-gate + the resolver's re-gate emit `gate.*` through. */
  eventStore: EventStore;
  /** The org-scoping pool the resolver's tenant reads/writes self-route through. */
  scopedPool: pg.Pool;
  /** The runner identity key ref (same value the worker boot seeds). */
  identitySecretRef: string;
}

/**
 * The LIVE `BaseShiftWorkspaceOpener` + `WorkspaceVcsCore`. The opener allocates a live jj
 * workspace, clones the shifted base, tracks the dependent's OWN head branch, and resolves
 * the rebase target; the coordinator then calls `rebaseOnto` on THIS same object, which
 * delegates to the per-shift live core and releases the runner (the coordinator calls
 * `workspace.rebaseOnto` exactly once and never another `workspace` op, so the
 * release-after-rebase is leak-free). FAIL-CLOSED: an alloc/clone/rebase failure throws.
 */
export class LiveBaseShiftWorkspaceProvider implements BaseShiftWorkspaceOpener {
  /** The per-shift live cores, keyed by the workspace handle id the opener returned. */
  private readonly openWorkspaces = new Map<string, LiveBaseShiftWorkspaceCore>();

  constructor(private readonly deps: LiveBaseShiftDeps) {}

  async open(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    nonSpeculative: boolean;
    ancestorStack?: AncestorStack;
  }): Promise<{ workspaceId: string; path: string; branch: string; newBaseSha: string }> {
    const ctx = await loadBaseShiftRunContext(this.deps.pool, input.dependent.runId);
    // ORG-SCOPE THE ALLOCATION: the base-shift runs from the walk-chain subscriber, NOT a
    // worker job, so there is NO ambient `runWithJobOrgId`. Allocating the live workspace
    // claims a `runners` row through `withJobOrgScope`, which FAILS LOUDLY (deny-by-default
    // RLS) with no ambient org scope — `tenant-table access with no ambient org scope`,
    // mapped by the coordinator to `base shift held at rebase` and re-driven forever. The
    // dependent run HAS an org (`ctx.orgId`); establish its per-job scope around the
    // allocation, exactly as the worker drive path does (`runWithJobOrgId(facts.orgId, …)`).
    const live = await runWithJobOrgId(ctx.orgId, () => this.openShiftedBaseWorkspace(input, ctx));
    this.openWorkspaces.set(live.handle.workspaceId, live);
    return {
      workspaceId: live.handle.workspaceId,
      path: live.handle.path,
      branch: ctx.headBranch,
      // §3.1: a RESOLVED commit sha (not the `<baseRef>@origin` jj revision token). jj
      // rebases onto a revision, and `jj rebase -d <sha>` accepts a sha, so this same value
      // is the rebase target AND a clean `integration.rebase` event field (no token pollution).
      // Speculative ⇒ the LOCALLY-ASSEMBLED stack head; non-speculative ⇒ the `default_branch`
      // clone's resolved base sha.
      newBaseSha: live.newBaseSha,
    };
  }

  /**
   * Materialize the shifted base the dependent's branch rebases onto (jj-local, §2.2):
   *   • a NON-EMPTY re-resolved stack (a still-speculative shift): ASSEMBLE the stack
   *     LOCALLY (`main + ordered ancestors`) on the dependent's own short-lived runner —
   *     NO orchestrator-synthesized integration ref.
   *   • an empty stack (a NON-speculative shift — every ancestor merged): the plain
   *     `default_branch` clone (a REAL ref the clone imports, never a synthesized one).
   */
  private async openShiftedBaseWorkspace(
    input: {
      dependent: SpeculativeDependent;
      nonSpeculative: boolean;
      ancestorStack?: AncestorStack;
    },
    ctx: BaseShiftRunContext,
  ): Promise<LiveBaseShiftWorkspaceCore> {
    const stack = input.ancestorStack;
    if (stack !== undefined && stack.length > 0) {
      return assembleBaseShiftStackWorkspace({ deps: this.deps, ctx, stack });
    }
    // A non-speculative shift (every ancestor merged) rebases onto plain `default_branch` —
    // a REAL ref the clone imports (never a synthesized integration ref).
    return openLiveBaseShiftWorkspace({
      deps: this.deps,
      ctx,
      baseRef: ctx.defaultBranch,
    });
  }

  /**
   * The coordinator's rebase: delegate to the per-shift live core, then RELEASE the runner
   * (LOUD on leak). jj's `rebaseOnto` RECORDS a conflict in the commit (never throws on a
   * conflict); an infra/auth failure DOES throw — the coordinator maps it to a hold. The
   * recorded conflict is consumed by the resolver (which re-provisions its own workspace),
   * so this short-lived detection workspace is safe to release here.
   */
  async rebaseOnto(
    workspace: { workspaceId: string; path: string },
    branch: string,
    baseSha: string,
  ): ReturnType<LiveBaseShiftWorkspaceCore["core"]["rebaseOnto"]> {
    const live = this.openWorkspaces.get(workspace.workspaceId);
    if (live === undefined) {
      throw new Error(`live base-shift rebase: no open workspace for ${workspace.workspaceId}`);
    }
    this.openWorkspaces.delete(workspace.workspaceId);
    try {
      const rebase = await live.core.rebaseOnto(live.handle, branch, baseSha);
      // §3.1 PUSH-THEN-REGATE: a CLEAN rebase advanced the head LOCALLY only — the forge
      // `headBranch` still points at the UN-rebased tree. PUBLISH the rebased head now
      // (export the clean ref + authed force-push) so the coordinator's re-gate verifies the
      // ACTUAL landing tree, not the stale forge head (NEVER-MERGE-UNVERIFIED), and the
      // returned `headSha` exists on the forge. A CONFLICTED rebase is NOT pushed here — the
      // resolver re-provisions its own workspace + force-pushes the RESOLVED head; pushing a
      // conflicted tree would violate the §2 fail-closed export boundary.
      if (rebase.outcome === "clean") {
        await this.publishCleanRebase(live, branch);
      }
      return rebase;
    } finally {
      // The detection workspace's purpose is done after the rebase + push (clean) / the
      // resolver re-provisions (conflicted); release it (LOUD on leak).
      await live.release();
    }
  }

  /**
   * §3.1: export the cleanly-rebased head (REFUSES a still-conflicted ref — the §2 boundary)
   * and authed-force-push it onto the forge head branch, on the STILL-OPEN runner, before
   * release. FAIL-CLOSED: an export/push failure throws — the coordinator maps it to a hold
   * (the work survives), never a clean rebase left un-pushed that the re-gate then verifies
   * against the stale forge tree.
   */
  private async publishCleanRebase(live: LiveBaseShiftWorkspaceCore, branch: string): Promise<void> {
    await live.core.exportCleanGitRef(live.handle, branch);
    await pushJjHead({
      ssh: this.deps.ssh,
      target: live.pushFacts.target,
      workspacePath: live.pushFacts.workspacePath,
      secrets: this.deps.secrets,
      orgId: live.pushFacts.orgId,
      githubHttp: this.deps.githubHttp,
      ...(this.deps.githubAppMinter !== undefined && { githubAppMinter: this.deps.githubAppMinter }),
      repoUrl: live.pushFacts.repoUrl,
      headBranch: live.pushFacts.headBranch,
      // #1059: lease the publish against the fetched (pre-rebase) forge head — a reviewer/writer
      // commit that moved it mid-window rejects the push, and the coordinator maps the throw to a
      // HOLD + re-drive (never a blind overwrite, never a proceed-to-land on the stale head).
      expectedRemoteHeadSha: live.pushFacts.fetchedHeadSha,
      ...(live.pushFacts.installation !== undefined && { installation: live.pushFacts.installation }),
      githubCredentialRef: live.pushFacts.githubCredentialRef,
    });
  }

  // ---- WorkspaceVcsCore methods the coordinator NEVER calls (it only rebaseOnto's). ----
  // They are part of the contract surface but UNREACHABLE on the base-shift path; throw
  // loudly so the never-discard boundary stays literal (no silent mutate/discard).
  openWorkspace(): never {
    this.unreachable("openWorkspace");
  }
  assembleIntegration(): never {
    this.unreachable("assembleIntegration");
  }
  branch(): never {
    this.unreachable("branch");
  }
  checkout(): never {
    this.unreachable("checkout");
  }
  commit(): never {
    this.unreachable("commit");
  }
  resolveConflict(): never {
    this.unreachable("resolveConflict");
  }
  restackDescendants(): never {
    this.unreachable("restackDescendants");
  }
  exportCleanGitRef(): never {
    this.unreachable("exportCleanGitRef");
  }
  opUndo(): never {
    this.unreachable("opUndo");
  }

  private unreachable(op: string): never {
    throw new Error(`live base-shift workspace: ${op} is unreachable (the coordinator only rebaseOnto's)`);
  }
}

/**
 * The LIVE re-gate: the fresh-runner native gate over the rebased head (the SAME
 * `runFreshRunnerMergeGate` the queued-run / drive re-gates use). §3.1: the clean rebase
 * already PUSHED `rebasedHeadSha` onto `ctx.headBranch`, so the re-gate clones that branch
 * and the gated head is the pushed rebased tree. NEVER-MERGE-UNVERIFIED: we assert the gate
 * actually verified `rebasedHeadSha` (a race that re-advanced the branch between push and
 * re-gate makes them differ → HOLD, never a verdict for the wrong commit). Maps the gate
 * outcome to the coordinator's verdict: `passed`→`passed` (the work FITS — no replan),
 * `failed`→`failed` (route back to the planner WITH the shift); a THROW propagates so the
 * coordinator's `reGateOrHold` HOLDS (never merge on an unverified rebase).
 */
export class LiveBaseShiftReGate implements BaseShiftReGate {
  constructor(private readonly deps: LiveBaseShiftDeps) {}

  async reGate(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    rebasedHeadSha: string;
  }): Promise<ReGateResult> {
    const ctx = await loadBaseShiftRunContext(this.deps.pool, input.dependent.runId);
    // ORG-SCOPE THE RE-GATE ALLOCATION (same reason as the opener): the fresh-runner re-gate
    // claims a `runners` row through `withJobOrgScope`, and the base-shift runs outside any
    // worker per-job scope — establish the dependent run's org scope around the gate so its
    // tenant accesses (runner claim/release, gate event writes) are admitted by RLS.
    const result = await runWithJobOrgId(ctx.orgId, () =>
      runFreshRunnerMergeGate(
        {
          allocator: this.deps.allocator,
          ssh: this.deps.ssh,
          secrets: this.deps.secrets,
          githubHttp: this.deps.githubHttp,
          ...(this.deps.githubAppMinter !== undefined && { githubAppMinter: this.deps.githubAppMinter }),
          eventStore: this.deps.eventStore,
          identitySecretRef: this.deps.identitySecretRef,
        },
        {
          repoUrl: ctx.repoUrl,
          // §3.1: re-gate the dependent's OWN head branch — the clean rebase PUSHED the rebased
          // head here (so the forge branch IS the rebased tree), and the gate.verdict anchors
          // on the cloned head (the pushed `rebasedHeadSha`), not the un-rebased tree.
          ref: ctx.headBranch,
          runnerImage: ctx.runnerImage,
          governancePosture: ctx.governancePosture,
          ...(ctx.installation !== undefined && { installation: ctx.installation }),
          githubCredentialRef: ctx.githubCredentialRef,
          orgId: ctx.orgId,
          projectId: ctx.projectId,
          runId: ctx.runId,
          specId: ctx.specId,
        },
      ),
    );
    // NEVER-MERGE-UNVERIFIED: the gate must have verified the EXACT pushed rebased head. A
    // mismatch means the forge branch moved off `rebasedHeadSha` between the push and this
    // clone (a concurrent push / a failed push) — HOLD (fail-closed) rather than pass a
    // verdict for a commit that is not the one we rebased.
    if (input.rebasedHeadSha !== "" && result.headSha !== input.rebasedHeadSha) {
      throw new Error(
        `base-shift re-gate verified ${result.headSha} but the rebased head was ${input.rebasedHeadSha} — ` +
          `the forge head moved between push and re-gate; holding (NEVER-MERGE-UNVERIFIED)`,
      );
    }
    // The fresh-runner gate is synchronous over SSH: it either passed every tier or a tier
    // failed — there is no async "pending". An inconclusive state would surface as a throw
    // (mapped to HOLD by the coordinator), so a completed gate is `passed`/`failed`. A
    // FAILURE is a GATE-TIER failure (the fresh-runner merge gate runs deterministic CI
    // tiers only — no checker/auditor): the rebased tree is byte-clean, the code just fails
    // a gate on the shifted base, which the WRITER can fix. Carry the failing tier/step/exit
    // as steering (no_silent_fallback — never rework blind) so the coordinator routes it to
    // writer rework rather than replan/escalate-as-irreconcilable.
    if (result.outcome.passed) {
      return { verdict: "passed" };
    }
    const failure = result.outcome.failure;
    return {
      verdict: "failed",
      gateError: `base-shift re-gate failed at tier ${failure.tier}: step '${failure.failedStep}' (exit ${failure.exitCode ?? "unknown"})`,
    };
  }
}

/**
 * The LIVE base-shift gate-rework router: routes a CLEAN-rebase GATE-tier re-gate failure to
 * WRITER REWORK (the SAME never-discard re-author the conflict-resolver gate-rework path uses
 * — `buildReplanEnqueuer` + the `SpecStatusGateReworkRouter`, escalation owned by the
 * convergence detector at a fixed point). The coordinator's seam is per-call (the run/spec/org
 * vary per shift), so this builds a fresh `SpecStatusGateReworkRouter` per routing from the
 * shift's run context. NEVER `recordReplan` for a clean-rebase gate-fail; NEVER directly
 * escalate (the detector decides, no count).
 */
export class LiveBaseShiftGateReworkRouter implements BaseShiftGateReworkRouter {
  constructor(private readonly deps: LiveBaseShiftDeps) {}

  async routeGateFailToRework(input: {
    projectId: string;
    specId: string;
    runId: string;
    gateError: string;
  }): Promise<GateReworkRouteResult> {
    const ctx = await loadBaseShiftRunContext(this.deps.pool, input.runId);
    const router = new SpecStatusGateReworkRouter({
      orgId: ctx.orgId,
      runId: input.runId,
      projectId: input.projectId,
      // The base-shift dependent has no real PR handle (the rebase is over a runner-local
      // workspace) — 0, like the resolver's own `prNumber: 0` for this path.
      prNumber: 0,
      enqueuer: buildReplanEnqueuer(this.deps.scopedPool, this.deps.runStateWriter),
      priorReworks: buildPriorGateReworkReader(this.deps.scopedPool),
    });
    // Propagate the typed disposition — coordinator settles and instruments truthfully
    // (never discards parking_required as silent "replanned").
    return router.routeGateFailToRework({ specId: input.specId, gateError: input.gateError });
  }
}

/**
 * The LIVE conflict resolver: the answerer-backed Slice-1 jj resolver
 * (`buildDefaultConflictResolver` + the `JjWorkspaceConflictApplier`) over a freshly
 * provisioned live jj workspace (mirroring `driveResolveOverJj`). On a fit it reads the
 * resolved head sha back from the forge (the resolver force-pushed the resolved head);
 * an unresolved/irreconcilable conflict returns `{resolved:false}` so the coordinator
 * replans (keeping the work ALIVE — never discarded).
 */
export class LiveBaseShiftConflictResolver implements BaseShiftConflictResolver {
  constructor(private readonly deps: LiveBaseShiftDeps) {}

  async resolve(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    workspace: { workspaceId: string; path: string };
    rebase: { headSha: string };
    nonSpeculative: boolean;
    ancestorStack?: AncestorStack;
  }): Promise<ConflictResolution> {
    const ctx = await loadBaseShiftRunContext(this.deps.pool, input.dependent.runId);
    // §2.2 jj-local: resolve + re-gate against the SHIFTED base the initial rebase used.
    // A still-speculative shift assembles the re-resolved stack LOCALLY (below, via
    // `ancestorStack`) and the `shiftedBase` is only the diagnostic clone base; a
    // non-speculative shift rebases onto plain `default_branch`.
    const shiftedBase = ctx.defaultBranch;
    return resolveBaseShiftConflict({
      deps: this.deps,
      ctx,
      shiftedBase,
      // §2.2: the re-resolved stack the coordinator threaded through (the SAME the opener
      // assembled). Non-empty ⇒ the resolver assembles `main + ordered ancestors` LOCALLY.
      // Absent/empty (the non-speculative path passes no stack) ⇒ a plain `default_branch`
      // single-ref clone (a REAL ref, never a synthesized one).
      ...(input.ancestorStack !== undefined && !input.nonSpeculative && { ancestorStack: input.ancestorStack }),
    });
  }
}

export type { BaseShiftRunContext };
