// Hot-loop PROOF (apex-v35): the `dag.spec.percolation_deferred` emit must fire ONLY on a
// STATE TRANSITION, never once-per-pass.
//
// The live repro: a lazy/deferred dependent re-emitted `percolation_deferred` (carrying a
// runId) on EVERY percolation pass. That append fires a `tanren_run` NOTIFY → re-wakes the
// DagWalker subscriber → re-walk → re-percolate → re-emit: a self-feeding hot-loop (1030
// `percolation_deferred` events in seconds). The fix gates the emit on a per-spec state
// transition (the deferred (ancestor, pending SHA) changed from the last one emitted), so a
// repeated pass over the SAME lazy state is suppressed — but a GENUINE new lazy change still
// re-emits (the fix never silences a real transition).
//
// Driven through TEST FIXTURES (a stable read model + a recording emitter), so the
// suppression + the changed-state re-emit are asserted deterministically with no DB.

import { describe, expect, it } from "vitest";
import type {
  AncestorChangeSignal,
  PercolationEventEmitter,
  PercolationKickOff,
  PercolationReadModel,
  PercolationSettler,
  SpeculativeDependent,
} from "../src/engine/contracts/changePercolation.js";
import { PercolatingCoordinator } from "../src/engine/dag/percolation.js";

const PROJECT = "project_deferred";

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

// A read model whose ancestor signal is LAZY (SHA changed, only a non-blocking P2 finding) —
// so each detect classifies `lazy` → `percolation_deferred`. `pendingSha` is mutated by a
// test to simulate a genuine NEW lazy change (a state transition).
function lazyReadModel(pendingSha: { value: string }): PercolationReadModel {
  return {
    async loadSpeculativeDependents(): Promise<SpeculativeDependent[]> {
      return [dependent()];
    },
    async loadAncestorSignals(): Promise<AncestorChangeSignal[]> {
      return [
        {
          ancestorSpecId: "spec_a",
          verifiedSha: "sha-old",
          currentSha: pendingSha.value,
          openFindingMaxSeverity: "P2",
        },
      ];
    },
  };
}

class RecordingEmitter implements PercolationEventEmitter {
  readonly deferred: Array<{ specId: string; ancestorSpecId: string; pendingAncestorSha: string }> = [];
  async emitPercolating(): Promise<void> {}
  async emitPercolated(): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async emitPercolationDeferred(input: {
    specId: string;
    ancestorSpecId: string;
    pendingAncestorSha: string;
  }): Promise<void> {
    this.deferred.push({
      specId: input.specId,
      ancestorSpecId: input.ancestorSpecId,
      pendingAncestorSha: input.pendingAncestorSha,
    });
  }
  async emitPercolationReplan(): Promise<void> {}
}

const noopSettler: PercolationSettler = {
  async absorb() {
    return { result: "absorbed" };
  },
  async replan() {
    return { result: "replanned", reexecRunId: "run_replan" };
  },
};

// A kick-off that should NEVER be called on the lazy path (a lazy change defers, it does not
// re-execute). A call is a test bug surfaced loudly.
const unusedKickOff: PercolationKickOff = {
  async kickOff(): Promise<never> {
    throw new Error("kickOff must not run on the lazy/deferred path");
  },
};

describe("percolation_deferred emits only on a state transition (apex-v35 hot-loop fix)", () => {
  it("repeated passes over an UNCHANGED deferred state emit percolation_deferred AT MOST ONCE", async () => {
    const pendingSha = { value: "sha-new" };
    const emitter = new RecordingEmitter();
    const coord = new PercolatingCoordinator({
      readModel: lazyReadModel(pendingSha),
      kickOff: unusedKickOff,
      settler: noopSettler,
      events: emitter,
    });

    // Drive the storm: many passes with NO underlying change (the live 1030-in-seconds loop).
    for (let i = 0; i < 25; i++) {
      const result = await coord.percolate(PROJECT);
      // Every pass still classifies + records the dependent as deferred (the lazy STATE is
      // unchanged) — only the redundant EMIT is suppressed.
      expect(result.deferred).toEqual(["spec_b"]);
    }

    // The self-feeding emit fired exactly ONCE (the first transition into the deferred state),
    // not once per pass.
    expect(emitter.deferred).toHaveLength(1);
    expect(emitter.deferred[0]).toMatchObject({
      specId: "spec_b",
      ancestorSpecId: "spec_a",
      pendingAncestorSha: "sha-new",
    });
  });

  it("a CHANGED pending SHA is a genuine transition and DOES re-emit (the fix never silences a real change)", async () => {
    const pendingSha = { value: "sha-new" };
    const emitter = new RecordingEmitter();
    const coord = new PercolatingCoordinator({
      readModel: lazyReadModel(pendingSha),
      kickOff: unusedKickOff,
      settler: noopSettler,
      events: emitter,
    });

    // First deferred state — emits once.
    await coord.percolate(PROJECT);
    // Repeat the SAME state — suppressed.
    await coord.percolate(PROJECT);
    expect(emitter.deferred).toHaveLength(1);

    // A GENUINE new lazy change: the ancestor advances to a new pending SHA. This IS a state
    // transition and MUST re-emit so a real re-evaluation is never dropped.
    pendingSha.value = "sha-newer";
    await coord.percolate(PROJECT);
    expect(emitter.deferred).toHaveLength(2);
    expect(emitter.deferred[1]).toMatchObject({ pendingAncestorSha: "sha-newer" });

    // And that newer state, repeated, is again suppressed (one-emit-per-transition holds).
    await coord.percolate(PROJECT);
    expect(emitter.deferred).toHaveLength(2);
  });

  it("leaving then RE-ENTERING the deferred state re-emits once (the marker clears on exit)", async () => {
    // The dependent's verified SHA catches up (no change ⇒ `unchanged`, which clears the
    // deferred marker), then a NEW lazy change appears later — that re-entry must re-emit.
    const pendingSha = { value: "sha-new" };
    let unchanged = false;
    const emitter = new RecordingEmitter();
    const readModel: PercolationReadModel = {
      async loadSpeculativeDependents(): Promise<SpeculativeDependent[]> {
        return [dependent()];
      },
      async loadAncestorSignals(): Promise<AncestorChangeSignal[]> {
        // `unchanged` ⇒ currentSha === verifiedSha ⇒ promptness none (clears the marker).
        const currentSha = unchanged ? "sha-old" : pendingSha.value;
        return [{ ancestorSpecId: "spec_a", verifiedSha: "sha-old", currentSha, openFindingMaxSeverity: "P2" }];
      },
    };
    const coord = new PercolatingCoordinator({
      readModel,
      kickOff: unusedKickOff,
      settler: noopSettler,
      events: emitter,
    });

    // Deferred — emits once.
    await coord.percolate(PROJECT);
    expect(emitter.deferred).toHaveLength(1);

    // The change settles to unchanged (the marker is cleared on this non-deferred outcome).
    unchanged = true;
    const settled = await coord.percolate(PROJECT);
    expect(settled.unchanged).toEqual(["spec_b"]);
    expect(emitter.deferred).toHaveLength(1);

    // A later NEW lazy change re-enters the deferred state — re-emits once (not suppressed by a
    // stale marker), even though the pending SHA equals the earlier one.
    unchanged = false;
    await coord.percolate(PROJECT);
    expect(emitter.deferred).toHaveLength(2);
  });
});
