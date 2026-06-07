// BEHAVIOR-SPEC tests for the "tanren owns the engine" cross-cutting guarantees
// (tanren-owns-the-engine.md §0, §3, §4, §5). These are the Wave 1-3 ACCEPTANCE
// CRITERIA: they DOCUMENT the durable system properties no single seam owns (the
// unit + conformance suites pin the per-seam behavior; THESE pin the cross-cutting
// guarantees). They are PENDING — gated behind `RUN_ENGINE_DOCTRINE_SPECS` (unset in
// CI, mirroring the repo's `enabled ? describe : describe.skip` idiom) so they are
// gate-green now. Wave 1-3 fills in each body + flips the gate on.

import { describe, expect, it } from "vitest";

// Unset in CI → the suite is skipped (the conditional-skip idiom the repo uses for
// not-yet-runnable specs). Wave 1-3 sets it once the seams are wired.
const RUN_SPECS = process.env.RUN_ENGINE_DOCTRINE_SPECS === "1";
const spec = RUN_SPECS ? describe : describe.skip;

spec("engine doctrine — cross-cutting guarantees (Wave 1-3 acceptance criteria)", () => {
  // §3 never-discard: a base shift is NEW CONTEXT, not a reason to recreate work.
  describe("never-discard: a base shift preserves the run", () => {
    it("an ancestor landing rebases the existing branch — NO new run is created", () => {
      expect.fail("Wave 1-3: assert WorkspaceVcsCore.rebaseOnto reuses the run (no new run row)");
    });
    it("a clean rebase does NOT re-invoke the planner", () => {
      expect.fail("Wave 1-3: re-plan ONLY when the gate/resolver says the work no longer fits");
    });
    it("a conflicting rebase records a conflict + holds — never cancel-and-regenerate", () => {
      expect.fail("Wave 1-3: the strand reconciler (cancel+recreate) is deleted, not invoked");
    });
  });

  // §0 guaranteed-internal: no policy decision is contingent on an external publish.
  describe("guaranteed-internal: no policy decision is contingent on an external publish", () => {
    it("a failing publishGate does NOT change the MergeAuthority land decision", () => {
      expect.fail("Wave 1-3: a thrown VisibilityProjection failure never alters the recorded decision");
    });
    it("a failing change-request open does NOT block the merge", () => {
      expect.fail("Wave 1-3: the merge proceeds/holds exactly as authorizeLand decided");
    });
    it("the merge authorization is recorded in the SAME transaction as the land", () => {
      expect.fail("Wave 1-3: never published-then-decided — authorize+record are atomic");
    });
  });

  // §3 one run model: eager build / merge batch / stacked PR share ONE path.
  describe("one run model: eager build / merge batch / stacked PR share one path", () => {
    it("eager_base / merge_batch / stack_head are the SAME object — only `purpose` differs", () => {
      expect.fail("Wave 2: one integration_nodes object; purpose never branches control flow");
    });
    it("the base-shift handler is ONE code path for all purposes", () => {
      expect.fail("Wave 2: the two divergent base-shift handlers are deleted, collapsed to one");
    });
  });

  // §3 proof reuse: no recompute when the node key matches.
  describe("proof-reuse: no recompute when the node key matches", () => {
    it("a batch proof carries into the real merge when proofReuseKey matches", () => {
      expect.fail("Wave 3: no second gate run when the key matches");
    });
    it("a bisection reads a prefix node's proof by memberKey", () => {
      expect.fail("Wave 3: no re-gate of the proven prefix");
    });
    it("any drift (gate config / runner image / quarantine) FORCES a recompute", () => {
      expect.fail("Wave 3: a differing proofReuseKey never reuses a stale proof");
    });
  });

  // §4 DORA-tunable: the SAME findings yield different gate verdicts per posture.
  describe("DORA-tunable: same findings block under strict, route under velocity", () => {
    it("under strict (blockReviewAt:P3) a P2/P3 finding BLOCKS reaching review", () => {
      expect.fail("Wave 2: the live gate consults auditPosture, not an inferred severity");
    });
    it("under velocity (blockReviewAt:P1, route-to-dag) the SAME finding routes, not blocks", () => {
      expect.fail("Wave 2: the residual findings become new DAG specs");
    });
    it("DORA metrics + bug-report rates are recorded so a user can MEASURE the posture", () => {
      expect.fail("Wave 3: the integration.* metrics let a user pick the posture empirically");
    });
  });
});
