// P2c-2 percolation kick-off TOLERANCE (the apex v18 fix): the PercolatingCoordinator
// must SKIP — not abort on — a candidate that became TERMINAL (merged/done) between the
// load and the re-execution kick-off. The re-exec reopens the spec to `pending` (a no-op
// once merged/done) then claims it, and the claim raises SpecNotRunnableError on a
// non-`pending` spec. A merged spec is never a percolation dependent (its re-base is
// moot), so the pass logs + records the skip and CONTINUES processing the OTHER
// dependents — one un-re-executable candidate never strands the whole percolation pass.
// Every OTHER error still propagates loudly (no silent fallback). Driven through
// in-memory seams (test fixtures — they live here, never in src/).

import { describe, expect, it } from "vitest";
import {
  type AncestorChangeSignal,
  type PercolationDecision,
  type PercolationEventEmitter,
  type PercolationKickOff,
  type PercolationKickOffOutcome,
  type PercolationReadModel,
  type PercolationSettler,
  type SpeculativeDependent,
} from "../src/engine/contracts/changePercolation.js";
import { PercolatingCoordinator } from "../src/engine/dag/percolation.js";
import { SpecNotRunnableError } from "../src/engine/workflow/projectSpecErrors.js";

const PROJECT = "project_percolation_tolerance";

function signal(over: Partial<AncestorChangeSignal> & { ancestorSpecId: string }): AncestorChangeSignal {
  return { verifiedSha: "sha-old", currentSha: "sha-old", openFindingMaxSeverity: "none", ...over };
}

function dependent(specId: string): SpeculativeDependent {
  return {
    specId,
    runId: `run_${specId}`,
    speculativeBase: `tanren/integ/${specId}`,
    integratedAncestorShas: { spec_a: "sha-old" },
    verifiedAncestorShas: { spec_a: "sha-old" },
    lifecycleState: "building",
    openFindingMaxSeverity: "unaudited",
  };
}

class FixedReadModel implements PercolationReadModel {
  constructor(
    private readonly dependents: SpeculativeDependent[],
    private readonly signalsByDependent: Record<string, AncestorChangeSignal[]>,
  ) {}
  async loadSpeculativeDependents(): Promise<SpeculativeDependent[]> {
    return this.dependents.map((d) => ({ ...d }));
  }
  async loadAncestorSignals(input: { dependent: SpeculativeDependent }): Promise<AncestorChangeSignal[]> {
    return this.signalsByDependent[input.dependent.specId] ?? [];
  }
}

class NoopEmitter implements PercolationEventEmitter {
  async emitPercolating(): Promise<void> {}
  async emitPercolated(): Promise<void> {}
  async emitPercolationDeferred(): Promise<void> {}
  async emitPercolationReplan(): Promise<void> {}
}

class NoopSettler implements PercolationSettler {
  async absorb(): Promise<void> {}
  async replan(): Promise<void> {}
}

/** A kick-off whose per-dependent outcome (or throw) the test controls. */
class KickOff implements PercolationKickOff {
  readonly calls: string[] = [];
  constructor(
    private readonly behavior: (
      dependent: SpeculativeDependent,
      decision: PercolationDecision,
    ) => PercolationKickOffOutcome,
  ) {}
  async kickOff(input: {
    dependent: SpeculativeDependent;
    decision: PercolationDecision;
    mergedAncestorSpecIds: ReadonlyArray<string>;
  }): Promise<PercolationKickOffOutcome> {
    this.calls.push(input.dependent.specId);
    return this.behavior(input.dependent, input.decision);
  }
}

describe("PercolatingCoordinator — kick-off tolerance (terminal-between-load-and-reexec)", () => {
  it("SKIPS a candidate that became merged between load and kick-off, the pass CONTINUES (other dependents processed)", async () => {
    // spec_b's re-exec raises SpecNotRunnableError (it merged between load + claim);
    // spec_c is a healthy immediate change. The pass must skip spec_b benignly and
    // STILL re-execute spec_c — one un-re-executable candidate never aborts the pass.
    const kickOff = new KickOff((dep, decision) => {
      if (dep.specId === "spec_b") throw new SpecNotRunnableError("spec_b", "merged");
      return { result: "reexecuting", ancestorSpecId: decision.ancestorSpecId, reexecRunId: "run_re" };
    });
    const coord = new PercolatingCoordinator({
      readModel: new FixedReadModel([dependent("spec_b"), dependent("spec_c")], {
        spec_b: [signal({ ancestorSpecId: "spec_a", currentSha: "sha-new", openFindingMaxSeverity: "P0" })],
        spec_c: [signal({ ancestorSpecId: "spec_a", currentSha: "sha-new", openFindingMaxSeverity: "P0" })],
      }),
      kickOff,
      settler: new NoopSettler(),
      events: new NoopEmitter(),
    });

    const result = await coord.percolate(PROJECT);

    expect(result.skipped).toEqual(["spec_b"]);
    expect(result.reexecuting).toEqual(["spec_c"]);
    // BOTH candidates were attempted (the pass did not abort after spec_b's skip).
    expect(kickOff.calls).toEqual(["spec_b", "spec_c"]);
  });

  it("a NON-SpecNotRunnable error from the kick-off STILL propagates (no silent fallback)", async () => {
    const coord = new PercolatingCoordinator({
      readModel: new FixedReadModel([dependent("spec_b")], {
        spec_b: [signal({ ancestorSpecId: "spec_a", currentSha: "sha-new", openFindingMaxSeverity: "P0" })],
      }),
      kickOff: new KickOff(() => {
        throw new Error("unexpected fault");
      }),
      settler: new NoopSettler(),
      events: new NoopEmitter(),
    });

    await expect(coord.percolate(PROJECT)).rejects.toThrow("unexpected fault");
  });
});
