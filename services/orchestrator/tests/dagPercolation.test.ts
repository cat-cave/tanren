// P2c-2 (autonomy-engine.md §2c "Change-percolation — NOT discard"): the PURE
// percolation decision core (`decidePercolation`) + the PercolatingCoordinator,
// driven through in-memory seams (TEST FIXTURES — they live here, never src/).
//
// Proves the §2c semantics + the three CRITICAL invariants:
//   - ancestor head-SHA DIVERGENCE is detected (a changed SHA → a percolation);
//   - P0/P1/changes-requested → IMMEDIATE percolation; P2/P3 → DEFERRED (lazy);
//   - a clean re-gate ABSORBS the upstream change keeping the dependent's work;
//   - a break invokes the resolver + re-gate (viaResolver), still absorbed;
//   - an irreconcilable percolation routes the dependent BACK TO THE PLANNER WITH
//     the change as context (NOT discarded, NOT merged) → percolation_replan;
//   - the absorbed delta then percolates to the next dependent in the chain;
//   - a NO-OP (same SHA, no request) does NOT re-trigger (TERMINATION);
//   - an ancestor-vs-ancestor conflict on the rebuild HOLDS (retried), not dropped.

import { describe, expect, it } from "vitest";
import {
  decidePercolation,
  type AncestorChangeSignal,
  type PercolationDecision,
  type PercolationEventEmitter,
  type PercolationOperation,
  type PercolationOutcome,
  type PercolationReadModel,
  type SpeculativeDependent,
} from "../src/engine/contracts/changePercolation.js";
import { PercolatingCoordinator } from "../src/engine/dag/percolation.js";

const PROJECT = "project_percolation";

function signal(over: Partial<AncestorChangeSignal> & { ancestorSpecId: string }): AncestorChangeSignal {
  return {
    integratedSha: "sha-old",
    currentSha: "sha-old",
    openFindingMaxSeverity: "none",
    ...over,
  };
}

describe("decidePercolation (pure §2c detect + severity gate + termination)", () => {
  it("same SHA + no changes-requested ⇒ NONE (the termination key — a no-op never re-triggers)", () => {
    const d = decidePercolation(
      signal({ ancestorSpecId: "spec_a", currentSha: "sha-old", openFindingMaxSeverity: "P0" }),
    );
    // Even a P0 finding does not re-trigger when the SHA is unchanged AND there is
    // no review request — there is nothing newly diverged to percolate.
    expect(d.promptness).toBe("none");
  });

  it("a P0 finding on a diverged ancestor ⇒ IMMEDIATE", () => {
    const d = decidePercolation(
      signal({ ancestorSpecId: "spec_a", currentSha: "sha-new", openFindingMaxSeverity: "P0" }),
    );
    expect(d.promptness).toBe("immediate");
    expect(d.immediateSeverity).toBe("P0");
  });

  it("a P1 finding on a diverged ancestor ⇒ IMMEDIATE", () => {
    const d = decidePercolation(
      signal({ ancestorSpecId: "spec_a", currentSha: "sha-new", openFindingMaxSeverity: "P1" }),
    );
    expect(d.promptness).toBe("immediate");
    expect(d.immediateSeverity).toBe("P1");
  });

  it("changes-requested ⇒ IMMEDIATE even when the SHA is unchanged (the reviewer's request must be absorbed)", () => {
    const d = decidePercolation(
      signal({ ancestorSpecId: "spec_a", currentSha: "sha-old", reviewVerdict: "changes_requested" }),
    );
    expect(d.promptness).toBe("immediate");
    expect(d.immediateSeverity).toBe("changes_requested");
  });

  it("a P2 change on a diverged ancestor ⇒ LAZY (deferred to the next rebase)", () => {
    const d = decidePercolation(
      signal({ ancestorSpecId: "spec_a", currentSha: "sha-new", openFindingMaxSeverity: "P2" }),
    );
    expect(d.promptness).toBe("lazy");
    expect(d.lazySeverity).toBe("P2");
  });

  it("a clean (none) divergence ⇒ LAZY P3 (a real change, non-blocking, folded in next rebase)", () => {
    const d = decidePercolation(
      signal({ ancestorSpecId: "spec_a", currentSha: "sha-new", openFindingMaxSeverity: "none" }),
    );
    expect(d.promptness).toBe("lazy");
    expect(d.lazySeverity).toBe("P3");
  });
});

// ---- In-memory coordinator seams (fixtures) -------------------------------

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

class RecordingEmitter implements PercolationEventEmitter {
  readonly percolating: Array<{ specId: string; ancestorSpecId: string; severity: string }> = [];
  readonly percolated: Array<{ specId: string; integratedAncestorSha: string; viaResolver: boolean }> = [];
  readonly deferred: Array<{ specId: string; severity: string }> = [];
  readonly replan: Array<{ specId: string; reason: string }> = [];
  async emitPercolating(i: { specId: string; ancestorSpecId: string; severity: string }): Promise<void> {
    this.percolating.push({ specId: i.specId, ancestorSpecId: i.ancestorSpecId, severity: i.severity });
  }
  async emitPercolated(i: { specId: string; integratedAncestorSha: string; viaResolver: boolean }): Promise<void> {
    this.percolated.push({
      specId: i.specId,
      integratedAncestorSha: i.integratedAncestorSha,
      viaResolver: i.viaResolver,
    });
  }
  async emitPercolationDeferred(i: { specId: string; severity: string }): Promise<void> {
    this.deferred.push({ specId: i.specId, severity: i.severity });
  }
  async emitPercolationReplan(i: { specId: string; reason: string }): Promise<void> {
    this.replan.push({ specId: i.specId, reason: i.reason });
  }
}

class ScriptedOperation implements PercolationOperation {
  readonly calls: Array<{ specId: string; ancestorSpecId: string; toSha: string }> = [];
  constructor(private readonly outcome: (d: PercolationDecision) => PercolationOutcome) {}
  async percolate(input: {
    dependent: SpeculativeDependent;
    decision: PercolationDecision;
  }): Promise<PercolationOutcome> {
    this.calls.push({
      specId: input.dependent.specId,
      ancestorSpecId: input.decision.ancestorSpecId,
      toSha: input.decision.toSha,
    });
    return this.outcome(input.decision);
  }
}

function dependent(specId: string, shas: Record<string, string>): SpeculativeDependent {
  return { specId, runId: `run_${specId}`, speculativeBase: `tanren/integ/${specId}`, integratedAncestorShas: shas };
}

describe("PercolatingCoordinator (§2c chain re-integration, NOT discard)", () => {
  it("a diverged ancestor with a P0 finding ⇒ percolating + absorbed (work kept, re-gated)", async () => {
    const emitter = new RecordingEmitter();
    const op = new ScriptedOperation((d) => ({
      result: "absorbed",
      ancestorSpecId: d.ancestorSpecId,
      newIntegratedSha: d.toSha,
      viaResolver: false,
    }));
    const coord = new PercolatingCoordinator({
      readModel: new FixedReadModel([dependent("spec_b", { spec_a: "sha-old" })], {
        spec_b: [signal({ ancestorSpecId: "spec_a", currentSha: "sha-new", openFindingMaxSeverity: "P0" })],
      }),
      operation: op,
      events: emitter,
    });
    const result = await coord.percolate(PROJECT);

    expect(result.absorbed).toEqual(["spec_b"]);
    expect(emitter.percolating).toEqual([{ specId: "spec_b", ancestorSpecId: "spec_a", severity: "P0" }]);
    expect(emitter.percolated).toEqual([{ specId: "spec_b", integratedAncestorSha: "sha-new", viaResolver: false }]);
    expect(op.calls).toEqual([{ specId: "spec_b", ancestorSpecId: "spec_a", toSha: "sha-new" }]);
  });

  it("a break reconciled by the resolver ⇒ absorbed with viaResolver=true (work kept intact)", async () => {
    const emitter = new RecordingEmitter();
    const op = new ScriptedOperation((d) => ({
      result: "absorbed",
      ancestorSpecId: d.ancestorSpecId,
      newIntegratedSha: d.toSha,
      viaResolver: true,
    }));
    const coord = new PercolatingCoordinator({
      readModel: new FixedReadModel([dependent("spec_b", { spec_a: "sha-old" })], {
        spec_b: [signal({ ancestorSpecId: "spec_a", currentSha: "sha-new", reviewVerdict: "changes_requested" })],
      }),
      operation: op,
      events: emitter,
    });
    const result = await coord.percolate(PROJECT);

    expect(result.absorbed).toEqual(["spec_b"]);
    expect(emitter.percolating[0]?.severity).toBe("changes_requested");
    expect(emitter.percolated[0]?.viaResolver).toBe(true);
  });

  it("an irreconcilable percolation routes BACK TO THE PLANNER (NOT discarded, NOT merged)", async () => {
    const emitter = new RecordingEmitter();
    const op = new ScriptedOperation((d) => ({
      result: "replanned",
      ancestorSpecId: d.ancestorSpecId,
      viaResolver: true,
      reason: "intents irreconcilable",
    }));
    const coord = new PercolatingCoordinator({
      readModel: new FixedReadModel([dependent("spec_b", { spec_a: "sha-old" })], {
        spec_b: [signal({ ancestorSpecId: "spec_a", currentSha: "sha-new", openFindingMaxSeverity: "P1" })],
      }),
      operation: op,
      events: emitter,
    });
    const result = await coord.percolate(PROJECT);

    expect(result.replanned).toEqual(["spec_b"]);
    expect(result.absorbed).toEqual([]);
    // Never absorbed — an irreconcilable percolation is routed back, not merged.
    expect(emitter.percolated).toEqual([]);
    expect(emitter.replan).toEqual([{ specId: "spec_b", reason: "intents irreconcilable" }]);
  });

  it("a P2/P3 change is DEFERRED (lazy) — emitted as percolation_deferred, never percolated now", async () => {
    const emitter = new RecordingEmitter();
    const op = new ScriptedOperation(() => {
      throw new Error("operation must NOT run for a lazy change");
    });
    const coord = new PercolatingCoordinator({
      readModel: new FixedReadModel([dependent("spec_b", { spec_a: "sha-old" })], {
        spec_b: [signal({ ancestorSpecId: "spec_a", currentSha: "sha-new", openFindingMaxSeverity: "P2" })],
      }),
      operation: op,
      events: emitter,
    });
    const result = await coord.percolate(PROJECT);

    expect(result.deferred).toEqual(["spec_b"]);
    expect(emitter.deferred).toEqual([{ specId: "spec_b", severity: "P2" }]);
    expect(op.calls).toEqual([]);
  });

  it("a NO-OP (same SHA, no request) does NOT re-trigger — TERMINATION", async () => {
    const emitter = new RecordingEmitter();
    const op = new ScriptedOperation(() => {
      throw new Error("operation must NOT run when nothing diverged");
    });
    const coord = new PercolatingCoordinator({
      readModel: new FixedReadModel([dependent("spec_b", { spec_a: "sha-old" })], {
        spec_b: [signal({ ancestorSpecId: "spec_a", currentSha: "sha-old", openFindingMaxSeverity: "P0" })],
      }),
      operation: op,
      events: emitter,
    });
    const result = await coord.percolate(PROJECT);

    expect(result.unchanged).toEqual(["spec_b"]);
    expect(emitter.percolating).toEqual([]);
    expect(emitter.deferred).toEqual([]);
    expect(op.calls).toEqual([]);
  });

  it("an ancestor-vs-ancestor conflict on the rebuild HOLDS the dependent (retried; NOT dropped)", async () => {
    const emitter = new RecordingEmitter();
    const op = new ScriptedOperation((d) => ({
      result: "held",
      ancestorSpecId: d.ancestorSpecId,
      viaResolver: false,
      reason: "ancestors conflict",
    }));
    const coord = new PercolatingCoordinator({
      readModel: new FixedReadModel([dependent("spec_c", { spec_a: "sha-old", spec_b: "sha-old" })], {
        spec_c: [signal({ ancestorSpecId: "spec_a", currentSha: "sha-new", openFindingMaxSeverity: "P0" })],
      }),
      operation: op,
      events: emitter,
    });
    const result = await coord.percolate(PROJECT);

    expect(result.held).toEqual(["spec_c"]);
    expect(result.absorbed).toEqual([]);
    // Never merged/absorbed on a held conflict (retried next pass).
    expect(emitter.percolated).toEqual([]);
  });

  it("the chain percolates: A→B absorbed, then B's delta percolates into C (both in one pass)", async () => {
    const emitter = new RecordingEmitter();
    // Both B (on A) and C (on B) see a diverged ancestor with a blocking finding;
    // the operation absorbs both, recording the new SHA on each — the chain
    // re-integration of §2c (B absorbs A; C absorbs B).
    const op = new ScriptedOperation((d) => ({
      result: "absorbed",
      ancestorSpecId: d.ancestorSpecId,
      newIntegratedSha: d.toSha,
      viaResolver: false,
    }));
    const coord = new PercolatingCoordinator({
      readModel: new FixedReadModel(
        [dependent("spec_b", { spec_a: "sha-a-old" }), dependent("spec_c", { spec_b: "sha-b-old" })],
        {
          spec_b: [signal({ ancestorSpecId: "spec_a", currentSha: "sha-a-new", openFindingMaxSeverity: "P1" })],
          spec_c: [signal({ ancestorSpecId: "spec_b", currentSha: "sha-b-new", openFindingMaxSeverity: "P1" })],
        },
      ),
      operation: op,
      events: emitter,
    });
    const result = await coord.percolate(PROJECT);

    expect(result.absorbed.sort()).toEqual(["spec_b", "spec_c"]);
    // C absorbed B's delta (its ancestor SHA advanced) — the chain propagated.
    expect(emitter.percolated.map((p) => p.specId).sort()).toEqual(["spec_b", "spec_c"]);
    expect(op.calls.find((c) => c.specId === "spec_c")?.ancestorSpecId).toBe("spec_b");
  });
});
