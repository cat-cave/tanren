import { z } from "zod";

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
  "done"
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
  done: []
};

export function isAllowedSpecTransition(from: SpecStatus, to: SpecStatus): boolean {
  return allowedSpecTransitions[from].includes(to);
}

export class IllegalSpecTransitionError extends Error {
  constructor(readonly from: SpecStatus, readonly to: SpecStatus) {
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
