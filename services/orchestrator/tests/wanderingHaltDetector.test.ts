// apex v67 finding #122 — the SECOND convergence signal: the wandering-halt detector
// (`wanderingHaltDetector.ts`) + its integration with the run-finalize authority
// (`runFinalizeAuthority.decideRunDisposition`). The existing fixed-point detector
// (`convergenceDetector.ts`) keys on the SAME-failure-recurring axis; a spec whose failure
// code keeps CHANGING (workspace → agent → internal → merge → ...) never trips it. The
// wandering-halt detector catches the changing-failure-no-progress trap by tracking the
// trailing run of re-drives with ZERO deliverable progress (no new max stage, no PR
// opened, no merge). This file pins:
//   (a) the pure assess function's threshold + progress semantics, AND
//   (b) the authority's PRIORITY: the fixed-point detector fires FIRST, the
//       wandering-halt detector fires SECOND (a same-failure spec escalates as `strand`,
//       not `wandering_halt`, even when both verdicts would fire).

import { describe, expect, it } from "vitest";
import {
  assessWanderingHalt,
  DEFAULT_WANDERING_HALT_THRESHOLD,
  type WanderingAttempt,
} from "../src/engine/workflow/wanderingHaltDetector.js";
import { decideRunDisposition } from "../src/engine/workflow/runFinalizeAuthority.js";

/** Build a synthetic re-drive history. Each attempt defaults to `stage: "workspace"` with
 * no PR / no merge — the canonical wandering shape (only the failure code differs). The
 * caller overrides any axis per-attempt. */
function attempts(specs: Array<Partial<WanderingAttempt> & { failureCode: string }>): WanderingAttempt[] {
  return specs.map((s) => ({
    failureCode: s.failureCode,
    stage: s.stage ?? "workspace",
    prCreatedSoFar: s.prCreatedSoFar ?? false,
    mergeCompletedSoFar: s.mergeCompletedSoFar ?? false,
  }));
}

describe("assessWanderingHalt — the pure detector", () => {
  it("a history shorter than the threshold is NEVER wandering (no enough re-drives yet)", () => {
    // v67's actual halt point: 3 re-drives (workspace → agent → ???). Below threshold ⇒ no fire.
    const h = attempts([{ failureCode: "workspace" }, { failureCode: "internal" }, { failureCode: "internal" }]);
    expect(assessWanderingHalt(h).wandering).toBe(false);
  });

  it("5 re-drives with DIFFERENT failure codes + no PR + same stage ⇒ WANDERING (the v67 anti-pattern)", () => {
    // Each re-drive has a different failureCode but is stuck at the SAME stage with no PR opened.
    // The fixed-point detector cannot see this (every attempt has a different failure signature);
    // the wandering-halt detector catches it.
    const h = attempts([
      { failureCode: "workspace" },
      { failureCode: "internal" },
      { failureCode: "merge" },
      { failureCode: "deploy" },
      { failureCode: "empty_writer_output" },
    ]);
    expect(assessWanderingHalt(h)).toEqual({
      wandering: true,
      totalRedrives: 5,
      noProgressStreak: DEFAULT_WANDERING_HALT_THRESHOLD,
      distinctFailureCodes: ["workspace", "internal", "merge", "deploy", "empty_writer_output"],
    });
  });

  it("5 re-drives with a `github.pr.created` between rounds 2 and 3 ⇒ NOT wandering (deliverable progress)", () => {
    // PR creation between attempts 2 and 3 means attempt 3's `prCreatedSoFar` flips from false
    // to true — the cumulative spec-level state ADVANCED. That breaks the no-progress streak,
    // so attempts 3..5 cannot complete a fresh threshold-length wandering run from there.
    const h = attempts([
      { failureCode: "workspace" },
      { failureCode: "internal" },
      { failureCode: "merge", prCreatedSoFar: true },
      { failureCode: "deploy", prCreatedSoFar: true },
      { failureCode: "empty_writer_output", prCreatedSoFar: true },
    ]);
    expect(assessWanderingHalt(h).wandering).toBe(false);
  });

  it("5 re-drives that ADVANCE through pipeline stages ⇒ NOT wandering (each new stage is progress)", () => {
    // bootstrap → credentials → workspace → agent → merge: each re-drive reaches a NEW max stage,
    // so the no-progress streak resets every attempt. Wandering never fires.
    const h = attempts([
      { failureCode: "workspace", stage: "bootstrap" },
      { failureCode: "workspace", stage: "credentials" },
      { failureCode: "workspace", stage: "workspace" },
      { failureCode: "internal", stage: "agent" },
      { failureCode: "merge", stage: "merge" },
    ]);
    expect(assessWanderingHalt(h).wandering).toBe(false);
  });

  it("a custom threshold below the default fires earlier (the knob is honored, with a floor of 2)", () => {
    const h = attempts([{ failureCode: "workspace" }, { failureCode: "internal" }, { failureCode: "merge" }]);
    expect(assessWanderingHalt(h, { threshold: 3 }).wandering).toBe(true);
    // A threshold below 2 is meaningless (a single attempt cannot wander); the detector floors
    // it at 2, so a 1-attempt history is never wandering even at threshold 1.
    expect(assessWanderingHalt([attempts([{ failureCode: "workspace" }])[0]!], { threshold: 1 }).wandering).toBe(false);
  });

  it("a single deliverable-progress signal anywhere in the trailing window prevents the verdict", () => {
    // 5 attempts, but attempt 4 reaches a NEW stage — the trailing window of 5 contains an
    // advancement, so wandering does NOT fire (only the same-stage 3-attempt suffix would,
    // and that is below the default threshold).
    const h = attempts([
      { failureCode: "workspace" },
      { failureCode: "internal" },
      { failureCode: "merge" },
      { failureCode: "deploy", stage: "agent" },
      { failureCode: "empty_writer_output", stage: "agent" },
    ]);
    expect(assessWanderingHalt(h).wandering).toBe(false);
  });
});

describe("decideRunDisposition — the wandering-halt verdict integrates as a SECOND convergence signal", () => {
  it("a WANDERING verdict (no fixed-point) escalates as `genuine_halt` with source=wandering_halt", () => {
    const wandering = assessWanderingHalt(
      attempts([
        { failureCode: "workspace" },
        { failureCode: "internal" },
        { failureCode: "merge" },
        { failureCode: "deploy" },
        { failureCode: "empty_writer_output" },
      ]),
    );
    expect(wandering.wandering).toBe(true);
    const disposition = decideRunDisposition(
      { kind: "error", error: new Error("synthesized internal failure") },
      { priorSameFixedPoint: 0, wandering },
    );
    expect(disposition).toMatchObject({
      bucket: "genuine_halt",
      source: "wandering_halt",
      reason: "persistent_failure",
      wanderingDiagnostics: { totalRedrives: 5 },
    });
    expect((disposition as { message: string }).message).toMatch(/WANDERING halt/u);
  });

  it("the FIXED-POINT detector wins when BOTH would fire (5 same-code attempts ⇒ source=strand)", () => {
    // Construct a wandering verdict that would fire (5 same-code redrives at same stage no PR);
    // but the same input also makes the fixed-point judge fire (priorSameFixedPoint=1 here).
    // In `decideFromCode` the fixed-point check is FIRST — so the disposition is `strand`, not
    // `wandering_halt`. The wandering-halt detector is the SECONDARY signal; the existing
    // primary path is untouched.
    const wandering = assessWanderingHalt(
      attempts([
        { failureCode: "internal" },
        { failureCode: "internal" },
        { failureCode: "internal" },
        { failureCode: "internal" },
        { failureCode: "internal" },
      ]),
    );
    expect(wandering.wandering).toBe(true);
    const disposition = decideRunDisposition(
      { kind: "error", error: new Error("synthesized internal failure") },
      { priorSameFixedPoint: 1, wandering },
    );
    expect(disposition).toMatchObject({
      bucket: "genuine_halt",
      source: "strand",
      reason: "persistent_failure",
    });
    expect((disposition as { wanderingDiagnostics?: unknown }).wanderingDiagnostics).toBeUndefined();
  });

  it("no wandering + no fixed-point ⇒ RE-DRIVE (the existing unbounded-while-progressing behavior)", () => {
    const disposition = decideRunDisposition(
      { kind: "error", error: new Error("synthesized internal failure") },
      { priorSameFixedPoint: 0, wandering: { wandering: false } },
    );
    expect(disposition.bucket).toBe("re_drive");
  });
});
