// The production assembly of the change-percolation coordinator
// (tanren-owns-the-engine.md §3 never-discard, §7 one base-shift handler), wired from
// the worker's autonomy loops alongside the DagWalker. It composes the pg/VcsProvider
// detect read model, the kick-off operation (rebuild the integration + REBASE the
// dependent IN PLACE via the BaseShiftCoordinator), the settler (advance the
// verified/absorbed key OR replan), and the org-scoped event emitter into the
// `PercolatingCoordinator` the subscriber drives on every notification.
//
// THE KEYSTONE — never-discard rebase replaces supersede+regenerate. The kick-off's
// re-execution is NO LONGER a fresh `createQueuedRunFromSpec` that cancels the prior
// run + force-pushes a clone + re-plans from scratch (the deleted `PgPercolationReexecutor`,
// THE WASTE — tanren-owns-the-engine.md §3/§7). It is now the `BaseShiftCoordinator`:
// it REBASES the dependent's EXISTING branch onto the shifted base (the rebuilt
// integration, or plain `default_branch`) via the jj `WorkspaceVcsCore`, KEEPING the
// SAME run/branch row, and re-plans ONLY when the rebase conflicted AND the resolver +
// re-gate say the old work no longer fits. A clean rebase + passing gate NEVER re-plans
// (never discards planner/writer/code tokens). The `BaseShiftCoordinator` IMPLEMENTS
// the `PercolationReexecutor` interface, so the `PercolatingKickOff` drives it unchanged
// — but it returns the dependent's OWN run id as the re-exec id (the never-discard
// handle the settle reads), never a new run.

import type pg from "pg";
import type { Allocator } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { PercolationPending, PercolationSettler, SpeculativeDependent } from "../contracts/changePercolation.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import type { WorkspaceVcsCore } from "../contracts/workspaceVcsCore.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { orgScopingPool } from "../data/orgScopedDb.js";
import { PgEventStore } from "../eventStore.js";
import {
  type BaseShiftConflictResolver,
  type BaseShiftPersistence,
  type BaseShiftReGate,
  type BaseShiftWorkspaceOpener,
  BaseShiftCoordinator,
} from "./baseShiftCoordinator.js";
import { PgBaseShiftEventEmitter, PgBaseShiftNodeReader, PgBaseShiftPersistence } from "./baseShiftCoordinatorPg.js";
import {
  HeldBaseShiftConflictResolver,
  HeldBaseShiftReGate,
  HeldBaseShiftWorkspaceOpener,
  HeldWorkspaceVcsCore,
} from "./baseShiftHeldSeams.js";
import {
  LiveBaseShiftConflictResolver,
  LiveBaseShiftReGate,
  LiveBaseShiftWorkspaceProvider,
  type LiveBaseShiftDeps,
} from "./baseShiftLiveSeams.js";
import { baseShiftLive } from "./baseShiftLiveFlag.js";
import type { AncestorStack } from "./ancestorStack.js";
import { PgDagAncestorStackResolver } from "./walkerPg.js";
import { type ChangePercolationCoordinator, PercolatingCoordinator } from "./percolation.js";
import { PercolatingKickOff } from "./percolationOperation.js";
import { PgPercolationEventEmitter, PgPercolationReadModel } from "./percolationPg.js";
import { clearPercolationPending, recordReplanContext, recordVerifiedAncestorSha } from "./percolationWrites.js";

export interface BuildPercolationCoordinatorDeps {
  pool: pg.Pool;
  vcsProvider: VcsProvider;
  secrets: SecretStore;
  githubAppMinter?: GithubAppTokenMinter;
  /**
   * Plane-split (autonomy loops): the control-plane run-state writer. When present
   * (remote-writes on), the change-percolation coordinator routes its keep-run-row
   * writes (`speculative_base` re-point, `verified_ancestor_shas`), its replan-context
   * append, and its events through the control plane (the de-privileged data plane can
   * no longer write those tables directly); absent, direct on the pool.
   */
  runStateWriter?: RunStateWriter;
  /**
   * Wave-3/Slice-2 LIVE base-shift seams. When present (the autonomy loops wire them),
   * the base-shift handler's workspace/re-gate/resolver are the LIVE seams (allocate a
   * runner, rebase the dependent's branch in place over jj, re-gate it, resolve a recorded
   * conflict) under the `baseShiftLive()` flag (default ON). Absent — or with the flag OFF
   * — the fail-closed `Held*` stubs hold the work loudly (never-discard, never-merge). The
   * runner allocator + SSH substrate + identity ref are the SAME the merge coordinator uses.
   */
  allocator?: Allocator;
  ssh?: CommandSubstrate;
  identitySecretRef?: string;
}

/**
 * The production settler: ABSORB advances `verified_ancestor_shas` to the absorbed
 * SHA (the termination key) + records the absorbed review verdict + clears the
 * marker; REPLAN records the replan context (intent stays alive) + clears the marker.
 * Both write the dependent's CURRENT run under RLS (the SAME run the never-discard
 * rebase kept — no new run was ever created).
 */
export class PgPercolationSettler implements PercolationSettler {
  constructor(
    private readonly pool: pg.Pool,
    private readonly runStateWriter?: RunStateWriter,
  ) {}

  async absorb(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    pending: PercolationPending;
  }): Promise<void> {
    // §5-P0 FAIL-CLOSED (tanren-owns-the-engine.md §5): a `changes_requested` re-exec
    // must NEVER advance the termination key. The S1-plumbed verdict is consumed at the
    // settle decision (`decideSettle` routes a `changes_requested` re-exec to REPLAN, so
    // `absorb` is not reached for it). This is the SECOND, defensive gate: even if a
    // marker that carries a `changes_requested` verdict reaches `absorb` (a future caller
    // bug), refuse to advance `verified_ancestor_shas` — clear the marker and route to
    // replan instead, never silently unblocking the merge on a reviewer's "changes_requested".
    if (input.pending.reviewVerdict === "changes_requested") {
      await recordReplanContext(
        this.pool,
        {
          projectId: input.projectId,
          specId: input.dependent.specId,
          runId: input.dependent.runId,
          ancestorSpecId: input.pending.ancestorSpecId,
          ancestorSha: input.pending.toSha,
          reason: "absorb refused: the re-exec carried a changes_requested verdict (§5-P0 fail-closed)",
        },
        this.runStateWriter,
      );
      await clearPercolationPending(
        this.pool,
        { projectId: input.projectId, runId: input.dependent.runId },
        this.runStateWriter,
      );
      return;
    }
    await recordVerifiedAncestorSha(
      this.pool,
      {
        projectId: input.projectId,
        runId: input.dependent.runId,
        ancestorSpecId: input.pending.ancestorSpecId,
        sha: input.pending.toSha,
        ...(input.pending.reviewVerdict !== undefined && { reviewVerdict: input.pending.reviewVerdict }),
      },
      this.runStateWriter,
    );
    await clearPercolationPending(
      this.pool,
      { projectId: input.projectId, runId: input.dependent.runId },
      this.runStateWriter,
    );
  }

  async replan(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    pending: PercolationPending;
    reason: string;
  }): Promise<void> {
    await recordReplanContext(
      this.pool,
      {
        projectId: input.projectId,
        specId: input.dependent.specId,
        runId: input.dependent.runId,
        ancestorSpecId: input.pending.ancestorSpecId,
        ancestorSha: input.pending.toSha,
        reason: input.reason,
      },
      this.runStateWriter,
    );
    await clearPercolationPending(
      this.pool,
      { projectId: input.projectId, runId: input.dependent.runId },
      this.runStateWriter,
    );
  }
}

/**
 * Assemble the production `BaseShiftCoordinator` — the ONE base-shift handler that the
 * percolation kick-off (and the merge-path `behind` mergeability) route through. The
 * keep-run-row persistence + the S0 node read + the `integration.rebase` emitter are
 * production-LIVE. The workspace/re-gate/resolver seams are selected by `baseShiftLive()`
 * (default ON — the Wave-3/Slice-2 cutover): the LIVE seams (allocate a runner, rebase in
 * place over jj, re-gate, resolve a recorded conflict) when the flag is on AND the runner
 * deps are wired; the fail-closed `Held*` stubs (the kill-switch — they HOLD the work
 * loudly, never-discard/never-merge) when the flag is OFF. Flag ON but deps absent THROWS
 * (a misconfigured live flag, not a silent degrade). No half-state: either the live seams
 * own the whole flow or the held stubs hold (flag off) or construction fails loud.
 */
export function buildBaseShiftCoordinator(
  deps: BuildPercolationCoordinatorDeps,
  options: { suppressInFlightMarker?: boolean } = {},
): BaseShiftCoordinator {
  const seams = selectBaseShiftSeams(deps);
  const base = new PgBaseShiftPersistence(deps.pool, deps.runStateWriter);
  // P1 fix: the merge-queue `behind` path is a SYNCHRONOUS merge-dispatcher rebase, NOT a
  // deferred ancestor-percolation — so it must NOT stamp `percolation_pending` (which the
  // percolation read-model selects, and would falsely settle/replan the run as a
  // percolation). The marker-suppressing persistence no-ops `markInFlight` for it; the
  // change-percolation kick-off (the real deferral the settle reads) keeps the live marker.
  const persistence = options.suppressInFlightMarker === true ? new MarkerSuppressedBaseShiftPersistence(base) : base;
  return new BaseShiftCoordinator({
    workspace: seams.workspace,
    opener: seams.opener,
    reGate: seams.reGate,
    resolver: seams.resolver,
    persistence,
    nodes: new PgBaseShiftNodeReader(deps.pool),
    events: new PgBaseShiftEventEmitter(deps.pool, deps.runStateWriter),
  });
}

/**
 * A keep-run-row persistence that SUPPRESSES the in-flight `percolation_pending` marker —
 * for the merge-queue `behind` rebase, which is owned synchronously by the merge dispatcher
 * and must NEVER be picked up by the change-percolation poller (the P1 mis-routing fix).
 * `repointBase` (re-point to NULL for a non-speculative behind run — inert) and
 * `recordReplan` (route the work back, kept alive) still delegate; only `markInFlight` — the
 * deferred-percolation settle handle — is dropped, so a `behind` run is never selectable as
 * a percolation. NEVER fakes percolation identity for a non-percolation run.
 */
export class MarkerSuppressedBaseShiftPersistence implements BaseShiftPersistence {
  constructor(private readonly inner: BaseShiftPersistence) {}
  async repointBase(input: { projectId: string; runId: string; ancestorStack: AncestorStack }): Promise<void> {
    await this.inner.repointBase(input);
  }
  async markInFlight(): Promise<void> {
    // Intentionally a NO-OP: the merge-queue `behind` rebase is synchronous (the dispatcher
    // re-gates + merges in the same pass), so there is no deferred re-execution for the
    // percolation settle to resolve. Stamping the marker would mis-route the run to the
    // percolation poller (P1). The change-percolation path uses the un-suppressed persistence.
  }
  async recordReplan(input: {
    projectId: string;
    specId: string;
    runId: string;
    ancestorSpecId: string;
    ancestorSha: string;
    reason: string;
  }): Promise<void> {
    await this.inner.recordReplan(input);
  }
}

/** The workspace/re-gate/resolver seam set the base shift drives — LIVE (flag ON + deps) or HELD. */
interface BaseShiftSeams {
  workspace: WorkspaceVcsCore;
  opener: BaseShiftWorkspaceOpener;
  reGate: BaseShiftReGate;
  resolver: BaseShiftConflictResolver;
}

/**
 * Select the base-shift seams by the `baseShiftLive()` flag (default ON). Flag ON with the
 * runner deps wired ⇒ the LIVE seams; flag OFF ⇒ the fail-closed `Held*` stubs (the
 * kill-switch, the documented flag-OFF behavior).
 *
 * Flag ON but the runner deps NOT wired is a MISCONFIGURED LIVE FLAG — a construction bug,
 * NOT a degrade to honor. It throws LOUDLY here (no silent fallback to the held stubs): a
 * `BASE_SHIFT_LIVE`-on build site that cannot drive a live runner is wired wrong, and a
 * quiet hold would mask it. (The genuine flag-OFF kill-switch keeps its held-stub behavior;
 * the never-discard/never-merge hold semantics belong to the flag-OFF path, not to an
 * un-wired live path. The no-silent-fallback boundary: required-missing fails loud.)
 */
function selectBaseShiftSeams(deps: BuildPercolationCoordinatorDeps): BaseShiftSeams {
  if (!baseShiftLive()) {
    return {
      workspace: new HeldWorkspaceVcsCore(),
      opener: new HeldBaseShiftWorkspaceOpener(),
      reGate: new HeldBaseShiftReGate(),
      resolver: new HeldBaseShiftConflictResolver(),
    };
  }
  const liveDeps = liveBaseShiftDeps(deps);
  if (liveDeps === undefined) {
    throw new Error(
      "BASE_SHIFT_LIVE is on but the live base-shift deps are not wired " +
        "(allocator / ssh / identitySecretRef absent) — a misconfigured live flag is a construction " +
        "bug, not a silent degrade. Wire the runner deps, or set BASE_SHIFT_LIVE=0 for the held kill-switch.",
    );
  }
  // The opener IS the workspace core (it holds the per-shift live jj cores the coordinator's
  // `rebaseOnto` delegates to — the coordinator only ever calls `workspace.rebaseOnto`).
  const provider = new LiveBaseShiftWorkspaceProvider(liveDeps);
  return {
    workspace: provider,
    opener: provider,
    reGate: new LiveBaseShiftReGate(liveDeps),
    resolver: new LiveBaseShiftConflictResolver(liveDeps),
  };
}

/**
 * Assemble the {@link LiveBaseShiftDeps} from the build deps, or `undefined` when the
 * runner allocator / SSH substrate / identity ref are not wired (the held fallback). The
 * org-scoping pool + the event store mirror the merge coordinator's construction
 * (`orgScopingPool` + `PgEventStore`, routed through the control plane when a writer is set).
 */
function liveBaseShiftDeps(deps: BuildPercolationCoordinatorDeps): LiveBaseShiftDeps | undefined {
  if (deps.allocator === undefined || deps.ssh === undefined || deps.identitySecretRef === undefined) {
    return undefined;
  }
  const scopedPool = orgScopingPool(deps.pool);
  return {
    pool: deps.pool,
    scopedPool,
    allocator: deps.allocator,
    ssh: deps.ssh,
    secrets: deps.secrets,
    vcsProvider: deps.vcsProvider,
    ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
    ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
    eventStore: deps.runStateWriter ?? new PgEventStore(scopedPool),
    identitySecretRef: deps.identitySecretRef,
  };
}

/** Assemble the production change-percolation coordinator. */
export function buildPercolationCoordinator(deps: BuildPercolationCoordinatorDeps): ChangePercolationCoordinator {
  const stackResolver = new PgDagAncestorStackResolver(deps.pool);
  return new PercolatingCoordinator({
    readModel: new PgPercolationReadModel({
      pool: deps.pool,
      vcsProvider: deps.vcsProvider,
      secrets: deps.secrets,
      ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
      // Plane-split: route the stale-marker housekeeping clear (a `percolation_pending`
      // left on a now-merged/done run) through the control plane when wired.
      ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
    }),
    kickOff: new PercolatingKickOff({
      // jj-local (WS-B PR-9): the kick-off RE-RESOLVES the ordered unmerged-ancestor stack
      // (org-scoped/RLS) — there is NO host integration build. The base-shift re-executor
      // assembles `main + ordered ancestors` LOCALLY from those refs.
      stackResolver,
      // NEVER-DISCARD: the kick-off's re-executor is the BaseShiftCoordinator — it
      // REBASES the dependent's existing branch in place (keeping the run row) instead
      // of the deleted supersede+regenerate. It returns the dependent's OWN run id as
      // the re-exec id, so the existing settle pass advances the termination key against
      // that SAME run.
      reexecutor: buildBaseShiftCoordinator(deps),
    }),
    settler: new PgPercolationSettler(deps.pool, deps.runStateWriter),
    events: new PgPercolationEventEmitter({
      pool: deps.pool,
      ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
    }),
  });
}
