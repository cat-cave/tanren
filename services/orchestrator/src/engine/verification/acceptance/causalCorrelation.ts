/**
 * rv-12 A3 causal-correlation: the pure, deterministic correlation core. Given a
 * CAUSE the orchestrator drove (its fired-at cursor + optional propagated
 * correlation id) and the immutable rv-8 effect observations recorded for a
 * provider, it computes the set of effects the cause GENUINELY produced.
 *
 * An effect counts as correlated to a cause ONLY when it (a) was observed
 * strictly AFTER the cause fired — a pre-existing effect can never be laundered
 * in; (b) was observed BEFORE the next sibling cause fired — a later cause's
 * effect is never stolen; and (c) — when the assertion demands id-correlation —
 * carries the cause's propagated correlation id, so a concurrent cause's effect
 * with a different id is excluded. An observed-ABSENCE ("missing") is never an
 * occurrence. There is no fabricated or over-broad match: every predicate is a
 * genuine ordering / identity fact drawn from the observation itself.
 *
 * This module is a leaf: it holds only pure functions + the causal contract
 * types, so both the orchestrator and the causal stage import from it without a
 * cycle.
 */

import type { CanonicalBody } from "../../contracts/cas.js";
import type { ComparisonOperator, RequiredSurface } from "../../contracts/runtimeVerificationPlan.js";
import type { EffectObservation } from "../../contracts/sideEffectObserverAdapter.js";

/** A cause the orchestrator drove: the cursor it fired at + its propagated id. */
export interface CauseFiring {
  readonly causeId: string;
  /**
   * The correlation id (e.g. an order/idempotency id) propagated from the cause
   * into its effects. Absent ⇒ the cause offers no id, so an assertion that
   * REQUIRES id-correlation can never match it (fail closed).
   */
  readonly correlationId?: string;
  /**
   * A monotonic cursor captured immediately BEFORE the cause's action ran, so a
   * genuine effect's observation cursor is strictly greater and a pre-existing
   * effect's is not. Compared with {@link compareCursor}.
   */
  readonly firedAtCursor: string;
}

/** How a causal assertion's effects tie back to a driven cause. */
export interface EffectCorrelation {
  /** The cause (in the plan's `causes`) whose effects this assertion counts. */
  readonly causeId: string;
  /** The rv-8 observer name (e.g. "slack"). */
  readonly observer: string;
  /** The rv-8 provider name. */
  readonly provider: string;
  /**
   * When true an effect must carry the cause's correlation id to count; when
   * false the correlation is by window alone (cause..next-cause).
   */
  readonly requireCorrelationId: boolean;
}

/** A cause to drive: which surface fires it and the action it performs. */
export interface CauseSpec {
  readonly causeId: string;
  readonly surface: RequiredSurface;
  readonly action: string;
}

/**
 * Numeric compare when both operands parse as finite numbers, else a stable
 * lexicographic compare. Provider cursors are opaque strings (Slack `ts`,
 * epoch-ms, monotonic counters) — numeric-first keeps "9" < "10" correct while
 * still totally ordering non-numeric cursors.
 *
 * When both parse finite, numeric equality is DECISIVE: two spellings of the same
 * instant ("1000" / "1e3" / "01000") compare EQUAL, never ±1. This is a fail-closed
 * boundary guarantee — {@link correlateEffects} excludes an effect whose cursor
 * equals the cause's fired-at (strict-after) or equals the next sibling's fired-at
 * (belongs to that later cause). A stray non-zero at a numerically-equal boundary
 * would leak such an effect into the window (over-attribution); returning 0 keeps
 * the exclusion airtight regardless of the provider's string formatting.
 */
export function compareCursor(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na < nb ? -1 : na > nb ? 1 : 0;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** The smallest cursor in a set, or undefined when empty. */
export function minCursor(cursors: readonly string[]): string | undefined {
  let min: string | undefined;
  for (const cursor of cursors) {
    if (min === undefined || compareCursor(cursor, min) < 0) min = cursor;
  }
  return min;
}

/**
 * The ordering key an effect carries. Prefer the provider cursor/watermark; fall
 * back to the immutable append time. Absent/non-finite ⇒ the effect has no
 * ordering key and can never be correlated (fail closed) rather than defaulting
 * into a cause's window.
 */
export function effectCursor(effect: EffectObservation): string | undefined {
  if (effect.cursor !== undefined) return effect.cursor;
  const time = effect.createdAt.getTime();
  return Number.isFinite(time) ? String(time) : undefined;
}

/** The identity of one observed effect for set-cardinality (distinctness). */
export function effectIdentity(effect: EffectObservation): string {
  return effect.providerObjectHash ?? effect.observationId;
}

export interface CorrelateInput {
  readonly cause: CauseFiring;
  /** The fired-at cursors of the sibling causes sharing this observer+provider. */
  readonly siblingFiredCursors: readonly string[];
  readonly effects: readonly EffectObservation[];
  readonly requireCorrelationId: boolean;
}

/**
 * The subset of `effects` genuinely produced by `cause`. Every excluded effect
 * is excluded for a real reason: an observed-absence, no ordering key, fired
 * before/at the cause (pre-existing), fired at/after the next sibling cause (a
 * later cause's effect), or — when required — a mismatched correlation id.
 */
export function correlateEffects(input: CorrelateInput): readonly EffectObservation[] {
  const lower = input.cause.firedAtCursor;
  // The window's upper bound is the NEAREST sibling cause that fired AT OR AFTER
  // this one; effects at/after that marker belong to the sibling (or, at the
  // exact same instant, are ambiguous between the two) — never this cause. A
  // sibling at the SAME cursor sets upper == lower, collapsing the window to
  // empty (fail-closed: an effect after two same-instant causes is attributed to
  // NEITHER rather than leaking into BOTH). Only a sibling strictly BEFORE this
  // cause is irrelevant to the upper bound.
  let upper: string | undefined;
  for (const sibling of input.siblingFiredCursors) {
    if (compareCursor(sibling, lower) < 0) continue;
    if (upper === undefined || compareCursor(sibling, upper) < 0) upper = sibling;
  }
  return input.effects.filter((effect) => {
    if (effect.classification === "missing") return false;
    const cursor = effectCursor(effect);
    if (cursor === undefined) return false;
    if (compareCursor(cursor, lower) <= 0) return false;
    if (upper !== undefined && compareCursor(cursor, upper) >= 0) return false;
    if (input.requireCorrelationId) {
      if (input.cause.correlationId === undefined) return false;
      if (effect.triggerIdHash !== input.cause.correlationId) return false;
    }
    return true;
  });
}

const COUNT_OPERATORS = new Set<ComparisonOperator>([
  "equals",
  "not_equals",
  "less_than",
  "less_than_or_equal",
  "greater_than",
  "greater_than_or_equal",
]);

/**
 * The correctly-typed ACTUAL to hand the rv-11 assertion evaluator for a
 * correlated set. The count operators (at-least/at-most/exact via
 * `>=` / `<=` / `==`) see the cardinality as a NUMBER; the set operators
 * (`has_cardinality` / `is_unique` / `exactly_once` / `contains` /
 * `not_contains` / `has_no_effect`) see the ARRAY of effect identities. Both are
 * real observed values — the evaluator's existing fail-closed type discipline
 * then decides pass/fail, so a wrong-typed or empty set can never be laundered.
 */
export function correlatedActual(
  operator: ComparisonOperator,
  correlated: readonly EffectObservation[],
): CanonicalBody {
  if (COUNT_OPERATORS.has(operator)) return correlated.length;
  return correlated.map((effect) => effectIdentity(effect));
}
