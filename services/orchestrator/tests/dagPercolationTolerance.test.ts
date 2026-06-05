// percolation kick-off TOLERANCE (the apex v18 fix): the PercolatingCoordinator
// must SKIP — not abort on — a candidate that became TERMINAL (merged/done) between the
// load and the re-execution kick-off. The re-exec reopens the spec to `pending` (a no-op
// once merged/done) then claims it, and the claim raises SpecNotRunnableError on a
// non-`pending` spec. A merged spec is never a percolation dependent (its re-base is
// moot), so the pass logs + records the skip and CONTINUES processing the OTHER
// dependents — one un-re-executable candidate never strands the whole percolation pass.
// Every OTHER error still propagates loudly (no silent fallback). Driven through
// in-memory seams (test fixtures — they live here, never in src/).

import { describe, expect, it, vi } from "vitest";
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

  it("a NON-SpecNotRunnable kick-off throw is RECORDED-AND-CONTINUED — the OTHER dependents still percolate (GAP #4)", async () => {
    // spec_b's kick-off throws a transient (non-terminal) fault; spec_c is healthy. The
    // pass must NOT abort: it records spec_b in `failed` (logged loudly — not swallowed)
    // and STILL re-executes spec_c. One dependent's failure can never starve the others.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const kickOff = new KickOff((dep, decision) => {
        if (dep.specId === "spec_b") throw new Error("transient VcsProvider fault");
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

      // spec_b recorded as failed (NOT skipped — it was not the benign terminal case),
      // spec_c STILL re-executed (the throw did not abort the pass).
      expect(result.failed).toEqual(["spec_b"]);
      expect(result.reexecuting).toEqual(["spec_c"]);
      expect(result.skipped).toEqual([]);
      expect(kickOff.calls).toEqual(["spec_b", "spec_c"]);
      // LOUD, not silent: the per-dependent failure was logged (no silent swallow).
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a throw in the SETTLE phase (PHASE 1) is also record-and-continued (GAP #4)", async () => {
    // spec_b has a pending marker (PHASE 1 settle) and its settler.absorb throws; spec_c
    // is a healthy detect. The settle-phase throw must NOT abort — spec_c still percolates.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pendingDep: SpeculativeDependent = {
        ...dependent("spec_b"),
        lifecycleState: "audited",
        openFindingMaxSeverity: "none",
        pending: { ancestorSpecId: "spec_a", toSha: "sha-new", reexecRunId: "run_re_b" },
      };
      const throwingSettler: PercolationSettler = {
        async absorb() {
          throw new Error("transient DB fault writing the absorbed sha");
        },
        async replan() {},
      };
      const kickOff = new KickOff((_, decision) => ({
        result: "reexecuting",
        ancestorSpecId: decision.ancestorSpecId,
        reexecRunId: "run_re",
      }));
      const coord = new PercolatingCoordinator({
        readModel: new FixedReadModel([pendingDep, dependent("spec_c")], {
          spec_c: [signal({ ancestorSpecId: "spec_a", currentSha: "sha-new", openFindingMaxSeverity: "P0" })],
        }),
        kickOff,
        settler: throwingSettler,
        events: new NoopEmitter(),
      });

      const result = await coord.percolate(PROJECT);

      expect(result.failed).toEqual(["spec_b"]);
      expect(result.reexecuting).toEqual(["spec_c"]);
      expect(kickOff.calls).toEqual(["spec_c"]);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
