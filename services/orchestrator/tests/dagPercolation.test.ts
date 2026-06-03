// P2c-2 (autonomy-engine.md §2c "Change-percolation — NOT discard"): the PURE cores
// (`decidePercolation` detect + `decideSettle`) + the two-phase PercolatingCoordinator,
// driven through in-memory seams (TEST FIXTURES — they live here, never src/). Proves
// the §2c semantics + CRITICAL invariants: SHA-divergence vs. the VERIFIED sha →
// IMMEDIATE (P0/P1/changes-requested + the new ancestor_merged axis) / DEFERRED (P2/P3);
// absorption advances the verified SHA ONLY on SETTLE after a CLEAN re-gate (never on a
// bare re-base); an irreconcilable re-exec → replan (kept alive); a no-op / sticky-
// absorbed verdict TERMINATES (no re-trigger); an ancestor-vs-ancestor rebuild conflict
// HOLDS (retried), not dropped.

import { describe, expect, it } from "vitest";
import {
  decidePercolation,
  decideSettle,
  type AncestorChangeSignal,
  type PercolationDecision,
  type PercolationEventEmitter,
  type PercolationKickOff,
  type PercolationKickOffOutcome,
  type PercolationPending,
  type PercolationReadModel,
  type PercolationSettler,
  type SpeculativeDependent,
} from "../src/engine/contracts/changePercolation.js";
import type { OpenFindingSeverity, SpecLifecycleState } from "../src/engine/contracts/dagLifecycle.js";
import { PercolatingCoordinator } from "../src/engine/dag/percolation.js";

const PROJECT = "project_percolation";

function signal(over: Partial<AncestorChangeSignal> & { ancestorSpecId: string }): AncestorChangeSignal {
  return { verifiedSha: "sha-old", currentSha: "sha-old", openFindingMaxSeverity: "none", ...over };
}

describe("decidePercolation (pure §2c detect + severity gate + termination)", () => {
  it("verified SHA matches + no un-absorbed request ⇒ NONE (termination)", () => {
    const d = decidePercolation(
      signal({ ancestorSpecId: "spec_a", currentSha: "sha-old", openFindingMaxSeverity: "P0" }),
    );
    expect(d.promptness).toBe("none");
  });

  it("a P0 finding on a SHA that diverged from the VERIFIED sha ⇒ IMMEDIATE", () => {
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

  it("a NEW changes-requested (unchanged SHA, not yet absorbed) ⇒ IMMEDIATE", () => {
    const d = decidePercolation(
      signal({ ancestorSpecId: "spec_a", currentSha: "sha-old", reviewVerdict: "changes_requested" }),
    );
    expect(d.promptness).toBe("immediate");
    expect(d.immediateSeverity).toBe("changes_requested");
  });

  it("a STICKY changes-requested ALREADY absorbed at the same SHA ⇒ NONE (loop guard)", () => {
    const d = decidePercolation(
      signal({
        ancestorSpecId: "spec_a",
        currentSha: "sha-old",
        reviewVerdict: "changes_requested",
        absorbedReviewVerdict: "changes_requested",
      }),
    );
    expect(d.promptness).toBe("none");
  });

  it("a P2 change on a diverged ancestor ⇒ LAZY", () => {
    const d = decidePercolation(
      signal({ ancestorSpecId: "spec_a", currentSha: "sha-new", openFindingMaxSeverity: "P2" }),
    );
    expect(d.promptness).toBe("lazy");
    expect(d.lazySeverity).toBe("P2");
  });

  it("a clean (none) divergence ⇒ LAZY P3", () => {
    const d = decidePercolation(
      signal({ ancestorSpecId: "spec_a", currentSha: "sha-new", openFindingMaxSeverity: "none" }),
    );
    expect(d.promptness).toBe("lazy");
    expect(d.lazySeverity).toBe("P3");
  });

  it("a MERGED ancestor whose mergedSha ≠ verified ⇒ IMMEDIATE/ancestor_merged (the new axis)", () => {
    // The run branch is UNCHANGED (a squash-merge leaves it put) — only the merge axis
    // (rule 0, off default_branch head) catches it; the toSha is the merge commit.
    const d = decidePercolation(
      signal({
        ancestorSpecId: "spec_a",
        verifiedSha: "sha-old",
        currentSha: "main-merge-sha",
        ancestorMerged: true,
        mergedSha: "main-merge-sha",
      }),
    );
    expect(d.promptness).toBe("immediate");
    expect(d.immediateSeverity).toBe("ancestor_merged");
    expect(d.toSha).toBe("main-merge-sha");
  });

  it("an ALREADY-ABSORBED merged ancestor (verified == mergedSha) ⇒ NONE (no re-trigger loop)", () => {
    const d = decidePercolation(
      signal({
        ancestorSpecId: "spec_a",
        verifiedSha: "main-merge-sha",
        currentSha: "main-merge-sha",
        ancestorMerged: true,
        mergedSha: "main-merge-sha",
      }),
    );
    expect(d.promptness).toBe("none");
  });

  it("ancestor_merged PRECEDES the SHA-advance rules (a merge with an open P0 still labels ancestor_merged)", () => {
    const d = decidePercolation(
      signal({
        ancestorSpecId: "spec_a",
        verifiedSha: "sha-old",
        currentSha: "main-merge-sha",
        ancestorMerged: true,
        mergedSha: "main-merge-sha",
        openFindingMaxSeverity: "P0",
      }),
    );
    expect(d.promptness).toBe("immediate");
    expect(d.immediateSeverity).toBe("ancestor_merged");
  });
});

describe("decideSettle (pure §2c re-gate verdict — absorbed only after a clean run)", () => {
  const cases: Array<[SpecLifecycleState, OpenFindingSeverity, "absorbed" | "replanned" | "in_flight"]> = [
    ["building", "unaudited", "in_flight"],
    ["pr_open", "unaudited", "in_flight"],
    ["ci_green", "unaudited", "in_flight"],
    ["audited", "none", "absorbed"],
    ["audited", "P2", "absorbed"],
    ["review", "none", "absorbed"],
    ["merged", "none", "absorbed"],
    ["audited", "P0", "replanned"],
    ["audited", "P1", "replanned"],
    ["blocked", "unaudited", "replanned"],
  ];
  it.each(cases)("re-exec %s / %s ⇒ %s", (state, severity, expected) => {
    expect(decideSettle(state, severity)).toBe(expected);
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
  readonly percolated: Array<{ specId: string; integratedAncestorSha: string }> = [];
  readonly deferred: Array<{ specId: string; severity: string }> = [];
  readonly replan: Array<{ specId: string; reason: string }> = [];
  async emitPercolating(i: { specId: string; ancestorSpecId: string; severity: string }): Promise<void> {
    this.percolating.push({ specId: i.specId, ancestorSpecId: i.ancestorSpecId, severity: i.severity });
  }
  async emitPercolated(i: { specId: string; integratedAncestorSha: string }): Promise<void> {
    this.percolated.push({ specId: i.specId, integratedAncestorSha: i.integratedAncestorSha });
  }
  async emitPercolationDeferred(i: { specId: string; severity: string }): Promise<void> {
    this.deferred.push({ specId: i.specId, severity: i.severity });
  }
  async emitPercolationReplan(i: { specId: string; reason: string }): Promise<void> {
    this.replan.push({ specId: i.specId, reason: i.reason });
  }
}

class RecordingKickOff implements PercolationKickOff {
  readonly calls: Array<{
    specId: string;
    ancestorSpecId: string;
    toSha: string;
    mergedAncestorSpecIds: ReadonlyArray<string>;
  }> = [];
  constructor(private readonly outcome: (d: PercolationDecision) => PercolationKickOffOutcome) {}
  async kickOff(input: {
    dependent: SpeculativeDependent;
    decision: PercolationDecision;
    mergedAncestorSpecIds: ReadonlyArray<string>;
  }): Promise<PercolationKickOffOutcome> {
    this.calls.push({
      specId: input.dependent.specId,
      ancestorSpecId: input.decision.ancestorSpecId,
      toSha: input.decision.toSha,
      mergedAncestorSpecIds: input.mergedAncestorSpecIds,
    });
    return this.outcome(input.decision);
  }
}

class RecordingSettler implements PercolationSettler {
  readonly absorbed: Array<{ specId: string; ancestorSpecId: string; sha: string }> = [];
  readonly replanned: Array<{ specId: string; ancestorSpecId: string }> = [];
  async absorb(input: { dependent: SpeculativeDependent; pending: PercolationPending }): Promise<void> {
    this.absorbed.push({
      specId: input.dependent.specId,
      ancestorSpecId: input.pending.ancestorSpecId,
      sha: input.pending.toSha,
    });
  }
  async replan(input: { dependent: SpeculativeDependent; pending: PercolationPending }): Promise<void> {
    this.replanned.push({ specId: input.dependent.specId, ancestorSpecId: input.pending.ancestorSpecId });
  }
}

function dependent(specId: string, over: Partial<SpeculativeDependent> = {}): SpeculativeDependent {
  return {
    specId,
    runId: `run_${specId}`,
    speculativeBase: `tanren/integ/${specId}`,
    integratedAncestorShas: { spec_a: "sha-old" },
    verifiedAncestorShas: { spec_a: "sha-old" },
    lifecycleState: "building",
    openFindingMaxSeverity: "unaudited",
    ...over,
  };
}

function pendingMarker(over: Partial<PercolationPending> = {}): PercolationPending {
  return { ancestorSpecId: "spec_a", toSha: "sha-new", reexecRunId: "run_reexec", ...over };
}

describe("PercolatingCoordinator (§2c two-phase chain re-integration, NOT discard)", () => {
  it("an IMMEDIATE change KICKS OFF a re-execution (reexecuting) — NOT absorbed on re-base", async () => {
    const emitter = new RecordingEmitter();
    const settler = new RecordingSettler();
    const kickOff = new RecordingKickOff((d) => ({
      result: "reexecuting",
      ancestorSpecId: d.ancestorSpecId,
      reexecRunId: "run_re",
    }));
    const coord = new PercolatingCoordinator({
      readModel: new FixedReadModel([dependent("spec_b")], {
        spec_b: [signal({ ancestorSpecId: "spec_a", currentSha: "sha-new", openFindingMaxSeverity: "P0" })],
      }),
      kickOff,
      settler,
      events: emitter,
    });
    const result = await coord.percolate(PROJECT);

    expect(result.reexecuting).toEqual(["spec_b"]);
    expect(emitter.percolating).toEqual([{ specId: "spec_b", ancestorSpecId: "spec_a", severity: "P0" }]);
    // NOT absorbed/percolated on the kick-off — the re-gate has not run yet.
    expect(emitter.percolated).toEqual([]);
    expect(settler.absorbed).toEqual([]);
    expect(kickOff.calls).toEqual([
      { specId: "spec_b", ancestorSpecId: "spec_a", toSha: "sha-new", mergedAncestorSpecIds: [] },
    ]);
  });

  it("a MERGED ancestor kicks off with the ancestor in mergedAncestorSpecIds (the drop set) + ancestor_merged", async () => {
    const emitter = new RecordingEmitter();
    const kickOff = new RecordingKickOff((d) => ({
      result: "reexecuting",
      ancestorSpecId: d.ancestorSpecId,
      reexecRunId: "run_re",
    }));
    const coord = new PercolatingCoordinator({
      readModel: new FixedReadModel([dependent("spec_b")], {
        spec_b: [
          signal({
            ancestorSpecId: "spec_a",
            verifiedSha: "sha-old",
            currentSha: "main-merge-sha",
            ancestorMerged: true,
            mergedSha: "main-merge-sha",
          }),
        ],
      }),
      kickOff,
      settler: new RecordingSettler(),
      events: emitter,
    });
    const result = await coord.percolate(PROJECT);

    expect(result.reexecuting).toEqual(["spec_b"]);
    expect(emitter.percolating).toEqual([{ specId: "spec_b", ancestorSpecId: "spec_a", severity: "ancestor_merged" }]);
    // The merged ancestor is in the DROP set + the toSha is the merge commit.
    expect(kickOff.calls).toEqual([
      { specId: "spec_b", ancestorSpecId: "spec_a", toSha: "main-merge-sha", mergedAncestorSpecIds: ["spec_a"] },
    ]);
  });

  it("a mixed merged+unmerged set drops ONLY the merged ancestor from the speculative stack", async () => {
    const emitter = new RecordingEmitter();
    const kickOff = new RecordingKickOff((d) => ({
      result: "reexecuting",
      ancestorSpecId: d.ancestorSpecId,
      reexecRunId: "run_re",
    }));
    const coord = new PercolatingCoordinator({
      readModel: new FixedReadModel(
        [dependent("spec_c", { integratedAncestorShas: { spec_a: "sha-old", spec_b: "sha-old" } })],
        {
          // spec_a MERGED (drops); spec_b unmerged + diverged (stays stacked).
          spec_c: [
            signal({
              ancestorSpecId: "spec_a",
              verifiedSha: "sha-old",
              currentSha: "main-merge-sha",
              ancestorMerged: true,
              mergedSha: "main-merge-sha",
            }),
            signal({ ancestorSpecId: "spec_b", currentSha: "sha-new", openFindingMaxSeverity: "P1" }),
          ],
        },
      ),
      kickOff,
      settler: new RecordingSettler(),
      events: emitter,
    });
    const result = await coord.percolate(PROJECT);

    expect(result.reexecuting).toEqual(["spec_c"]);
    // ONLY the merged ancestor is in the drop set; the unmerged one stays stacked.
    expect(kickOff.calls).toHaveLength(1);
    expect(kickOff.calls[0]?.mergedAncestorSpecIds).toEqual(["spec_a"]);
  });

  it("SETTLE: an in-flight marker whose re-exec re-gated CLEAN ⇒ absorbed + percolated", async () => {
    const emitter = new RecordingEmitter();
    const settler = new RecordingSettler();
    const coord = new PercolatingCoordinator({
      readModel: new FixedReadModel(
        [dependent("spec_b", { pending: pendingMarker(), lifecycleState: "audited", openFindingMaxSeverity: "none" })],
        {},
      ),
      kickOff: new RecordingKickOff(() => {
        throw new Error("must NOT kick off while a marker is in flight");
      }),
      settler,
      events: emitter,
    });
    const result = await coord.percolate(PROJECT);

    expect(result.absorbed).toEqual(["spec_b"]);
    expect(settler.absorbed).toEqual([{ specId: "spec_b", ancestorSpecId: "spec_a", sha: "sha-new" }]);
    expect(emitter.percolated).toEqual([{ specId: "spec_b", integratedAncestorSha: "sha-new" }]);
  });

  it("SETTLE: an in-flight marker whose re-exec is still BUILDING ⇒ in-flight, no re-emit (loop guard)", async () => {
    const emitter = new RecordingEmitter();
    const settler = new RecordingSettler();
    const coord = new PercolatingCoordinator({
      readModel: new FixedReadModel(
        [
          dependent("spec_b", {
            pending: pendingMarker(),
            lifecycleState: "building",
            openFindingMaxSeverity: "unaudited",
          }),
        ],
        {},
      ),
      kickOff: new RecordingKickOff(() => {
        throw new Error("must NOT kick off while building");
      }),
      settler,
      events: emitter,
    });
    const result = await coord.percolate(PROJECT);

    expect(result.inFlight).toEqual(["spec_b"]);
    expect(emitter.percolating).toEqual([]);
    expect(emitter.percolated).toEqual([]);
    expect(settler.absorbed).toEqual([]);
    expect(settler.replanned).toEqual([]);
  });

  it("SETTLE: a re-exec that halted / kept an open P0 ⇒ REPLAN (routed back, NOT dropped/merged)", async () => {
    const emitter = new RecordingEmitter();
    const settler = new RecordingSettler();
    const coord = new PercolatingCoordinator({
      readModel: new FixedReadModel(
        [dependent("spec_b", { pending: pendingMarker(), lifecycleState: "blocked", openFindingMaxSeverity: "P0" })],
        {},
      ),
      kickOff: new RecordingKickOff(() => {
        throw new Error("must NOT kick off");
      }),
      settler,
      events: emitter,
    });
    const result = await coord.percolate(PROJECT);

    expect(result.replanned).toEqual(["spec_b"]);
    expect(settler.replanned).toEqual([{ specId: "spec_b", ancestorSpecId: "spec_a" }]);
    expect(emitter.replan.map((r) => r.specId)).toEqual(["spec_b"]);
    // Never absorbed — a replanned percolation routes back, it does not merge.
    expect(emitter.percolated).toEqual([]);
  });

  it("a P2/P3 change is DEFERRED (lazy), no kick-off", async () => {
    const emitter = new RecordingEmitter();
    const coord = new PercolatingCoordinator({
      readModel: new FixedReadModel([dependent("spec_b")], {
        spec_b: [signal({ ancestorSpecId: "spec_a", currentSha: "sha-new", openFindingMaxSeverity: "P2" })],
      }),
      kickOff: new RecordingKickOff(() => {
        throw new Error("must NOT kick off for a lazy change");
      }),
      settler: new RecordingSettler(),
      events: emitter,
    });
    const result = await coord.percolate(PROJECT);

    expect(result.deferred).toEqual(["spec_b"]);
    expect(emitter.deferred).toEqual([{ specId: "spec_b", severity: "P2" }]);
  });

  it("a NO-OP (verified SHA matches, no un-absorbed request) does NOT re-trigger — TERMINATION", async () => {
    const emitter = new RecordingEmitter();
    const coord = new PercolatingCoordinator({
      readModel: new FixedReadModel([dependent("spec_b")], {
        spec_b: [signal({ ancestorSpecId: "spec_a", currentSha: "sha-old", openFindingMaxSeverity: "P0" })],
      }),
      kickOff: new RecordingKickOff(() => {
        throw new Error("must NOT kick off when nothing diverged");
      }),
      settler: new RecordingSettler(),
      events: emitter,
    });
    const result = await coord.percolate(PROJECT);

    expect(result.unchanged).toEqual(["spec_b"]);
    expect(emitter.percolating).toEqual([]);
  });

  it("a STICKY changes_requested already absorbed at the verified SHA does NOT re-fire", async () => {
    const emitter = new RecordingEmitter();
    const coord = new PercolatingCoordinator({
      readModel: new FixedReadModel([dependent("spec_b")], {
        spec_b: [
          signal({
            ancestorSpecId: "spec_a",
            currentSha: "sha-old",
            reviewVerdict: "changes_requested",
            absorbedReviewVerdict: "changes_requested",
          }),
        ],
      }),
      kickOff: new RecordingKickOff(() => {
        throw new Error("must NOT re-kick a sticky absorbed verdict");
      }),
      settler: new RecordingSettler(),
      events: emitter,
    });
    const result = await coord.percolate(PROJECT);

    expect(result.unchanged).toEqual(["spec_b"]);
    expect(emitter.percolating).toEqual([]);
    expect(emitter.percolated).toEqual([]);
  });

  it("an ancestor-vs-ancestor conflict on the rebuild HOLDS (retried; NOT dropped)", async () => {
    const emitter = new RecordingEmitter();
    const coord = new PercolatingCoordinator({
      readModel: new FixedReadModel(
        [dependent("spec_c", { integratedAncestorShas: { spec_a: "sha-old", spec_b: "sha-old" } })],
        { spec_c: [signal({ ancestorSpecId: "spec_a", currentSha: "sha-new", openFindingMaxSeverity: "P0" })] },
      ),
      kickOff: new RecordingKickOff((d) => ({
        result: "held",
        ancestorSpecId: d.ancestorSpecId,
        reason: "ancestors conflict",
      })),
      settler: new RecordingSettler(),
      events: emitter,
    });
    const result = await coord.percolate(PROJECT);

    expect(result.held).toEqual(["spec_c"]);
    expect(emitter.percolated).toEqual([]);
  });
});
