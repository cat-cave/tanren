// P3-0015: capture merge + key helpers.
//
// Each interview round returns a capture DELTA; the engine merges it into the
// running capture monotonically (lists only grow, de-duped by a natural key).
// Splitting this out keeps the engine and the default answerer small and lets
// the merge be unit-tested in isolation.

import { type CaptureBehavior, type CaptureInterface, type CapturePersona, type InterviewCapture } from "./types.js";

function lower(value: string): string {
  return value.trim().toLowerCase();
}

function personaKey(p: CapturePersona): string {
  return lower(p.name);
}

function behaviorKey(b: CaptureBehavior): string {
  return `${lower(b.persona)}::${lower(b.title)}`;
}

function interfaceKey(i: CaptureInterface): string {
  return lower(i.name);
}

function mergeByKey<T>(existing: readonly T[], delta: readonly T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of existing) seen.set(key(item), item);
  for (const item of delta) seen.set(key(item), item); // delta overrides on key collision
  return [...seen.values()];
}

// Merge a partial delta into the running capture. Identity + designDna are
// last-write-wins (a later round can refine them); lists union by natural key;
// rulesets union as a string set preserving order.
export function mergeCapture(current: InterviewCapture, delta: Partial<InterviewCapture>): InterviewCapture {
  const rulesets = [...new Set([...current.rulesets, ...(delta.rulesets ?? [])])];
  return {
    identity: delta.identity ?? current.identity,
    personas: mergeByKey(current.personas, delta.personas ?? [], personaKey),
    behaviors: mergeByKey(current.behaviors, delta.behaviors ?? [], behaviorKey),
    interfaces: mergeByKey(current.interfaces, delta.interfaces ?? [], interfaceKey),
    designDna: delta.designDna !== undefined && delta.designDna !== "" ? delta.designDna : current.designDna,
    architecture:
      delta.architecture !== undefined && delta.architecture.length > 0 ? delta.architecture : current.architecture,
    rulesets,
  };
}
