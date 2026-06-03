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
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
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
 * The production re-executor: re-points the dependent's current speculative run onto
 * the rebuilt integration, reopens the spec, and re-enqueues a REAL re-execution run
 * (the same createQueuedRunFromSpec path the DagWalker uses) so the dependent's gate
 * + checker + auditor re-run against the percolated change. The new run carries the
 * new build base + the CARRIED-FORWARD verified SHAs (so an un-changed ancestor stays
 * absorbed) + the in-flight marker (so the coordinator settles it). The dependent's
 * OWN branch/work is the run base — re-pointed, never reset.
 */
export class PgPercolationReexecutor implements PercolationReexecutor {
  constructor(
    private readonly pool: pg.Pool,
    private readonly runStateWriter?: RunStateWriter,
  ) {}

  async reexecute(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    decision: PercolationDecision;
    integrationBranch: string;
    ancestorHeadShas: Record<string, string>;
  }): Promise<{ reexecRunId: string }> {
    const orgId = await resolveOrg(this.pool, input.projectId);

    // Re-point the OLD run's base (so a detect before the new run is visible still
    // reads the rebuilt base) + reopen the spec so createQueuedRunFromSpec re-claims
    // it. Keep the spec's branch/work intact (we only move status), never reset.
    // Plane-split: route both through the control plane when wired; else direct.
    if (this.runStateWriter === undefined) {
      await runWithOrgScope(this.pool, orgId, async (client) => {
        await client.query("UPDATE runs SET speculative_base = $2 WHERE run_id = $1", [
          input.dependent.runId,
          input.integrationBranch,
        ]);
        await client.query(
          `UPDATE specs SET status = 'pending' WHERE spec_id = $1 AND status NOT IN ('done', 'merged')`,
          [input.dependent.specId],
        );
      });
    } else {
      await this.runStateWriter.setRunSpeculativeBase({
        runId: input.dependent.runId,
        orgId,
        speculativeBase: input.integrationBranch,
      });
      await this.runStateWriter.setSpecStatus({
        specId: input.dependent.specId,
        orgId,
        status: "pending",
        notFromStatuses: ["done", "merged"],
      });
    }

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
    const createInput = {
      specId: input.dependent.specId,
      trigger: "change_percolation",
      speculative: {
        speculativeBase: input.integrationBranch,
        integratedAncestorShas: input.ancestorHeadShas,
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
