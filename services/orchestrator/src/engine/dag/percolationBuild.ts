// The production assembly of the change-percolation coordinator
// (autonomy-engine.md §2c), wired from the worker's autonomy loops alongside the
// DagWalker. It composes the pg/VcsProvider detect read model, the rebuild+re-gate
// operation, and the org-scoped event emitter into the `PercolatingCoordinator`
// the subscriber drives on every run-terminal / merge.completed / ancestor-update
// notification.
//
// The re-base step (`RebasePercolationReGate`) re-points the dependent run's
// `speculative_base` to the rebuilt integration branch. The dependent's IN-LOOP
// re-gate (the merge-stage P2a up-to-date/auto-rebase + the P2b resolver in
// upstream-change mode + the resolved-tree re-gate) then verifies the absorbed
// change against reality — reusing the SAME re-gate path, not re-implementing it.
// This is the §2c "re-gate against reality" model from P2c-1: the work is kept
// alive on the new base; nothing merges until that in-loop re-gate is clean.

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { SecretStore } from "../contracts/secretStore.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { PgSpeculativeIntegrator } from "./speculativeIntegrator.js";
import { type ChangePercolationCoordinator, PercolatingCoordinator } from "./percolation.js";
import { PercolatingOperation, type PercolationReGate } from "./percolationOperation.js";
import { PgPercolationEventEmitter, PgPercolationReadModel, recordIntegratedAncestorSha } from "./percolationPg.js";
import type { PercolationDecision, SpeculativeDependent } from "../contracts/changePercolation.js";

export interface BuildPercolationCoordinatorDeps {
  pool: pg.Pool;
  vcsProvider: VcsProvider;
  secrets: SecretStore;
  githubAppMinter?: GithubAppTokenMinter;
}

/**
 * The production re-base step: re-point the dependent run's `speculative_base` to
 * the rebuilt integration branch (org-scoped). The dependent's in-loop merge-stage
 * re-gate (P2a/P2b, resolver in upstream-change mode) then verifies the absorbed
 * change. Re-pointing the base IS the re-base; the verification is reused in-loop,
 * so this returns `absorbed` (the change is now staged on the dependent's new base,
 * pending the in-loop re-gate that gates the eventual merge — never merging stale).
 */
export class RebasePercolationReGate implements PercolationReGate {
  constructor(private readonly pool: pg.Pool) {}

  async rebaseAndReGate(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    decision: PercolationDecision;
    integrationBranch: string;
  }): Promise<{ outcome: "absorbed" | "replanned"; viaResolver: boolean; reason?: string }> {
    const orgId = await runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [input.projectId],
      );
      return result.rows[0]?.org_id ?? null;
    });
    if (orgId === null) throw new Error(`project ${input.projectId} has no org to re-base for percolation`);
    await runWithOrgScope(this.pool, orgId, async (client) => {
      await client.query("UPDATE runs SET speculative_base = $2 WHERE run_id = $1", [
        input.dependent.runId,
        input.integrationBranch,
      ]);
    });
    // The change is staged onto the rebuilt base; the in-loop re-gate (reused,
    // not re-implemented) verifies it and the P2b resolver/replan fires there on a
    // semantic break. The work is preserved on the new base; no merge happens
    // until that re-gate is clean.
    return { outcome: "absorbed", viaResolver: false };
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
    operation: new PercolatingOperation({
      integrator,
      reGate: new RebasePercolationReGate(deps.pool),
      recordIntegratedSha: (input) => recordIntegratedAncestorSha(deps.pool, input),
    }),
    events: new PgPercolationEventEmitter({ pool: deps.pool }),
  });
}
