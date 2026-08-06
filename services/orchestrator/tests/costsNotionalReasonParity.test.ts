// DRIFT GUARD for the two closed reason enums that exist TWICE on purpose.
//
// `engine/events/schemas/**` is the contract layer: it is exported to JSON Schema
// by `scripts/contract-schema-export.mjs` and, by convention, imports nothing but
// zod and its own siblings — so it cannot reference the engine enums it mirrors.
// The mirrors are therefore hand-copied, and a hand-copied closed enum drifts the
// first time someone adds a value to one side.
//
// The failure mode is NOT loud on its own. Adding a `NotionalReason` and marking it
// loud, without widening the payload enum, makes the event schema reject the
// payload at write time — a runtime rejection on exactly the path whose whole
// purpose is to make an unpriced row legible. This test turns that into a red gate.
import { describe, expect, it } from "vitest";

import { UnmeterableReason, UnpricedNotionalReason } from "../src/engine/events/schemas/costFailures.js";
import { LoudNotionalReason } from "../src/engine/costs/notional.js";
import type { UnmeterableReason as EngineUnmeterableReason } from "../src/engine/costs/meterability.js";

describe("event-schema reason enums mirror their engine sources exactly", () => {
  it("cost.notional_unpriced.reasonCode === LoudNotionalReason", () => {
    // Exact set equality, not containment: a payload enum WIDER than the engine's
    // loud set would silently accept a reason the emitter can never produce, which
    // is the same drift in the other direction.
    expect([...UnpricedNotionalReason.options].sort()).toEqual([...LoudNotionalReason.options].sort());
  });

  it("the unmeterable-route reasons mirror costs/meterability.ts", () => {
    // `UnmeterableReason` in meterability.ts is a bare TS union with no runtime
    // value, so the mirror is pinned the only way it can be: the payload enum's
    // options must be assignable to it, and an exhaustive record over the union
    // must cover exactly those options. Adding a union member without widening the
    // payload enum fails to compile here; widening the payload enum without the
    // union fails the assignment above it.
    const covered: Record<EngineUnmeterableReason, true> = {
      harness_discards_generation_id: true,
      byok_upstream_invoice: true,
    };
    const options: EngineUnmeterableReason[] = [...UnmeterableReason.options];
    expect(options.sort()).toEqual(Object.keys(covered).sort());
  });
});
