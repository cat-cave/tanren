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

import type pg from "pg";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import { resolveProjectOrg } from "../dag/percolationWrites.js";

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
    private readonly runStateWriter: RunStateWriter,
  ) {}

  async escalate(input: { projectId: string; entry: MergeQueueEntry; message: string }): Promise<void> {
    const orgId = await resolveProjectOrg(this.pool, input.projectId);
    // A required-missing org is a LOUD hard failure (never a silent skip): without an
    // org the spec cannot be parked, so a genuine irreconcilable conflict would be
    // silently dropped — exactly the bricking this escalation exists to prevent.
    if (orgId === null) {
      throw new Error(`cannot escalate spec ${input.entry.specId}: project ${input.projectId} has no org`);
    }

    // Task #48 Site H: the spec `needs_attention` flip + the matching
    // `dag.spec.needs_attention` event are now ATOMIC. The prior split
    // (`parkSpec(...)` + `withScopedStore.append(...)`) issued two separate
    // writes; the partial-event landing was a silent strand surface. The
    // atomic seam (`updateSpecWithEvent` / `applyUpdateSpecWithEvent`)
    // bundles them into ONE org-scoped transaction. Audit D-R3.2: the writer
    // is REQUIRED — the in-process `runWithOrgScope` fallback was an unreachable
    // half-measure since PR #714's `runStateWriterFromEnv` always returns a writer.
    const event = {
      runId: input.entry.runId,
      specId: input.entry.specId,
      projectId: input.projectId,
      eventType: "dag.spec.needs_attention" as const,
      payload: {
        source: "merge_conflict",
        specId: input.entry.specId,
        prUrl: input.entry.prUrl,
        prNumber: input.entry.prNumber,
        message: input.message,
      },
    };
    const spec = {
      specId: input.entry.specId,
      orgId,
      status: "needs_attention",
      notFromStatuses: ["merged", "needs_attention"],
    };
    await this.runStateWriter.updateSpecWithEvent({ spec, event });
  }
}
