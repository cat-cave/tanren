// The WS1↔WS2 spec-quality gate over the triage stage's `kind: spec` items —
// integration tests over the real subtask loop with in-memory adapters. Extracted
// from `plannerLoop.test.ts` (line-cap) + extended for apex v82's BUG2: a triage-
// PROPOSED persistently-invalid spec is DROPPED + PARKED (never sinks the whole run).
import { describe, expect, it } from "vitest";
import { runSubtaskLoop } from "../src/engine/workflow/subtaskLoop.js";
import { defaultLoopInput, makeAuditor, makeTriage, p1Audit, triageAllSpecs } from "./helpers/plannerLoopHelpers.js";

describe("spec loop — WS1↔WS2 spec-quality gate over triage's new specs", () => {
  const passAnswer = {
    accomplishable: { pass: true, reason: "bounded" },
    demoable: { pass: true, reason: "observable" },
    nonTrivial: { pass: true, reason: "worth a spec" },
    legible: { pass: true, reason: "clear" },
    overall: "pass" as const,
    revisionGuidance: "",
  };
  const reviseAnswer = {
    accomplishable: { pass: false, reason: "an unbounded epic" },
    demoable: { pass: false, reason: "no observable behavior" },
    nonTrivial: { pass: true, reason: "worth a spec" },
    legible: { pass: true, reason: "clear" },
    overall: "revise" as const,
    revisionGuidance: "split into a bounded, demo-able unit",
  };

  it("validates each kind:spec item against the contract and lets a PASSING spec through", async () => {
    const validated: Array<{ title: string }> = [];
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        auditor: makeAuditor([p1Audit]),
        triage: makeTriage([triageAllSpecs]),
      },
      specValidator: {
        validator: {
          validate: (spec) => {
            validated.push({ title: spec.title });
            return Promise.resolve(passAnswer);
          },
        },
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    if (outcome.kind !== "passed") return;
    // The new spec materialized AND the gate ran on it (the seam is real, not a TODO).
    expect(outcome.newSpecs).toHaveLength(1);
    expect(validated).toHaveLength(1);
  });

  it("BUG2: a triage-proposed persistently-invalid spec is DROPPED + PARKED, and the run does NOT fail", async () => {
    // STRICT validator (no reAuthor) + rejecting answer → the triaged spec reaches a
    // genuine fixed point. Under autonomy:auto that proposed spec is an independent
    // audit-derived node, NOT the BUILD spec's critical path — so it is DROPPED +
    // PARKED (triage.completed.droppedSpecs), triage COMPLETES, the run does NOT sink.
    const { input, events } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        auditor: makeAuditor([p1Audit]),
        triage: makeTriage([triageAllSpecs]),
      },
      specValidator: { validator: { validate: () => Promise.resolve(reviseAnswer) } },
    });
    // REACHES a terminal outcome (the old behavior threw and sank the run).
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    if (outcome.kind !== "passed") return;
    // The dropped proposal materializes nothing.
    expect(outcome.newSpecs).toHaveLength(0);
    const triage = events.events.find((e) => e.eventType === "triage.completed")!;
    const dropped = (triage.payload as { droppedSpecs: ReadonlyArray<{ id: string; reason: string }> }).droppedSpecs;
    // Parked for visibility on the triage.completed event, never silent; no stage failure.
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.reason).toContain("split into a bounded");
    expect(events.events.some((e) => e.eventType === "task.failed")).toBe(false);
  });
});
