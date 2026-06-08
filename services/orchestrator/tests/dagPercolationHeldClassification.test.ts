// BLOCKING-3 PROOF (tanren-owns-the-engine.md §3 never-discard, §0 fail-closed): a
// fail-closed `BaseShiftHeldError` thrown by the never-discard base-shift rebase (the live
// engine could not settle the rebase/resolver/gate) must surface as `held` — a DISTINCT
// recoverable outcome (the work survives untouched; Wave 3 resumes it once the live runner is
// plumbed) — and NEVER be mislabeled a real `failed`. This makes the "live engine HOLDS the
// work" claim observable + visibly recoverable.
//
// Driven through TEST FIXTURES (they live here, never src/): a trivial read model + a kick-off
// that throws the production `BaseShiftHeldError`, so the coordinator's pass-level
// classification is asserted with no DB, runner, or model.

import { describe, expect, it } from "vitest";
import type {
  AncestorChangeSignal,
  PercolationEventEmitter,
  PercolationKickOff,
  PercolationReadModel,
  PercolationSettler,
  SpeculativeDependent,
} from "../src/engine/contracts/changePercolation.js";
import { BaseShiftHeldError } from "../src/engine/dag/baseShiftCoordinator.js";
import { PercolatingCoordinator } from "../src/engine/dag/percolation.js";

const PROJECT = "project_held";

function dependent(): SpeculativeDependent {
  return {
    specId: "spec_b",
    runId: "run_b",
    speculativeBase: "tanren/integ/spec_b",
    integratedAncestorShas: { spec_a: "sha-old" },
    verifiedAncestorShas: { spec_a: "sha-old" },
    lifecycleState: "building",
    openFindingMaxSeverity: "unaudited",
  };
}

/** Loads one dependent whose ancestor diverged (so detect kicks off a base-shift rebase). */
const readModel: PercolationReadModel = {
  async loadSpeculativeDependents(): Promise<SpeculativeDependent[]> {
    return [dependent()];
  },
  async loadAncestorSignals(): Promise<AncestorChangeSignal[]> {
    return [{ ancestorSpecId: "spec_a", verifiedSha: "sha-old", currentSha: "sha-new", openFindingMaxSeverity: "P0" }];
  },
};

const noopEmitter: PercolationEventEmitter = {
  async emitPercolating(): Promise<void> {},
  async emitPercolated(): Promise<void> {},
  async emitPercolationDeferred(): Promise<void> {},
  async emitPercolationReplan(): Promise<void> {},
};

const noopSettler: PercolationSettler = {
  async absorb(): Promise<void> {},
  async replan(): Promise<void> {},
};

describe("percolation pass classifies a fail-closed BaseShiftHeldError as `held`, not `failed`", () => {
  it("a BaseShiftHeldError from the kick-off ⇒ result.held (recoverable), result.failed empty", async () => {
    const kickOff: PercolationKickOff = {
      async kickOff(): Promise<never> {
        // The BaseShiftCoordinator's reexecute throws this when the live-jj path holds.
        throw new BaseShiftHeldError("rebase", "live-jj base-shift workspace open is Wave-3-plumbed");
      },
    };
    const coord = new PercolatingCoordinator({ readModel, kickOff, settler: noopSettler, events: noopEmitter });

    const result = await coord.percolate(PROJECT);

    expect(result.held).toEqual(["spec_b"]);
    expect(result.failed).toEqual([]);
  });

  it("a NON-held error (a real fault) still classifies as `failed` (the held path is specific)", async () => {
    const kickOff: PercolationKickOff = {
      async kickOff(): Promise<never> {
        throw new Error("a genuine transient DB/RLS fault");
      },
    };
    const coord = new PercolatingCoordinator({ readModel, kickOff, settler: noopSettler, events: noopEmitter });

    const result = await coord.percolate(PROJECT);

    expect(result.failed).toEqual(["spec_b"]);
    expect(result.held).toEqual([]);
  });
});
