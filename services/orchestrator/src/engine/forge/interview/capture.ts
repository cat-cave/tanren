// capture merge + key helpers.
//
// Each interview round returns a capture DELTA; the engine merges it into the
// running capture monotonically (lists only grow, de-duped by a natural key).
// Splitting this out keeps the engine and the default answerer small and lets
// the merge be unit-tested in isolation.

import {
  type CaptureBehavior,
  type CaptureInterface,
  type CapturePersona,
  type InterviewCapture,
  type InterviewCaptureDelta,
} from "./types.js";

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
  // delta overrides on key collision
  for (const item of delta) seen.set(key(item), item);
  return [...seen.values()];
}

// Merge a partial delta into the running capture. Identity + designDna are
// last-write-wins (a later round can refine them); lists union by natural key;
// rulesets union as a string set preserving order. Every delta field is
// optional and may arrive as `null` (the OpenAI-strict answerer schema returns
// null for fields a round has nothing to add) — `null` is treated exactly like
// an omitted field.
export function mergeCapture(current: InterviewCapture, delta: InterviewCaptureDelta): InterviewCapture {
  const rulesets = [...new Set([...current.rulesets, ...(delta.rulesets ?? [])])];
  return {
    identity: delta.identity ?? current.identity,
    personas: mergeByKey(current.personas, delta.personas ?? [], personaKey),
    behaviors: mergeByKey(current.behaviors, delta.behaviors ?? [], behaviorKey),
    interfaces: mergeByKey(current.interfaces, delta.interfaces ?? [], interfaceKey),
    designDna:
      delta.designDna !== null && delta.designDna !== undefined && delta.designDna !== ""
        ? delta.designDna
        : current.designDna,
    architecture:
      delta.architecture !== null && delta.architecture !== undefined && delta.architecture.length > 0
        ? delta.architecture
        : current.architecture,
    // The lifecycle is last-write-wins (the architecture step captures it; a
    // later round can refine the stack commands). `null` = nothing to add.
    lifecycle: delta.lifecycle !== null && delta.lifecycle !== undefined ? delta.lifecycle : current.lifecycle,
    rulesets,
  };
}
