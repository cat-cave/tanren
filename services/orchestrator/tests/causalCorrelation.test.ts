import { describe, expect, it } from "vitest";
import {
  compareCursor,
  correlateEffects,
  correlatedActual,
  effectCursor,
  minCursor,
} from "../src/engine/verification/acceptance/causalCorrelation.js";
import type { EffectObservation } from "../src/engine/contracts/sideEffectObserverAdapter.js";

function effect(overrides: Partial<EffectObservation>): EffectObservation {
  return {
    orgId: "org_1",
    projectId: "project_1",
    observationId: overrides.observationId ?? "obs",
    observer: "slack",
    provider: "slack",
    occurrenceCount: 1,
    classification: "ok",
    createdAt: new Date("2026-07-18T00:00:00.000Z"),
    ...overrides,
  };
}

const ID = (n: number): string => `sha256:${String(n).padStart(64, "0")}`;

describe("rv-12 causal-correlation core", () => {
  it("compareCursor orders numerically then lexicographically", () => {
    // numeric ordering, not lexicographic ("9" < "10")
    expect(compareCursor("9", "10")).toBe(-1);
    expect(compareCursor("10", "9")).toBe(1);
    expect(compareCursor("aaa", "aab")).toBe(-1);
    expect(compareCursor("5", "5")).toBe(0);
  });

  it("compareCursor treats numerically-equal spellings as EQUAL (fail-closed boundary)", () => {
    // Two spellings of the same instant must compare 0, never ±1 — otherwise a
    // boundary effect leaks into the window. Regression pin for #35.
    expect(compareCursor("1000", "1e3")).toBe(0);
    expect(compareCursor("1e3", "1000")).toBe(0);
    expect(compareCursor("2000", "02000")).toBe(0);
    expect(compareCursor("02000", "2000")).toBe(0);
    expect(compareCursor("1000", "1000.0")).toBe(0);
    // Non-finite cursors still fall back to a stable lexicographic order.
    expect(compareCursor("aaa", "aaa")).toBe(0);
    expect(compareCursor("aaa", "aab")).toBe(-1);
  });

  it("effectCursor prefers the provider cursor and falls back to append time", () => {
    expect(effectCursor(effect({ cursor: "3000" }))).toBe("3000");
    expect(effectCursor(effect({ createdAt: new Date(1234) }))).toBe("1234");
  });

  it("minCursor returns the smallest cursor numerically", () => {
    expect(minCursor(["3000", "1000", "2000"])).toBe("1000");
    expect(minCursor([])).toBeUndefined();
  });

  it("correlates an effect that fell strictly inside the cause window", () => {
    const correlated = correlateEffects({
      cause: { causeId: "c1", correlationId: ID(1), firedAtCursor: "1000" },
      siblingFiredCursors: [],
      effects: [effect({ cursor: "1500", triggerIdHash: ID(1) })],
      requireCorrelationId: true,
    });
    expect(correlated).toHaveLength(1);
  });

  it("DECISIVE: a pre-existing effect (observed before the cause fired) is NOT correlated", () => {
    const correlated = correlateEffects({
      cause: { causeId: "c1", correlationId: ID(1), firedAtCursor: "1000" },
      siblingFiredCursors: [],
      // cursor 500 < firedAt 1000 — it existed before the cause.
      effects: [effect({ cursor: "500", triggerIdHash: ID(1) })],
      requireCorrelationId: true,
    });
    expect(correlated).toHaveLength(0);
  });

  it("DECISIVE: an effect from a DIFFERENT cause (wrong id) is NOT correlated", () => {
    const correlated = correlateEffects({
      cause: { causeId: "c1", correlationId: ID(1), firedAtCursor: "1000" },
      siblingFiredCursors: [],
      // in-window but carries a different correlation id.
      effects: [effect({ cursor: "1500", triggerIdHash: ID(2) })],
      requireCorrelationId: true,
    });
    expect(correlated).toHaveLength(0);
  });

  it("DECISIVE: a later cause's effect (past the next-cause boundary) is NOT correlated by window", () => {
    const correlated = correlateEffects({
      cause: { causeId: "c1", firedAtCursor: "1000" },
      // the next cause fired at 2000; cursor 2500 belongs to it, not this cause.
      siblingFiredCursors: ["2000"],
      effects: [effect({ cursor: "2500" }), effect({ cursor: "1500", observationId: "in" })],
      requireCorrelationId: false,
    });
    expect(correlated.map((e) => e.observationId)).toEqual(["in"]);
  });

  it("DECISIVE: an effect at the EXACT cause instant is NOT correlated (strict-after)", () => {
    // firedAt "1000"; an effect whose cursor is a different spelling of 1000 is at
    // the cause instant, not strictly after — it must be excluded. Without the
    // compareCursor numeric-equality fix this leaks in (over-attribution). #35.
    const correlated = correlateEffects({
      cause: { causeId: "c1", firedAtCursor: "1000" },
      siblingFiredCursors: [],
      effects: [effect({ cursor: "1e3", observationId: "at-cause" })],
      requireCorrelationId: false,
    });
    expect(correlated).toHaveLength(0);
  });

  it("DECISIVE: an effect at the EXACT next-sibling instant belongs to the later cause", () => {
    // Next sibling fired at "2000"; an effect at a different spelling of 2000 is at
    // the sibling boundary ⇒ it is the sibling's, not this cause's. Excluded. #35.
    const correlated = correlateEffects({
      cause: { causeId: "c1", firedAtCursor: "1000" },
      siblingFiredCursors: ["2000"],
      effects: [
        effect({ cursor: "02000", observationId: "at-sibling" }),
        effect({ cursor: "1500", observationId: "in" }),
      ],
      requireCorrelationId: false,
    });
    expect(correlated.map((e) => e.observationId)).toEqual(["in"]);
  });

  it("DECISIVE: a DISTINCT sibling at the SAME cursor bounds the window (no infinite-window leak) — Finding 2", () => {
    // Two causes fired at the exact same instant "1000". A later effect at "1500"
    // cannot be attributed to either without ambiguity — the same-cursor sibling
    // sets upper == lower, collapsing the window to empty (fail-closed). Without
    // this the window ran to infinity and the effect leaked into BOTH causes.
    const correlated = correlateEffects({
      cause: { causeId: "c1", firedAtCursor: "1000" },
      siblingFiredCursors: ["1000"],
      effects: [effect({ cursor: "1500", observationId: "ambiguous" })],
      requireCorrelationId: false,
    });
    expect(correlated).toHaveLength(0);
  });

  it("a sibling strictly BEFORE this cause does not spuriously bound the window", () => {
    // A sibling that fired earlier ("500") is irrelevant to THIS cause's upper
    // bound; an in-window effect at "1500" with no later sibling still correlates.
    const correlated = correlateEffects({
      cause: { causeId: "c1", firedAtCursor: "1000" },
      siblingFiredCursors: ["500"],
      effects: [effect({ cursor: "1500", observationId: "in" })],
      requireCorrelationId: false,
    });
    expect(correlated.map((e) => e.observationId)).toEqual(["in"]);
  });

  it("requireCorrelationId=false correlates by WINDOW alone (no id demanded)", () => {
    // An in-window effect with NO trigger id still counts when id-correlation is
    // not required — the window (cause..next-sibling) is the sole gate.
    const correlated = correlateEffects({
      cause: { causeId: "c1", firedAtCursor: "1000" },
      siblingFiredCursors: ["3000"],
      effects: [effect({ cursor: "1500", observationId: "win" })],
      requireCorrelationId: false,
    });
    expect(correlated.map((e) => e.observationId)).toEqual(["win"]);
  });

  it("an observed-absence (classification missing) is never an occurrence", () => {
    const correlated = correlateEffects({
      cause: { causeId: "c1", firedAtCursor: "1000" },
      siblingFiredCursors: [],
      effects: [effect({ cursor: "1500", classification: "missing", occurrenceCount: 0 })],
      requireCorrelationId: false,
    });
    expect(correlated).toHaveLength(0);
  });

  it("requireCorrelationId with a cause that carries no id matches nothing (fail closed)", () => {
    const correlated = correlateEffects({
      cause: { causeId: "c1", firedAtCursor: "1000" },
      siblingFiredCursors: [],
      effects: [effect({ cursor: "1500", triggerIdHash: ID(1) })],
      requireCorrelationId: true,
    });
    expect(correlated).toHaveLength(0);
  });

  it("correlatedActual yields a count for numeric operators and an id array for set operators", () => {
    const effects = [effect({ providerObjectHash: ID(1) }), effect({ providerObjectHash: ID(2) })];
    expect(correlatedActual("greater_than_or_equal", effects)).toBe(2);
    expect(correlatedActual("has_cardinality", effects)).toEqual([ID(1), ID(2)]);
  });
});
