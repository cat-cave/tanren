import { z } from "zod";

/**
 * The execution priority of a spec (autonomy-engine.md §1b). It is NOT a state
 * machine value (no transitions) — it is the ordering key the DagWalker honors
 * when choosing which ready specs to enqueue first: P0 before P1 before P2 before
 * `tbd` (not yet triaged). It originates on a `ProposedSpec` (discovery/triage) and is
 * persisted onto the spec at create time. `priorityRank` maps it to a sortable
 * integer (lower = scheduled first); the DB CHECK in `db/src/schemaCore.ts`
 * mirrors these literals. `tbd` means not-yet-triaged and sorts last.
 */
export const SpecPriority = z.enum(["P0", "P1", "P2", "tbd"]);
export type SpecPriority = z.infer<typeof SpecPriority>;

/** The default priority a not-yet-triaged spec carries (matches the DB column default). */
export const DEFAULT_SPEC_PRIORITY: SpecPriority = "tbd";

const SPEC_PRIORITY_RANK: Record<SpecPriority, number> = { P0: 0, P1: 1, P2: 2, tbd: 3 };

/** Sortable rank for a priority — lower sorts first (P0=0 … tbd=3). */
export function priorityRank(priority: SpecPriority): number {
  return SPEC_PRIORITY_RANK[priority];
}

// The single, canonical spec-status vocabulary (v21). A spec is `open` (ready to
// schedule, not yet started), `in_flight` (occupying a DAG slot — claimed or
// running), `review` (PR open, awaiting merge), or `merged` (the satisfied
// terminal). `halted`/`cancelled` are terminal-blocked; `needs_attention` is the
// bounded-escalation terminal. There is NO second `pending/active/done` vocabulary
// — every producer and consumer speaks THIS one, so `classifySpecStatus` no longer
// normalizes two enums.
export const SpecStatus = z.enum([
  "open",
  "in_flight",
  "review",
  "merged",
  "halted",
  "cancelled",
  // NEVER-STRAND escalation (the safety-net reconciler): a spec the
  // strand-reconciler re-enqueued more than the bounded number of times is moved
  // to `needs_attention` — a TERMINAL escalation status that frees the DAG slot
  // and blocks ONLY its dependents (never the whole DAG), surfacing a loud,
  // bounded ask-for-help rather than re-enqueuing forever. (Also reused for
  // genuine-conflict escalation.)
  "needs_attention",
]);
export type SpecStatus = z.infer<typeof SpecStatus>;

const allowedSpecTransitions: Record<SpecStatus, ReadonlyArray<SpecStatus>> = {
  // A fresh spec is `open`; claiming a slot moves it `in_flight`.
  open: ["in_flight"],
  // The strand-reconciler flips `in_flight → open` (re-enqueue) and, on bounded
  // escalation, `in_flight → needs_attention` (give up loudly). A merge can also
  // land an in-flight spec directly at `merged` (the native-queue drive path).
  in_flight: ["review", "merged", "halted", "cancelled", "open", "needs_attention"],
  review: ["merged", "halted"],
  halted: ["in_flight", "cancelled"],
  merged: [],
  cancelled: [],
  // A spec surfaced for human attention is not AUTO-transitioned onward by any
  // background loop (the strand reconciler / merge coordinator never re-touch it).
  // The ONE permitted exit is the operator's explicit human-in-the-loop resolution
  // (the `requeue` endpoint, workflow/requeueAttentionSpec): once the human has
  // ADDRESSED the underlying blocker they re-enter the spec at `open` so the
  // DagWalker re-picks it up. This is the escalation discipline's "addressed,
  // proceed" — the only transition out of the bounded-escalation terminal.
  needs_attention: ["open"],
};

export function isAllowedSpecTransition(from: SpecStatus, to: SpecStatus): boolean {
  return allowedSpecTransitions[from].includes(to);
}

export class IllegalSpecTransitionError extends Error {
  constructor(
    readonly from: SpecStatus,
    readonly to: SpecStatus,
  ) {
    super(`illegal spec transition: ${from} -> ${to}`);
  }
}

export function transitionSpec(from: SpecStatus, to: SpecStatus): asserts to is SpecStatus {
  if (!isAllowedSpecTransition(from, to)) {
    throw new IllegalSpecTransitionError(from, to);
  }
}

export function listAllowedSpecTransitions(from: SpecStatus): ReadonlyArray<SpecStatus> {
  return allowedSpecTransitions[from];
}
