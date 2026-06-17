// capture merge + key helpers.
//
// Each interview round returns a capture DELTA; the engine merges it into the
// running capture monotonically (lists only grow, de-duped by a natural key).
// Splitting this out keeps the engine and the default answerer small and lets
// the merge be unit-tested in isolation.

import {
  type CaptureBehavior,
  type CaptureInterface,
  type CaptureLifecycle,
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

// Two toolchains are equal iff they resolve to the same name→version set (order and
// duplicate entries irrelevant — last-wins, matching `renderMiseToml`'s projection).
// Compared so a toolchain-only re-emission is correctly seen as a CHANGE (not silently
// "unchanged") by the drift guard.
function normalizeToolchain(toolchain: CaptureLifecycle["toolchain"]): Map<string, string> {
  const byName = new Map<string, string>();
  for (const entry of toolchain) {
    byName.set(entry.name, entry.version);
  }
  return byName;
}
function toolchainEqual(a: CaptureLifecycle["toolchain"], b: CaptureLifecycle["toolchain"]): boolean {
  const aMap = normalizeToolchain(a);
  const bMap = normalizeToolchain(b);
  if (aMap.size !== bMap.size) return false;
  for (const [name, version] of aMap) {
    if (bMap.get(name) !== version) return false;
  }
  return true;
}

function lifecycleEqual(a: CaptureLifecycle, b: CaptureLifecycle): boolean {
  return (
    a.stack === b.stack &&
    a.bootstrap === b.bootstrap &&
    a.tier1 === b.tier1 &&
    a.tier2 === b.tier2 &&
    a.tier3 === b.tier3 &&
    a.build === b.build &&
    a.deploy === b.deploy &&
    toolchainEqual(a.toolchain, b.toolchain)
  );
}

// LIFECYCLE/STACK DRIFT GUARD (apex v28–v31). Resolve how a round's lifecycle
// delta combines with the running capture. The operator's confirmed lifecycle is
// AUTHORITATIVE + preserved verbatim — a later round's LLM answerer is the source
// of the drift (re-writing the stack label, swapping tier commands, dropping
// flags), so once a lifecycle is confirmed we DO NOT take a differing re-emission
// silently. Outcomes (fail-closed — when in doubt, KEEP the confirmed one):
//   - `unchanged` — no lifecycle delta, or it equals the confirmed one (the common
//     case once captured): preserve verbatim.
//   - `initial`   — the first lifecycle ever captured: take it + latch confirmed.
//   - `drift`     — a DIFFERENT lifecycle on an already-confirmed capture WITHOUT
//     the explicit `lifecycleChange` signal: REJECT it, preserve the confirmed one,
//     and surface the attempt (operator-visible, not swallowed).
//   - `changed`   — a DIFFERENT lifecycle with `lifecycleChange === true`: an
//     EXPLICIT, operator-visible change — take it (still confirmed).
export type LifecycleResolution =
  | { readonly outcome: "unchanged"; readonly lifecycle: CaptureLifecycle | null; readonly confirmed: boolean }
  | { readonly outcome: "initial"; readonly lifecycle: CaptureLifecycle; readonly confirmed: true }
  | {
      readonly outcome: "drift";
      readonly lifecycle: CaptureLifecycle;
      readonly attempted: CaptureLifecycle;
      readonly confirmed: true;
    }
  | { readonly outcome: "changed"; readonly lifecycle: CaptureLifecycle; readonly confirmed: true };

export function resolveLifecycle(current: InterviewCapture, delta: InterviewCaptureDelta): LifecycleResolution {
  const incoming = delta.lifecycle ?? null;
  // No incoming lifecycle this round (omitted or `null`) ⇒ preserve as-is.
  if (incoming === null) {
    return { outcome: "unchanged", lifecycle: current.lifecycle, confirmed: current.lifecycleConfirmed };
  }
  // First capture (nothing confirmed yet) ⇒ take it + latch confirmed.
  if (current.lifecycle === null || !current.lifecycleConfirmed) {
    return { outcome: "initial", lifecycle: incoming, confirmed: true };
  }
  // Re-emitted identical to the confirmed one ⇒ no drift, preserve verbatim.
  if (lifecycleEqual(current.lifecycle, incoming)) {
    return { outcome: "unchanged", lifecycle: current.lifecycle, confirmed: true };
  }
  // A DIFFERENT lifecycle on a confirmed capture. Only an EXPLICIT change signal
  // takes it; otherwise it is silent drift — preserve the confirmed one + surface.
  if (delta.lifecycleChange === true) {
    return { outcome: "changed", lifecycle: incoming, confirmed: true };
  }
  return { outcome: "drift", lifecycle: current.lifecycle, attempted: incoming, confirmed: true };
}

// Merge a partial delta into the running capture. Identity + designContract are
// last-write-wins (a later round can refine them); lists union by natural key;
// rulesets union as a string set preserving order. Every delta field is
// optional and may arrive as `null` (the OpenAI-strict answerer schema returns
// null for fields a round has nothing to add) — `null` is treated exactly like
// an omitted field. The lifecycle is the ONE exception to last-write-wins: once
// operator-confirmed it is PINNED (see `resolveLifecycle`) so a later LLM round
// cannot silently drift the operator's declared stack.
export function mergeCapture(current: InterviewCapture, delta: InterviewCaptureDelta): InterviewCapture {
  const rulesets = [...new Set([...current.rulesets, ...(delta.rulesets ?? [])])];
  const lifecycle = resolveLifecycle(current, delta);
  return {
    identity: delta.identity ?? current.identity,
    personas: mergeByKey(current.personas, delta.personas ?? [], personaKey),
    behaviors: mergeByKey(current.behaviors, delta.behaviors ?? [], behaviorKey),
    interfaces: mergeByKey(current.interfaces, delta.interfaces ?? [], interfaceKey),
    // The design contract is last-write-wins: a later round refines the captured
    // design intent. `null`/absent = nothing to add this round (keep current).
    designContract:
      delta.designContract !== null && delta.designContract !== undefined
        ? delta.designContract
        : current.designContract,
    architecture:
      delta.architecture !== null && delta.architecture !== undefined && delta.architecture.length > 0
        ? delta.architecture
        : current.architecture,
    // PINNED: a confirmed lifecycle is preserved verbatim; only the initial capture
    // or an EXPLICIT operator-visible change replaces it (drift is rejected here).
    lifecycle: lifecycle.lifecycle,
    lifecycleConfirmed: lifecycle.confirmed,
    rulesets,
  };
}
