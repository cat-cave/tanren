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

export const SpecStatus = z.enum([
  // Phase 2 canonical values
  "open",
  "in_flight",
  "review",
  "merged",
  "halted",
  "cancelled",
  // Phase 0/1 historical values still present in the database
  "pending",
  "active",
  "done",
]);
export type SpecStatus = z.infer<typeof SpecStatus>;

const allowedSpecTransitions: Record<SpecStatus, ReadonlyArray<SpecStatus>> = {
  open: ["in_flight"],
  in_flight: ["review", "halted", "cancelled", "done"],
  review: ["merged", "halted"],
  halted: ["in_flight", "cancelled"],
  merged: [],
  cancelled: [],
  // Legacy transitions kept until callers migrate
  pending: ["active", "open"],
  active: ["done", "halted", "cancelled", "in_flight"],
  done: [],
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
