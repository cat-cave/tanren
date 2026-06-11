// The pg production wirings of the `BaseShiftCoordinator` seams
// (tanren-owns-the-engine.md §3 never-discard, §7 one base-shift handler), split out of
// `baseShiftCoordinator.ts` to keep each file under the caps. Three production-faithful
// pg seams that need NO runner: the KEEP-RUN-ROW persistence (the never-discard writes),
// the S0 integration-node read, and the `integration.rebase` instrumentation emitter.
//
// The live-jj workspace/re-gate/resolver seams that drive the ACTUAL rebase are the
// FAIL-CLOSED HOLDS in `baseShiftHeldSeams.ts` (Wave-3-plumbed) — so a base shift on the
// live engine HOLDS the dependent's work (the run row + branch survive, never-discard),
// never silently discards or merges (the §0 boundary made literal).

import type pg from "pg";
import type { SpeculativeDependent } from "../contracts/changePercolation.js";
import type { AncestorStack } from "./ancestorStack.js";
import type { IntegrationNode } from "../contracts/integrationNodes.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type {
  BaseShiftEventEmitter,
  BaseShiftNodeReader,
  BaseShiftPersistence,
  RebaseDecision,
} from "./baseShiftCoordinator.js";
import { PgIntegrationNodeModel } from "./integrationNodesPg.js";
import {
  appendIntegrationRebaseEvent,
  clearPercolationPending,
  recordPercolationPending,
  recordReplanContext,
  repointRunAncestorStack,
} from "./percolationWrites.js";

/**
 * The KEEP-RUN-ROW persistence (never-discard). Every write targets the dependent's
 * EXISTING run — re-point its dynamic base, stamp the in-flight marker pointing at
 * THAT SAME run (the never-discard handle the settle reads), or record the replan
 * context (intent stays ALIVE). It NEVER cancels or creates a run.
 */
export class PgBaseShiftPersistence implements BaseShiftPersistence {
  constructor(
    private readonly pool: pg.Pool,
    private readonly runStateWriter?: RunStateWriter,
  ) {}

  async repointBase(input: { projectId: string; runId: string; ancestorStack: AncestorStack }): Promise<void> {
    await repointRunAncestorStack(this.pool, input, this.runStateWriter);
  }

  async markInFlight(input: {
    projectId: string;
    runId: string;
    pending: { ancestorSpecId: string; toSha: string; reviewVerdict?: "changes_requested" };
  }): Promise<void> {
    // NEVER-DISCARD: the marker's reexecRunId IS the dependent's own run id — the SAME
    // row re-gates (no new run), which is what makes the existing settle pass advance
    // `verified_ancestor_shas` against this run.
    await recordPercolationPending(this.pool, {
      projectId: input.projectId,
      runId: input.runId,
      ancestorSpecId: input.pending.ancestorSpecId,
      toSha: input.pending.toSha,
      reexecRunId: input.runId,
      ...(input.pending.reviewVerdict !== undefined && { reviewVerdict: input.pending.reviewVerdict }),
    });
  }

  async recordReplan(input: {
    projectId: string;
    specId: string;
    runId: string;
    ancestorSpecId: string;
    ancestorSha: string;
    reason: string;
  }): Promise<void> {
    // Route the dependent back to the planner WITH the shift as context (kept ALIVE);
    // then CLEAR the in-flight marker so the settle does not also try to resolve it.
    await recordReplanContext(this.pool, input, this.runStateWriter);
    await clearPercolationPending(this.pool, { projectId: input.projectId, runId: input.runId }, this.runStateWriter);
  }
}

/** Reads the affected `integration_nodes` for a base shift (S0 compatibility read-model). */
export class PgBaseShiftNodeReader implements BaseShiftNodeReader {
  private readonly model: PgIntegrationNodeModel;
  constructor(pool: pg.Pool) {
    this.model = new PgIntegrationNodeModel(pool);
  }

  async nodesForDependent(input: { projectId: string; dependent: SpeculativeDependent }): Promise<IntegrationNode[]> {
    // The S0 compatibility read-model projects the project's in-flight speculative run
    // rows as integration nodes; filter to the dependent's own node (its run id labels
    // the integration). Observe-only — it does not branch control flow.
    const nodes = await this.model.projectSpeculativeRunsAsNodes(input.projectId);
    return nodes.filter((n) => n.members.some((m) => m.runId === input.dependent.runId));
  }
}

/**
 * Emits `integration.rebase` (the `rebase_vs_rebuild` signal, §3): the categorical
 * `decision` + kept `runId`. The read-side (engine/insights/integration) joins
 * token/wall-clock cost at read time to PROVE rebase < rebuild. Reuses the
 * org-scoped percolation event writer (same plane-split as the dag.spec.percolation
 * events).
 */
export class PgBaseShiftEventEmitter implements BaseShiftEventEmitter {
  constructor(
    private readonly pool: pg.Pool,
    private readonly runStateWriter?: RunStateWriter,
  ) {}

  async emitRebase(input: {
    projectId: string;
    specId: string;
    runId: string;
    branch: string;
    newBaseSha: string;
    headSha: string;
    rebaseConflicted: boolean;
    decision: RebaseDecision;
  }): Promise<void> {
    // Org-scoped, plane-aware append (the helper routes through the control plane when
    // a writer is wired); `held` never reaches here (it throws before the emit).
    if (input.decision === "held") return;
    await appendIntegrationRebaseEvent(this.pool, input, this.runStateWriter);
  }
}
