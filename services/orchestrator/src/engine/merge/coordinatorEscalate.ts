// The NON-BRICKING conflict-escalation seam for the native merge queue
// (autonomy-engine.md §2c — the loud, non-bricking conflict escalation). When the
// intent-preserving conflict resolver judges two in-flight specs GENUINELY
// irreconcilable, the merge drive returns parking_required and BOTH coordinators
// (one-at-a-time + batch) route it HERE instead of blindly re-executing it.
//
// SpecEscalator.escalate performs the SOLE atomic park and returns the typed
// outcome so settlement branches exhaustively: parked → dequeue needs_attention;
// terminal_noop → dequeue superseded (no needs_attention reason); parking_failed
// → retain the merge entry (never dequeue as parked).

import type pg from "pg";
import type { TerminalParkNoopStatus } from "../contracts/conflictResolution.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import { resolveProjectOrg } from "../dag/percolationWrites.js";
import { parkSpecNeedsAttention, type NeedsAttentionParkOutcome } from "./parkNeedsAttention.js";

/** Typed park outcome returned by SpecEscalator — exhaustive settlement branch input. */
export type SpecEscalateOutcome =
  | { kind: "parked"; newlyFlipped: boolean }
  | { kind: "terminal_noop"; status: TerminalParkNoopStatus }
  | { kind: "parking_failed"; observedStatus?: string };

/**
 * The seam both coordinators reuse to escalate a genuinely-irreconcilable spec. ONE
 * helper, ONE escalation policy — so the one-at-a-time + batch paths can never drift.
 */
export interface SpecEscalator {
  /**
   * Sole atomic park of the entry's spec at needs_attention + emit
   * `dag.spec.needs_attention` when the flip succeeds. Returns the typed outcome
   * so callers settle truthfully — never invent parked without durable proof.
   */
  escalate(input: { projectId: string; entry: MergeQueueEntry; message: string }): Promise<SpecEscalateOutcome>;
}

/** Map the atomic park outcome onto the escalator public type (identity, no alias). */
export function toSpecEscalateOutcome(outcome: NeedsAttentionParkOutcome): SpecEscalateOutcome {
  return outcome;
}

/**
 * The pg-backed escalator. Spec park uses the shared canonical
 * {@link parkSpecNeedsAttention} authority (sole `updateSpecWithEvent` path +
 * PARK_NOT_FROM_STATUSES guard including merged/cancelled/halted/needs_attention).
 */
export class PgSpecEscalator implements SpecEscalator {
  constructor(
    private readonly pool: pg.Pool,
    private readonly runStateWriter: RunStateWriter,
  ) {}

  async escalate(input: { projectId: string; entry: MergeQueueEntry; message: string }): Promise<SpecEscalateOutcome> {
    const orgId = await resolveProjectOrg(this.pool, input.projectId);
    // A required-missing org is a LOUD hard failure (never a silent skip): without an
    // org the spec cannot be parked, so a genuine irreconcilable conflict would be
    // silently dropped — exactly the bricking this escalation exists to prevent.
    if (orgId === null) {
      throw new Error(`cannot escalate spec ${input.entry.specId}: project ${input.projectId} has no org`);
    }

    const outcome = await parkSpecNeedsAttention({
      writer: this.runStateWriter,
      pool: this.pool,
      orgId,
      specId: input.entry.specId,
      event: {
        runId: input.entry.runId,
        specId: input.entry.specId,
        projectId: input.projectId,
        orgId,
        eventType: "dag.spec.needs_attention",
        payload: {
          source: "merge_conflict",
          specId: input.entry.specId,
          prUrl: input.entry.prUrl,
          prNumber: input.entry.prNumber,
          message: input.message,
        },
      },
    });
    return toSpecEscalateOutcome(outcome);
  }
}
