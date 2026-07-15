// Canonical needs_attention park authority for every recovery / merge-escalation
// router. Sole write path: RunStateWriter.updateSpecWithEvent. Outcome is never
// fabricated — a flipped row yields parked; a false flip is parked ONLY after an
// org-scoped durable readback proves the row is already needs_attention; a concurrent
// terminal (merged/cancelled/halted) is a typed terminal_noop; anything else is
// parking_failed (live open/in_flight/review, missing row, unknown) — never a
// catch-all unowned alias.

import type pg from "pg";
import type { NeedsAttentionRecoveryReceipt, TerminalParkNoopStatus } from "../contracts/conflictResolution.js";
import type { AppendEventInput } from "../eventStore.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { loadSpecStatusForRecovery } from "./recoveryOwnership.js";

/**
 * Terminal + already-parked statuses the atomic park must never clobber.
 * Matches lifecycle terminal_blocked / done ends (walkerPg.classifySpecStatus):
 * merged is done; halted/cancelled/needs_attention are terminal_blocked.
 */
export const PARK_NOT_FROM_STATUSES = ["merged", "cancelled", "halted", "needs_attention"] as const;

const TERMINAL_NOOP_STATUSES = new Set<string>(["merged", "cancelled", "halted"]);

/**
 * Atomic park outcome after the sole park attempt. Never fabricated:
 * parked / terminal_noop / parking_failed only — no public unowned alias.
 */
export type NeedsAttentionParkOutcome =
  | { kind: "parked"; newlyFlipped: boolean }
  | { kind: "terminal_noop"; status: TerminalParkNoopStatus }
  | { kind: "parking_failed"; observedStatus?: string };

/**
 * Park `specId` → needs_attention + append `dag.spec.needs_attention` atomically.
 * Inspects UpdateSpecWithEventOutcome; never invents a parked receipt without a
 * durable flip or org-scoped needs_attention readback.
 */
export async function parkSpecNeedsAttention(input: {
  writer: RunStateWriter;
  pool: pg.Pool;
  orgId: string;
  specId: string;
  event: AppendEventInput;
}): Promise<NeedsAttentionParkOutcome> {
  const outcome = await input.writer.updateSpecWithEvent({
    spec: {
      specId: input.specId,
      orgId: input.orgId,
      status: "needs_attention",
      notFromStatuses: [...PARK_NOT_FROM_STATUSES],
    },
    event: input.event,
  });
  if (outcome.flipped) {
    return { kind: "parked", newlyFlipped: true };
  }
  // False flip: durable org-scoped readback is the only path to "already parked".
  const status = await loadSpecStatusForRecovery(input.pool, input.orgId, input.specId);
  if (status === "needs_attention") {
    return { kind: "parked", newlyFlipped: false };
  }
  if (status !== undefined && TERMINAL_NOOP_STATUSES.has(status)) {
    return { kind: "terminal_noop", status: status as TerminalParkNoopStatus };
  }
  return {
    kind: "parking_failed",
    ...(status !== undefined && { observedStatus: status }),
  };
}

/** Build a router-facing parked / terminal_noop / parking_failed result from the atomic outcome. */
export function parkOutcomeToRouteResult(
  outcome: NeedsAttentionParkOutcome,
  input: {
    specId: string;
    source: NeedsAttentionRecoveryReceipt["source"];
    message: string;
  },
):
  | { kind: "parked"; receipt: NeedsAttentionRecoveryReceipt; message: string }
  | { kind: "terminal_noop"; status: TerminalParkNoopStatus; message: string }
  | { kind: "parking_failed"; message: string; observedStatus?: string } {
  if (outcome.kind === "parked") {
    return {
      kind: "parked",
      receipt: { kind: "needs_attention", specId: input.specId, source: input.source },
      message: input.message,
    };
  }
  if (outcome.kind === "terminal_noop") {
    return {
      kind: "terminal_noop",
      status: outcome.status,
      message: `${input.message} (concurrent terminal status ${outcome.status} — park no-op; not parking complete)`,
    };
  }
  const observed = outcome.observedStatus === undefined ? " missing row" : ` observed status=${outcome.observedStatus}`;
  return {
    kind: "parking_failed",
    message: `${input.message} (park failed closed:${observed})`,
    ...(outcome.observedStatus !== undefined && { observedStatus: outcome.observedStatus }),
  };
}
