// The NON-BRICKING conflict-escalation seam for the native merge queue
// (autonomy-engine.md §2c — the loud, non-bricking conflict escalation). When the
// intent-preserving conflict resolver (wired in a LATER PR) judges two in-flight
// specs GENUINELY irreconcilable, the merge drive returns the `needs_attention`
// outcome and BOTH coordinators (one-at-a-time + batch) route it HERE instead of
// blindly re-executing it. The escalation PARKS the spec at the terminal
// `needs_attention` status — which FREES its merge slot so the rest of the DAG keeps
// moving (it blocks ONLY its dependents, never the whole graph) — and emits the loud
// `dag.spec.needs_attention` event so the parked state is operator-visible. The
// `merge.dequeued` (reason `needs_attention`) + the `markDequeued` are the
// coordinators' job; this seam owns the spec-status escalation + the dag event.
//
// There is NO producer of the escalation yet (the drive resolver still returns the
// recoverable `conflict`) — this is the foundation the later resolver RETURNS into.

import { runWithJobOrgId, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import { resolveProjectOrg } from "../dag/percolationWrites.js";
import { type EventStore, PgEventStore } from "../eventStore.js";

/**
 * The seam both coordinators reuse to escalate a genuinely-irreconcilable spec. ONE
 * helper, ONE escalation policy — so the one-at-a-time + batch paths can never drift.
 */
export interface SpecEscalator {
  /**
   * Park the entry's spec at the terminal `needs_attention` status (freeing its merge
   * slot) + emit the loud `dag.spec.needs_attention` event. Idempotent: an
   * already-merged/done/needs_attention spec is left untouched (the guarded flip
   * matches zero rows), so a concurrent settle never double-escalates or un-merges.
   */
  escalate(input: { projectId: string; entry: MergeQueueEntry; message: string }): Promise<void>;
}

/**
 * The pg-backed escalator. The spec-status flip MIRRORS `markSpecMerged`
 * (coordinatorBuild.ts) — the SAME plane-split guard the strand reconciler's
 * `escalateSpec` uses: route the write through the control-plane `runStateWriter`
 * when wired (the de-privileged data plane can no longer UPDATE `specs` directly),
 * else an org-scoped `UPDATE` on the pool. `notFromStatuses` keeps it an ATOMIC guard
 * — a spec already `merged`/`done`/`needs_attention` is never moved. The org id is
 * resolved system-scoped via `resolveProjectOrg` (the coordinator wakes with no
 * ambient org scope), and the dag event is appended through the same plane-split seam
 * the queue-event emitter uses.
 */
export class PgSpecEscalator implements SpecEscalator {
  constructor(
    private readonly pool: pg.Pool,
    private readonly runStateWriter?: RunStateWriter,
  ) {}

  async escalate(input: { projectId: string; entry: MergeQueueEntry; message: string }): Promise<void> {
    const orgId = await resolveProjectOrg(this.pool, input.projectId);
    // A required-missing org is a LOUD hard failure (never a silent skip): without an
    // org the spec cannot be parked, so a genuine irreconcilable conflict would be
    // silently dropped — exactly the bricking this escalation exists to prevent.
    if (orgId === null) {
      throw new Error(`cannot escalate spec ${input.entry.specId}: project ${input.projectId} has no org`);
    }

    // Park the spec at `needs_attention` (the guarded, plane-split-safe flip).
    await this.parkSpec(orgId, input.entry.specId);

    // Emit the loud parked-state event through the same plane-split seam the queue
    // events use: control plane when wired (the writer resolves the run's org from the
    // ambient per-job org id), else in-process under a short org scope.
    await this.withScopedStore(orgId, (store) =>
      store.append({
        runId: input.entry.runId,
        specId: input.entry.specId,
        projectId: input.projectId,
        eventType: "dag.spec.needs_attention",
        payload: {
          source: "merge_conflict",
          specId: input.entry.specId,
          prUrl: input.entry.prUrl,
          prNumber: input.entry.prNumber,
          message: input.message,
        },
      }),
    );
  }

  /**
   * The guarded, plane-split-safe spec-status flip to `needs_attention` (mirrors
   * `markSpecMerged`): route through the control-plane `runStateWriter` when wired,
   * else an org-scoped `UPDATE`. `notFromStatuses` makes it ATOMIC — an already
   * merged/done/needs_attention spec is never moved (no double-escalate / un-merge).
   */
  private async parkSpec(orgId: string, specId: string): Promise<void> {
    if (this.runStateWriter !== undefined) {
      await this.runStateWriter.setSpecStatus({
        specId,
        orgId,
        status: "needs_attention",
        notFromStatuses: ["merged", "needs_attention"],
      });
      return;
    }
    await runWithOrgScope(this.pool, orgId, async (client) => {
      await client.query(
        `UPDATE specs SET status = 'needs_attention'
           WHERE spec_id = $1 AND status NOT IN ('merged', 'needs_attention')`,
        [specId],
      );
    });
  }

  private async withScopedStore(orgId: string, work: (store: EventStore) => Promise<void>): Promise<void> {
    if (this.runStateWriter !== undefined) {
      const writer = this.runStateWriter;
      await runWithJobOrgId(orgId, () => work(writer));
      return;
    }
    await runWithOrgScope(this.pool, orgId, (client) => work(new PgEventStore(client)));
  }
}
