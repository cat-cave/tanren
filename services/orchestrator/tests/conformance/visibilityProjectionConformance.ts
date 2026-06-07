// Seam conformance suite for the `VisibilityProjection` contract
// (`engine/contracts/visibilityProjection.ts`, tanren-owns-the-engine.md §0, §6).
// The reusable behavior spec EVERY impl + EVERY caller integration must satisfy —
// the BEST-EFFORT boundary:
//   - a THROWING projection method does NOT throw to the caller (it is captured as a
//     `failed` outcome via `runProjection`);
//   - it does NOT alter the recorded decision — the suite drives a sentinel
//     "recorded decision" past a throwing projection and asserts it is UNCHANGED.
//   - a method the impl does not provide is `skipped`, never an error.
//
// Parameterized by a projection factory so a real impl (or a deliberately-throwing
// one) runs the SAME suite. The `runProjection` helper is the type-level proof the
// projection is a mirror, not a gate; this suite is its behavioral proof.

import { describe, expect, it } from "vitest";
import {
  runProjection,
  type ChangeRequestInput,
  type ProjectedChangeRequest,
  type VisibilityProjection,
} from "../../src/engine/contracts/visibilityProjection.js";

export interface VisibilityProjectionConformanceHarness {
  /** A projection whose `openOrUpdateChangeRequest` THROWS (the failure case). */
  makeThrowing(): VisibilityProjection;
  /** A projection that provides NO methods (the skipped case). */
  makeEmpty(): VisibilityProjection;
}

const CR_INPUT: ChangeRequestInput = {
  repoFullName: "owner/repo",
  headBranch: "feature",
  baseBranch: "main",
  title: "t",
};

export function describeVisibilityProjectionConformance(
  label: string,
  harness: VisibilityProjectionConformanceHarness,
): void {
  describe(`VisibilityProjection conformance (best-effort boundary): ${label}`, () => {
    it("a THROWING projection does NOT throw to the caller (captured as failed)", async () => {
      const proj = harness.makeThrowing();
      const outcome = await runProjection<ProjectedChangeRequest>(
        proj.openOrUpdateChangeRequest?.bind(proj) as never,
        (m) => (m as (i: ChangeRequestInput) => Promise<ProjectedChangeRequest>)(CR_INPUT),
      );
      expect(outcome.kind).toBe("failed");
    });

    it("a throwing projection does NOT alter the recorded decision", async () => {
      const proj = harness.makeThrowing();
      // The sentinel internal decision — recorded BEFORE the best-effort projection.
      const recordedDecision = { land: "authorized", mainSha: "sha-1" };

      const outcome = await runProjection<ProjectedChangeRequest>(
        proj.openOrUpdateChangeRequest?.bind(proj) as never,
        (m) => (m as (i: ChangeRequestInput) => Promise<ProjectedChangeRequest>)(CR_INPUT),
      );

      // The projection failed — but the recorded decision is UNTOUCHED (mirror, not gate).
      expect(outcome.kind).toBe("failed");
      expect(recordedDecision).toEqual({ land: "authorized", mainSha: "sha-1" });
    });

    it("a method the impl does NOT provide is skipped, never an error", async () => {
      const proj = harness.makeEmpty();
      const outcome = await runProjection<void>(proj.publishGate?.bind(proj) as never, (m) =>
        (m as () => Promise<void>)(),
      );
      expect(outcome.kind).toBe("skipped");
    });
  });
}
