// NEVER-STRAND reconciler ↔ conflict-escalation INTERPLAY (no double-handling), split
// from specStrandReconciler.test.ts to keep each file under the 500-line cap. The
// conflict-resolution sequence's terminal-state contract: a spec the merge-conflict
// path escalated to `needs_attention` is TERMINAL — the strand reconciler must never
// re-touch it (no churn against the conflict path); and a spec mid-replan (a fresh
// queued/running run owns it) is left alone. Both pinned on the pure predicate the
// reconciler is built on + the coordinator that composes it.

import { describe, expect, it } from "vitest";
import { decideStrand } from "../src/engine/contracts/specStrandReconciler.js";
import { SpecStrandReconciler } from "../src/engine/dag/specStrandReconciler.js";
import { classifySpecStatus } from "../src/engine/dag/walkerPg.js";
import { FixedReadModel, PROJECT, RecordingEmitter, RecordingWriter, snapshot } from "./helpers/specStrandFixtures.js";

describe("INTERPLAY: strand reconciler ↔ conflict escalation (no double-handling)", () => {
  it("a conflict-escalated needs_attention spec is TERMINAL — decideStrand excludes it (never re-touched)", () => {
    // The merge-conflict resolver parked this spec at `needs_attention` (the §2c
    // non-bricking escalation). classifySpecStatus → terminal_blocked, so condition 1
    // of decideStrand fails: the strand reconciler can NEVER re-enqueue or re-escalate
    // an already-parked spec (no double-handling, no churn against the conflict path).
    expect(classifySpecStatus("needs_attention")).toBe("terminal_blocked");
    const d = decideStrand(
      snapshot({
        specId: "spec_parked",
        status: "needs_attention",
        // Even with all-terminal runs (it WOULD otherwise look like a strand), the
        // terminal status alone makes it non-reconcilable.
        runs: [{ runId: "run_old", status: "cancelled" }],
      }),
    );
    expect(d.reconcilable).toBe(false);
  });

  it("a spec mid-replan (a fresh QUEUED run) is owned by that run — the reconciler leaves it", () => {
    // A conflict re-plan (or any fresh run) created a live queued run for the spec. The
    // run owns it; condition 2 (no live run) fails ⇒ not reconcilable. The reconciler
    // never yanks a spec a re-plan is actively re-running.
    const queued = decideStrand(
      snapshot({ specId: "spec_replan", status: "in_flight", runs: [{ runId: "run_replan", status: "queued" }] }),
    );
    expect(queued.reconcilable).toBe(false);
    // Same for a RUNNING re-plan run.
    const running = decideStrand(
      snapshot({ specId: "spec_replan", status: "in_flight", runs: [{ runId: "run_replan", status: "running" }] }),
    );
    expect(running.reconcilable).toBe(false);
  });

  it("the reconciler coordinator skips a needs_attention spec even if it somehow appears as a candidate", async () => {
    // Belt-and-suspenders: the pg read model only loads in_flight specs (so a parked
    // spec is never even a candidate). But if a stale snapshot surfaced one, the pure
    // predicate (condition 1) still excludes it — the coordinator does NOTHING.
    const readModel = new FixedReadModel([
      snapshot({
        specId: "spec_parked",
        status: "needs_attention",
        runs: [{ runId: "run_old", status: "cancelled" }],
      }),
    ]);
    const writer = new RecordingWriter();
    const events = new RecordingEmitter();
    const result = await new SpecStrandReconciler({ readModel, writer, events }).reconcile(PROJECT);

    expect(result.reEnqueued).toEqual([]);
    expect(result.escalated).toEqual([]);
    expect(writer.reEnqueued).toEqual([]);
    expect(writer.escalated).toEqual([]);
    expect(events.needsAttention).toEqual([]);
  });
});
