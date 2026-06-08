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
import type { PercolationPending, PercolationSettler, SpeculativeDependent } from "../contracts/changePercolation.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { BaseShiftCoordinator } from "./baseShiftCoordinator.js";
import { PgBaseShiftEventEmitter, PgBaseShiftNodeReader, PgBaseShiftPersistence } from "./baseShiftCoordinatorPg.js";
import {
  HeldBaseShiftConflictResolver,
  HeldBaseShiftReGate,
  HeldBaseShiftWorkspaceOpener,
  HeldWorkspaceVcsCore,
} from "./baseShiftHeldSeams.js";
import { PgSpeculativeIntegrator } from "./speculativeIntegrator.js";
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
 * production-LIVE now; the live-jj workspace/re-gate/resolver are FAIL-CLOSED HOLDS
 * until Wave 3 plumbs the runner allocation (so a base shift on the live engine HOLDS
 * the work, never silently discards/merges — see baseShiftCoordinatorPg.ts).
 */
export function buildBaseShiftCoordinator(deps: BuildPercolationCoordinatorDeps): BaseShiftCoordinator {
  return new BaseShiftCoordinator({
    workspace: new HeldWorkspaceVcsCore(),
    opener: new HeldBaseShiftWorkspaceOpener(),
    reGate: new HeldBaseShiftReGate(),
    resolver: new HeldBaseShiftConflictResolver(),
    persistence: new PgBaseShiftPersistence(deps.pool, deps.runStateWriter),
    nodes: new PgBaseShiftNodeReader(deps.pool),
    events: new PgBaseShiftEventEmitter(deps.pool, deps.runStateWriter),
  });
}

/** Assemble the production change-percolation coordinator. */
export function buildPercolationCoordinator(deps: BuildPercolationCoordinatorDeps): ChangePercolationCoordinator {
  const integrator = new PgSpeculativeIntegrator({
    pool: deps.pool,
    vcsProvider: deps.vcsProvider,
    secrets: deps.secrets,
    ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
  });
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
      integrator,
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
