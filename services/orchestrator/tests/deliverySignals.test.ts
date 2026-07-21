import { describe, expect, it } from "vitest";
import { a3CorrelationId } from "../src/engine/verification/acceptance/httpCauseDriver.js";
import {
  countExactReleaseRequiredA3Evidence,
  type ReleaseRequiredA3Row,
} from "../src/engine/postMerge/delivery/deliverySignals.js";

const DELIVERY = "delivery-a3";
const REQUIRED: readonly ReleaseRequiredA3Row[] = [
  {
    requirement_id: "requirement-a",
    behavior_revision_id: "behavior-a",
    binding_id: "binding-a",
    binding_generation: 3,
    passed: true,
  },
  {
    requirement_id: "requirement-b",
    behavior_revision_id: "behavior-b",
    binding_id: "binding-b",
    binding_generation: 4,
    passed: true,
  },
];

function observed(row: (typeof REQUIRED)[number], overrides: Record<string, unknown> = {}) {
  const causeOrdinal = 0;
  return {
    behaviorRevisionId: row.behavior_revision_id,
    shardId: `a3:${String(row.binding_id)}:${String(row.binding_generation)}`,
    deliveryRunId: DELIVERY,
    correlationId: a3CorrelationId({
      deliveryRunId: DELIVERY,
      behaviorRevisionId: String(row.behavior_revision_id),
      bindingId: String(row.binding_id),
      bindingGeneration: Number(row.binding_generation),
      causeOrdinal,
    }),
    causeOrdinal,
    occurrenceCount: 1,
    ...overrides,
  };
}

describe("release-required A3 delivery signal", () => {
  it("FAIL-CLOSED: an observed effect from a different correlation cannot confirm this delivery", () => {
    const result = countExactReleaseRequiredA3Evidence(
      [REQUIRED[0]!],
      [observed(REQUIRED[0]!, { correlationId: `sha256:${"f".repeat(64)}` })],
      DELIVERY,
    );

    expect(result).toEqual({ required: 1, confirmed: 0 });
  });

  it("requires exact coverage of every requiring behavior, not one requirement-level existence hit", () => {
    const result = countExactReleaseRequiredA3Evidence(REQUIRED, [observed(REQUIRED[0]!)], DELIVERY);

    expect(result).toEqual({ required: 2, confirmed: 1 });
  });

  it("confirms only the complete exact multiset of passed, trigger-bound behavior evidence", () => {
    const result = countExactReleaseRequiredA3Evidence(
      REQUIRED,
      [observed(REQUIRED[0]!), observed(REQUIRED[1]!)],
      DELIVERY,
    );

    expect(result).toEqual({ required: 2, confirmed: 2 });
  });

  it("rejects a duplicate exact coordinate even when its behavior verdict passed", () => {
    const event = observed(REQUIRED[0]!);
    const result = countExactReleaseRequiredA3Evidence([REQUIRED[0]!], [event, event], DELIVERY);

    expect(result).toEqual({ required: 1, confirmed: 0 });
  });

  it("rejects an observed event that reports more than one provider occurrence", () => {
    const result = countExactReleaseRequiredA3Evidence(
      [REQUIRED[0]!],
      [observed(REQUIRED[0]!, { occurrenceCount: 2 })],
      DELIVERY,
    );

    expect(result).toEqual({ required: 1, confirmed: 0 });
  });
});
