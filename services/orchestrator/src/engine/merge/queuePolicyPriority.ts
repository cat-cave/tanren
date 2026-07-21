// Deterministic route aging. Later admitted queue entries are the progress
// coordinate; wall-clock time never promotes a merge candidate.
import { SpecPriority, type SpecPriority as SpecPriorityValue } from "../state/spec.js";

interface PrioritySnapshot {
  priority: SpecPriorityValue;
  aging: { enabled: boolean; step: number };
}

const ORDER: readonly SpecPriorityValue[] = ["P0", "P1", "P2", "tbd"];

export function effectiveQueuePriority(input: {
  snapshot: unknown;
  override: unknown;
  laterEntries: unknown;
  basePriority?: unknown;
}): SpecPriorityValue {
  if (input.snapshot === null) return SpecPriority.parse(input.basePriority);
  if (input.override !== null) return SpecPriority.parse(input.override);
  const snapshot = parsePrioritySnapshot(input.snapshot);
  if (!Number.isInteger(input.laterEntries) || typeof input.laterEntries !== "number" || input.laterEntries < 0) {
    throw new Error("queue policy aging coordinate is malformed");
  }
  const promotions = snapshot.aging.enabled ? Math.floor(input.laterEntries / snapshot.aging.step) : 0;
  const index = ORDER.indexOf(snapshot.priority);
  const result = ORDER[Math.max(0, index - promotions)];
  if (result === undefined) throw new Error("queue policy priority is malformed");
  return result;
}

function parsePrioritySnapshot(value: unknown): PrioritySnapshot {
  if (typeof value !== "object" || value === null) throw new Error("queue policy priority snapshot is malformed");
  const priority = SpecPriority.safeParse(Reflect.get(value, "priority"));
  const aging = Reflect.get(value, "aging");
  if (!priority.success || typeof aging !== "object" || aging === null) {
    throw new Error("queue policy priority snapshot is malformed");
  }
  const enabled = Reflect.get(aging, "enabled");
  const step = Reflect.get(aging, "step");
  if (typeof enabled !== "boolean" || typeof step !== "number" || !Number.isInteger(step) || step < 1) {
    throw new Error("queue policy priority snapshot is malformed");
  }
  return { priority: priority.data, aging: { enabled, step } };
}
