// The pg production wirings of the `BaseShiftCoordinator` seams
// (tanren-owns-the-engine.md §3 never-discard, §7 one base-shift handler), split out of
// `baseShiftCoordinator.ts` to keep each file under the caps. Three production-faithful
// pg seams that need NO runner: the KEEP-RUN-ROW persistence (the never-discard writes),
// the S0 integration-node read, and the `integration.rebase` instrumentation emitter.
//
// The live-jj workspace/re-gate/resolver seams that drive the ACTUAL rebase live in
// `baseShiftLiveSeams.ts` — they allocate a runner, rebase the dependent's branch in place
// over jj, re-gate it, and resolve a recorded conflict. A seam failure throws a loud
// `BaseShiftHeldError` so the dependent's work (the run row + branch) survives (never-discard),
// never silently discarded or merged (the §0 boundary made literal).

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { SpeculativeDependent } from "../contracts/changePercolation.js";
import type {
  ConflictRecoveryDisposition,
  ConflictRecoverySettlement,
  ReplanRouteResult,
} from "../contracts/conflictResolution.js";
import type { AncestorStack } from "./ancestorStack.js";
import type { IntegrationNode } from "../contracts/integrationNodes.js";
import type { RecoveryOwnedSettlementWriter, RecoveryParkWriter, RunStateWriter } from "../contracts/runStateWriter.js";
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
  resolveProjectOrg,
} from "./percolationWrites.js";
import { PgBaseShiftOperationStore } from "./baseShiftOperationsPg.js";
import { PgRecoveryRouteSettler, type RecoveryRouteSettler } from "../merge/recoveryRouteSettlement.js";

/**
 * The KEEP-RUN-ROW persistence (never-discard). Every write targets the dependent's
 * EXISTING run — re-point its dynamic base, stamp the in-flight marker pointing at
 * THAT SAME run (the never-discard handle the settle reads), or record the replan
 * context (intent stays ALIVE). It NEVER cancels or creates a run.
 */
export class PgBaseShiftPersistence implements BaseShiftPersistence {
  private readonly recovery: RecoveryRouteSettler;

  constructor(
    private readonly pool: pg.Pool,
    private readonly runStateWriter: RunStateWriter & RecoveryParkWriter & RecoveryOwnedSettlementWriter,
    recovery?: RecoveryRouteSettler,
  ) {
    this.recovery = recovery ?? new PgRecoveryRouteSettler(pool, runStateWriter);
  }

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
  }): Promise<ReplanRouteResult> {
    // Route only. The coordinator consumes the typed result through settleRecovery;
    // it clears the marker only after durable owner/park/terminal truth.
    return recordReplanContext(this.pool, input, this.runStateWriter);
  }

  async settleRecovery(input: {
    projectId: string;
    specId: string;
    runId: string;
    recovery: ConflictRecoveryDisposition;
  }): Promise<ConflictRecoverySettlement> {
    return this.recovery.settle(input);
  }

  async clearInFlight(input: { projectId: string; runId: string }): Promise<void> {
    await clearPercolationPending(this.pool, { projectId: input.projectId, runId: input.runId }, this.runStateWriter);
  }
}

/** Reads the affected AUTHORITATIVE `integration_nodes` for a base shift (gv-17). */
export class PgBaseShiftNodeReader implements BaseShiftNodeReader {
  private readonly model: PgIntegrationNodeModel;
  constructor(private readonly pool: pg.Pool) {
    this.model = new PgIntegrationNodeModel(pool);
  }

  async nodesForDependent(input: { projectId: string; dependent: SpeculativeDependent }): Promise<IntegrationNode[]> {
    const orgId = await resolveProjectOrg(this.pool, input.projectId);
    if (orgId === null) {
      throw new Error(`project ${input.projectId} has no org for authoritative integration-node read`);
    }
    // Resolve branch from the run row (SpeculativeDependent does not carry branch).
    const branch = await runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<{ branch: string }>(`SELECT branch FROM runs WHERE run_id = $1`, [
        input.dependent.runId,
      ]);
      return result.rows[0]?.branch ?? "";
    });
    // Fail-closed: load persisted nodes + normalized members (not the compat projection).
    return this.model.findNodesForDependentRun({
      orgId,
      projectId: input.projectId,
      runId: input.dependent.runId,
      branch,
    });
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
  private readonly shifts: PgBaseShiftOperationStore;

  constructor(
    private readonly pool: pg.Pool,
    private readonly runStateWriter: RunStateWriter,
  ) {
    this.shifts = new PgBaseShiftOperationStore(pool);
  }

  async emitRebase(input: {
    projectId: string;
    specId: string;
    runId: string;
    branch: string;
    newBaseSha: string;
    headSha: string;
    rebaseConflicted: boolean;
    decision: RebaseDecision;
    lineage?: {
      orgId?: string;
      nodeId?: string;
      ancestorSpecId?: string;
      fromBaseSha: string;
      fromMemberKey: string;
      toMemberKey: string;
      fromMembers: ReadonlyArray<{
        specId: string;
        runId: string;
        branch: string;
        headSha: string;
      }>;
      toMembers: ReadonlyArray<{
        specId: string;
        runId: string;
        branch: string;
        headSha: string;
      }>;
      invalidationCause?:
        | "ancestor_landed"
        | "base_moved"
        | "member_head_moved"
        | "stack_restack"
        | "policy_changed"
        | "proof_stale";
    };
  }): Promise<void> {
    // Org-scoped event append for non-held decisions. Held still records durable
    // base_shift_operations history (gv-17 / CRA P0) so a workspace restack that
    // then fails re-gate does not disappear.
    if (input.decision !== "held") {
      await appendIntegrationRebaseEvent(this.pool, input, this.runStateWriter);
    }
    if (input.lineage !== undefined) {
      const orgId = input.lineage.orgId ?? (await resolveProjectOrg(this.pool, input.projectId));
      if (orgId === null) {
        throw new Error(`project ${input.projectId} has no org for base_shift_operations`);
      }
      await this.shifts.record({
        orgId,
        projectId: input.projectId,
        ...(input.lineage.nodeId !== undefined && { nodeId: input.lineage.nodeId }),
        dependentRunId: input.runId,
        dependentSpecId: input.specId,
        ...(input.lineage.ancestorSpecId !== undefined && { ancestorSpecId: input.lineage.ancestorSpecId }),
        fromBaseSha: input.lineage.fromBaseSha,
        toBaseSha: input.newBaseSha,
        fromMemberKey: input.lineage.fromMemberKey,
        toMemberKey: input.lineage.toMemberKey,
        fromMembers: input.lineage.fromMembers,
        toMembers: input.lineage.toMembers,
        decision: input.decision,
        invalidationCause: input.lineage.invalidationCause ?? "stack_restack",
      });
    }
  }
}
