// The production assembly of the change-percolation coordinator
// (autonomy-engine.md §2c), wired from the worker's autonomy loops alongside the
// DagWalker. It composes the pg/VcsProvider detect read model, the kick-off
// operation (rebuild + re-base + REAL re-execution), the settler (advance the
// verified/absorbed key OR replan), and the org-scoped event emitter into the
// `PercolatingCoordinator` the subscriber drives on every notification.
//
// The re-execution is a REAL run: `PgPercolationReexecutor` re-points the dependent
// onto the rebuilt integration AND re-enqueues the dependent spec through the SAME
// createQueuedRunFromSpec path the DagWalker uses, so the dependent's OWN gate +
// checker + auditor genuinely re-run against the percolated change (the planner
// re-plans / the upstream-change resolver reconciles a break) — no second runner
// outside a run. Absorption (recording the verified/termination SHA + emitting
// `percolated`) happens ONLY when that re-execution re-gates clean, on a later
// settle pass — never on a bare re-base.

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import type {
  PercolationDecision,
  PercolationPending,
  PercolationSettler,
  SpeculativeDependent,
} from "../contracts/changePercolation.js";
import type { MergeQueueEntry, MergeQueueModel } from "../contracts/mergeCoordinator.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import type { MergeQueueEventEmitter } from "../merge/coordinator.js";
import { PgMergeQueueEventEmitter } from "../merge/coordinator.js";
import { PgMergeQueueModel } from "../merge/coordinatorPg.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { createQueuedRunFromSpec } from "../workflow/projectSpec.js";
import { PgSpeculativeIntegrator } from "./speculativeIntegrator.js";
import { type ChangePercolationCoordinator, PercolatingCoordinator } from "./percolation.js";
import { PercolatingKickOff, type PercolationReexecutor } from "./percolationOperation.js";
import { PgPercolationEventEmitter, PgPercolationReadModel } from "./percolationPg.js";
import { clearPercolationPending, recordReplanContext, recordVerifiedAncestorSha } from "./percolationWrites.js";

export interface BuildPercolationCoordinatorDeps {
  pool: pg.Pool;
  vcsProvider: VcsProvider;
  secrets: SecretStore;
  githubAppMinter?: GithubAppTokenMinter;
  /**
   * Plane-split (autonomy loops): the control-plane run-state writer. When present
   * (remote-writes on), the change-percolation coordinator routes its run-column
   * writes (`speculative_base`, `percolation_pending`, `verified_ancestor_shas`),
   * its spec reopen, its re-execution run-CREATE, and its events through the control
   * plane (the de-privileged data plane can no longer write those tables directly);
   * absent, direct on the pool — byte-identical to today.
   */
  runStateWriter?: RunStateWriter;
}

async function resolveOrg(pool: pg.Pool, projectId: string): Promise<string> {
  const orgId = await runWithSystemScope(pool, async (client) => {
    const result = await client.query<{ org_id: string | null }>("SELECT org_id FROM projects WHERE project_id = $1", [
      projectId,
    ]);
    return result.rows[0]?.org_id ?? null;
  });
  if (orgId === null) throw new Error(`project ${projectId} has no org for change-percolation`);
  return orgId;
}

/**
 * The production re-executor: SUPERSEDES the dependent's PRIOR run (retires it +
 * dequeues its merge-queue entry + supersedes its PR), then re-enqueues a REAL
 * re-execution run (the same createQueuedRunFromSpec path the DagWalker uses) so the
 * dependent's gate + checker + auditor re-run against the percolated change. The new
 * run carries the new build base + the CARRIED-FORWARD verified SHAs (so an un-changed
 * ancestor stays absorbed) + the in-flight marker (so the coordinator settles it). The
 * dependent's OWN git branch/work is the run base — re-pointed, never reset.
 *
 * The supersede is the fix for the §2c self-conflict: the kick-off ALWAYS creates a
 * NEW run (never re-points the prior run row in place — only the prior run's git
 * branch is reused). Without retiring the prior run + its queue entry the spec ends up
 * with TWO live runs + TWO open PRs, both reach the merge queue, and the speculative
 * batch check integrates the spec against ITSELF (a self-conflict naming the spec as
 * its own ancestor) → both dequeue → the spec strands `active`. Retiring the prior run
 * (status → cancelled, invisible to the walker + the percolation read model) and
 * dequeuing its queue entry (`superseded`, NOT `conflict` — it is not a real conflict,
 * so it is not routed back through the re-execution path) leaves exactly ONE live run
 * per spec — the re-exec — which merges cleanly.
 */
export class PgPercolationReexecutor implements PercolationReexecutor {
  private readonly queue: MergeQueueModel;
  private readonly queueEvents: MergeQueueEventEmitter;

  constructor(
    private readonly pool: pg.Pool,
    private readonly runStateWriter?: RunStateWriter,
    deps?: { queue?: MergeQueueModel; queueEvents?: MergeQueueEventEmitter },
  ) {
    // The native-queue model + its event emitter drive the prior-run SUPERSEDE. Both
    // default to the production pg wirings (the queue write is a direct merge_queue
    // UPDATE — the data plane retains that grant; the event routes through the control
    // plane when a writer is wired). Tests inject in-memory fakes.
    this.queue = deps?.queue ?? new PgMergeQueueModel(this.pool);
    this.queueEvents = deps?.queueEvents ?? new PgMergeQueueEventEmitter(this.pool, this.runStateWriter);
  }

  async reexecute(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    decision: PercolationDecision;
    integrationBranch: string;
    ancestorHeadShas: Record<string, string>;
    nonSpeculative: boolean;
  }): Promise<{ reexecRunId: string }> {
    const orgId = await resolveOrg(this.pool, input.projectId);

    // §2c "ancestor-merged → non-speculative re-base": when EVERY ancestor has merged
    // the dependent re-bases onto plain `default_branch`, so the re-execution carries
    // NO speculative base (NULL) + NO build-base ancestor SHAs — a real run against
    // main. Otherwise it re-bases onto the rebuilt integration branch (the unmerged
    // ancestors still stacked) and carries the new ancestor head SHAs as the build base.
    const newBase = input.nonSpeculative ? null : input.integrationBranch;
    const newBuildBase = input.nonSpeculative ? undefined : input.ancestorHeadShas;

    // ORDER MATTERS (never-strand): reopen the spec to `pending` BEFORE cancelling the
    // prior run, so EVERY failure point is recoverable:
    //   - a throw BEFORE the cancel (e.g. during this reopen) leaves the prior run LIVE
    //     — the pre-fix behavior, no strand (the prior run still drives the spec);
    //   - a throw AFTER the cancel (during create) leaves the spec `pending` so the
    //     DagWalker re-enqueues it — no `active`-spec-with-only-a-cancelled-run strand.
    // The reverse order (cancel→reopen) opens a window where a throw between them strands
    // the spec `active` with its only run cancelled (nothing reconciles that). Reopening
    // first closes it. Keep the spec's git branch/work intact (we only move status),
    // never reset. The prior run is NOT re-pointed — `supersedePriorRun` cancels it, so
    // its `speculative_base` is dead (the read model + walker ignore a cancelled run);
    // the re-base/build-base instead live on the NEW re-exec run (`newBase`/`newBuildBase`).
    // Plane-split: route the spec reopen through the control plane when wired; else direct.
    if (this.runStateWriter === undefined) {
      await runWithOrgScope(this.pool, orgId, async (client) => {
        await client.query(
          `UPDATE specs SET status = 'pending' WHERE spec_id = $1 AND status NOT IN ('done', 'merged')`,
          [input.dependent.specId],
        );
      });
    } else {
      await this.runStateWriter.setSpecStatus({
        specId: input.dependent.specId,
        orgId,
        status: "pending",
        notFromStatuses: ["done", "merged"],
      });
    }

    // SUPERSEDE the prior run (cancel + dequeue its queue entry) AFTER the spec is
    // `pending` so only the new run competes in the merge queue. Idempotent (a
    // re-percolation that races finds the prior run already terminal / its entry already
    // dequeued ⇒ no-op).
    await this.supersedePriorRun(input.projectId, orgId, input.dependent);

    // The build base is the ancestor's NEW head SHAs; carry the verified (absorbed)
    // SHAs forward so an unchanged ancestor stays absorbed across the re-execution.
    // `reexecRunId` is stamped after the run is created (the settle reads it).
    const pending: PercolationPending = {
      ancestorSpecId: input.decision.ancestorSpecId,
      toSha: input.decision.toSha,
      ...(input.decision.immediateSeverity === "changes_requested" && { reviewVerdict: "changes_requested" as const }),
      reexecRunId: "",
    };
    const actor: ActorContext = {
      userId: "change-percolation",
      orgId,
      projectId: input.projectId,
      scopes: ["platform:admin"],
      source: "local_dev",
    };
    // When non-speculative the run carries a NULL base + NO build-base map (a real run
    // against main); else the rebuilt integration branch + the new ancestor head SHAs.
    // EITHER WAY the `speculative` block is present (not undefined), so the re-exec
    // SKIPS the done-only dependency gate (the percolation walker owns the ordering;
    // a merged ancestor is genuinely done) AND carries the verified-SHA carry-forward
    // + the in-flight marker the settle resolves (advancing the termination key).
    const createInput = {
      specId: input.dependent.specId,
      trigger: "change_percolation",
      speculative: {
        speculativeBase: newBase,
        ...(newBuildBase !== undefined && { integratedAncestorShas: newBuildBase }),
        verifiedAncestorShas: input.dependent.verifiedAncestorShas,
        percolationPending: { ...pending, reexecRunId: "" },
      },
    };
    // Plane-split: route the re-execution run-CREATE + the reexecRunId stamp through
    // the control plane when wired; else create + stamp in-process — byte-identical.
    const run =
      this.runStateWriter === undefined
        ? await createQueuedRunFromSpec(this.pool, createInput, actor)
        : await this.runStateWriter.createQueuedRun({ input: createInput, actor });

    // Stamp the marker's reexecRunId now the run id exists (the settle reads it).
    if (this.runStateWriter === undefined) {
      await runWithOrgScope(this.pool, orgId, async (client) => {
        await client.query(
          `UPDATE runs
              SET percolation_pending = COALESCE(percolation_pending, '{}'::jsonb) || jsonb_build_object('reexecRunId', $2::text)
            WHERE run_id = $1`,
          [run.runId, run.runId],
        );
      });
    } else {
      await this.runStateWriter.setRunPercolationReexecId({ runId: run.runId, orgId, reexecRunId: run.runId });
    }
    return { reexecRunId: run.runId };
  }

  /**
   * Retire the dependent's PRIOR run so the re-exec is the spec's ONLY live run:
   *   1. DEQUEUE the prior run's active merge-queue entry (`superseded`) so the
   *      speculative batch check stops integrating it (the self-conflict fix), and
   *      emit the observable `merge.dequeued` — the LOUD, inspectable record of WHY
   *      the prior PR left the queue. A non-conflict reason: it is NOT routed back to
   *      the re-execution path (the re-exec already IS that re-execution).
   *   2. CANCEL the prior run (status → cancelled) so the walker treats it as
   *      terminal-blocked and the percolation read model (`status NOT IN
   *      ('halted','cancelled','failed')`) no longer loads it as the live dependent —
   *      the new re-exec run, carrying the in-flight marker, becomes the dependent on
   *      the next pass.
   * Both writes are idempotent + guarded (a re-percolation finds nothing to retire).
   * The prior run's open GitHub PR is functionally retired the moment its queue entry
   * is gone (it can no longer be selected for merge); CLOSING that PR on GitHub is a
   * noted follow-up — the VcsProvider has no PR-close seam yet (a deliberate scope cut).
   */
  private async supersedePriorRun(projectId: string, orgId: string, dependent: SpeculativeDependent): Promise<void> {
    // 1. Dequeue the prior run's active queue entry (if any) — the load-bearing fix.
    const superseded = await this.queue.supersedePriorRunEntry(dependent.runId);
    if (superseded !== undefined) {
      // Synthesize the entry shape the dequeued-event emitter reads (it only reads
      // run/spec/PR fields; the DAG-ordering fields are irrelevant to the event).
      const entry: MergeQueueEntry = {
        queueId: superseded.queueId,
        runId: superseded.runId,
        specId: superseded.specId,
        prUrl: superseded.prUrl,
        prNumber: superseded.prNumber,
        dependsOn: [],
        priority: "tbd",
        orderKey: 0,
      };
      await this.queueEvents.emitDequeued({
        projectId,
        entry,
        reason: "superseded",
        message: `prior run ${dependent.runId} superseded by a percolation re-execution (upstream change from ${dependent.specId} ancestor)`,
      });
    }

    // 2. Cancel the prior run so it is no longer a live candidate (walker + read model
    //    both ignore a `cancelled` run). Guarded to every non-cancelled status so it is
    //    idempotent (an already-cancelled prior run matches no row). Plane-split: route
    //    the finalize through the control plane when wired (the de-privileged data plane
    //    can no longer UPDATE runs); else the in-process org-scoped UPDATE.
    const fromStatuses = ["queued", "running", "halted", "completed", "done", "failed"];
    if (this.runStateWriter !== undefined) {
      await this.runStateWriter.finalizeRun({
        runId: dependent.runId,
        orgId,
        status: "cancelled",
        outcome: "cancelled",
        fromStatuses,
      });
      return;
    }
    await runWithOrgScope(this.pool, orgId, async (client) => {
      await client.query(
        `UPDATE runs SET status = 'cancelled', outcome = 'cancelled', ended_at = now()
          WHERE run_id = $1 AND status = ANY($2::text[])`,
        [dependent.runId, fromStatuses],
      );
    });
  }
}

/**
 * The production settler: ABSORB advances `verified_ancestor_shas` to the absorbed
 * SHA (the termination key) + records the absorbed review verdict + clears the
 * marker; REPLAN records the replan context (intent stays alive) + clears the marker.
 * Both write the dependent's CURRENT run under RLS.
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
    }),
    kickOff: new PercolatingKickOff({
      integrator,
      // Plane-split: the re-executor routes its run-column writes + spec reopen +
      // run-CREATE through the control plane when wired (else direct).
      reexecutor: new PgPercolationReexecutor(deps.pool, deps.runStateWriter),
    }),
    settler: new PgPercolationSettler(deps.pool, deps.runStateWriter),
    events: new PgPercolationEventEmitter({
      pool: deps.pool,
      ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
    }),
  });
}
