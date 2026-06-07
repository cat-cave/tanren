// Seam conformance suite for the `VisibilityProjection` contract
// (`engine/contracts/visibilityProjection.ts`, tanren-owns-the-engine.md §0, §6).
// The reusable behavior spec EVERY impl + EVERY caller integration must satisfy —
// the STRUCTURAL best-effort boundary, asserted at the CALLER surface:
//   - the caller holds ONLY the hardened `SafeVisibilityProjection`; invoking a
//     throwing raw method through it does NOT throw (it resolves to a `failed`
//     outcome — the safe method NEVER rejects);
//   - it does NOT alter the recorded decision — the suite drives a sentinel
//     "recorded decision" past a throwing projection and asserts it is UNCHANGED;
//   - a method the raw impl does not provide resolves to `skipped`, never an error.
//
// The point of asserting through `harden(...)` (not the raw `severed` helper) is
// that the boundary is enforced by CONSTRUCTION: a caller cannot reach a
// rejection-prone raw method at all.

import { describe, expect, it } from "vitest";
import {
  harden,
  type ChangeRequestInput,
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
    it("the hardened CALLER surface does NOT throw on a throwing projection (resolves failed)", async () => {
      const safe = harden(harness.makeThrowing());
      // The safe method NEVER rejects — no try/catch at the call site.
      const outcome = await safe.openOrUpdateChangeRequest(CR_INPUT);
      expect(outcome.kind).toBe("failed");
    });

    it("a throwing projection does NOT alter the recorded decision", async () => {
      const safe = harden(harness.makeThrowing());
      // The sentinel internal decision — recorded BEFORE the best-effort projection.
      const recordedDecision = { land: "authorized", mainSha: "sha-1" };

      const outcome = await safe.openOrUpdateChangeRequest(CR_INPUT);

      // The projection failed — but the recorded decision is UNTOUCHED (mirror, not gate).
      expect(outcome.kind).toBe("failed");
      expect(recordedDecision).toEqual({ land: "authorized", mainSha: "sha-1" });
    });

    it("a method the raw impl does NOT provide resolves to skipped, never an error", async () => {
      const safe = harden(harness.makeEmpty());
      const outcome = await safe.publishGate({
        repoFullName: "owner/repo",
        headSha: "s",
        verdict: "passed",
        summary: "",
      });
      expect(outcome.kind).toBe("skipped");
    });
  });
}
