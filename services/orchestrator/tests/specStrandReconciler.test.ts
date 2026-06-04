// NEVER-STRAND reconciler (the DAG self-heal safety net): the PURE 5-part strand
// predicate (`decideStrand`) + the SpecStrandReconciler coordinator, driven through
// in-memory seams (TEST FIXTURES — they live here, never src/). Proves:
//   - the EXACT safe condition: a slot-occupying spec with all-terminal runs + no
//     LIVE percolation marker + not merge-queued ⇒ reconcilable; a spec with a queued
//     run, a merge-queued spec, or a spec whose marker points at a LIVE run ⇒ NOT;
//     a spec whose marker is on a TERMINAL run ⇒ reconcilable;
//   - the reconciler flips a confirmed strand to pending + emits dag.spec.unstranded
//     + clears the orphaned marker;
//   - idempotency: a second pass with a now-queued run is a no-op;
//   - bounded escalation: after the cap is exceeded → needs_attention +
//     dag.spec.needs_attention, with NO further re-enqueue;
//   - classifySpecStatus(needs_attention) → terminal_blocked (frees the slot, blocks
//     only dependents).

import { describe, expect, it } from "vitest";
import {
  decideStrand,
  type SpecStrandEventEmitter,
  type SpecStrandReadModel,
  type SpecStrandSnapshot,
  type SpecStrandWriter,
  type StrandReason,
} from "../src/engine/contracts/specStrandReconciler.js";
import { MAX_UNSTRAND_ATTEMPTS, SpecStrandReconciler } from "../src/engine/dag/specStrandReconciler.js";
import { classifySpecStatus } from "../src/engine/dag/walkerPg.js";
import { applyReconcileStrandedSpec } from "../src/engine/worker/runStateLifecycleSql.js";

const PROJECT = "project_strand";

function snapshot(over: Partial<SpecStrandSnapshot> & { specId: string }): SpecStrandSnapshot {
  return {
    status: "active",
    runs: [{ runId: "run_old", status: "cancelled" }],
    hasActiveMergeQueueEntry: false,
    ...over,
  };
}

describe("decideStrand (the pure 5-part strand predicate)", () => {
  it("a slot-occupying spec with ALL runs terminal + no marker ⇒ reconcilable (no_live_run)", () => {
    const d = decideStrand(
      snapshot({
        specId: "spec_a",
        status: "active",
        runs: [
          { runId: "run_1", status: "cancelled" },
          { runId: "run_2", status: "failed" },
        ],
      }),
    );
    expect(d.reconcilable).toBe(true);
    expect(d.reason).toBe("no_live_run");
    expect(d.orphanedMarkerRunIds).toEqual([]);
    expect(d.terminalRuns).toEqual([
      { runId: "run_1", status: "cancelled" },
      { runId: "run_2", status: "failed" },
    ]);
  });

  it("the CANONICAL §2c strand (prior cancelled + halted re-exec carrying an orphaned marker) ⇒ reconcilable (halted_reexec)", () => {
    const d = decideStrand(
      snapshot({
        specId: "spec_a",
        status: "active",
        runs: [
          { runId: "run_prior", status: "cancelled" },
          // The halted re-exec carries a percolation marker whose re-exec is NOT live.
          {
            runId: "run_reexec",
            status: "halted",
            percolationPending: { reexecRunId: "run_dead", reexecRunLive: false },
          },
        ],
      }),
    );
    expect(d.reconcilable).toBe(true);
    expect(d.reason).toBe("halted_reexec");
    expect(d.orphanedMarkerRunIds).toEqual(["run_reexec"]);
  });

  it("condition 2: a spec with a QUEUED run ⇒ NOT reconcilable", () => {
    const d = decideStrand(snapshot({ specId: "spec_a", runs: [{ runId: "run_q", status: "queued" }] }));
    expect(d.reconcilable).toBe(false);
  });

  it("condition 2: a spec with a RUNNING run ⇒ NOT reconcilable", () => {
    const d = decideStrand(
      snapshot({
        specId: "spec_a",
        runs: [
          { runId: "run_old", status: "cancelled" },
          { runId: "run_live", status: "running" },
        ],
      }),
    );
    expect(d.reconcilable).toBe(false);
  });

  it("condition 3: a spec mid-merge-queue (active queue entry) ⇒ NOT reconcilable", () => {
    const d = decideStrand(
      snapshot({
        specId: "spec_a",
        status: "review",
        runs: [{ runId: "run_done", status: "done" }],
        hasActiveMergeQueueEntry: true,
      }),
    );
    expect(d.reconcilable).toBe(false);
  });

  it("condition 4: a spec whose marker points at a LIVE re-exec ⇒ NOT reconcilable (percolation owns it)", () => {
    const d = decideStrand(
      snapshot({
        specId: "spec_a",
        runs: [
          {
            runId: "run_dep",
            status: "halted",
            percolationPending: { reexecRunId: "run_live", reexecRunLive: true },
          },
        ],
      }),
    );
    expect(d.reconcilable).toBe(false);
  });

  it("condition 4 discriminator: a marker on a TERMINAL run (re-exec NOT live) ⇒ reconcilable (orphaned_marker)", () => {
    const d = decideStrand(
      snapshot({
        specId: "spec_a",
        // A done-not-merged run carrying an orphaned marker (no halted run) ⇒ orphaned_marker.
        runs: [
          {
            runId: "run_dep",
            status: "done",
            percolationPending: { reexecRunId: "run_dead", reexecRunLive: false },
          },
        ],
      }),
    );
    expect(d.reconcilable).toBe(true);
    expect(d.reason).toBe("orphaned_marker");
    expect(d.orphanedMarkerRunIds).toEqual(["run_dep"]);
  });

  it("condition 1: a spec that does NOT occupy a slot (merged/done/halted/cancelled/needs_attention) ⇒ NOT reconcilable", () => {
    for (const status of ["merged", "done", "halted", "cancelled", "needs_attention"]) {
      const d = decideStrand(snapshot({ specId: "spec_a", status, runs: [{ runId: "r", status: "cancelled" }] }));
      expect(`${status}:${d.reconcilable}`).toBe(`${status}:false`);
    }
  });

  it("condition 5: a slot-occupying spec with ZERO runs (mid-creation) ⇒ NOT reconcilable", () => {
    const d = decideStrand(snapshot({ specId: "spec_a", status: "active", runs: [] }));
    expect(d.reconcilable).toBe(false);
  });
});

describe("classifySpecStatus(needs_attention)", () => {
  it("maps to terminal_blocked (frees the slot, blocks only dependents)", () => {
    expect(classifySpecStatus("needs_attention")).toBe("terminal_blocked");
  });
});

// --- In-memory seam fixtures (TEST FIXTURES — they live here, never src/). ---

class FixedReadModel implements SpecStrandReadModel {
  constructor(
    private candidates: SpecStrandSnapshot[],
    private priorUnstrands: Record<string, number> = {},
  ) {}
  setCandidates(candidates: SpecStrandSnapshot[]): void {
    this.candidates = candidates;
  }
  async loadStrandCandidates(): Promise<SpecStrandSnapshot[]> {
    return this.candidates;
  }
  async countPriorUnstrands(input: { specId: string }): Promise<number> {
    return this.priorUnstrands[input.specId] ?? 0;
  }
}

class RecordingWriter implements SpecStrandWriter {
  readonly reEnqueued: string[] = [];
  readonly escalated: string[] = [];
  readonly clearedMarkers: string[] = [];
  /**
   * Whether the atomic guarded flip "moved a row". Default true (no concurrent
   * writer); a test sets it false to SIMULATE a concurrent re-exec that reclaimed the
   * spec between the reconciler's read and the flip — the heal must then be a no-op.
   */
  constructor(private readonly flipped = true) {}
  async reEnqueueSpec(input: { specId: string }): Promise<{ flipped: boolean }> {
    this.reEnqueued.push(input.specId);
    return { flipped: this.flipped };
  }
  async escalateSpec(input: { specId: string }): Promise<{ flipped: boolean }> {
    this.escalated.push(input.specId);
    return { flipped: this.flipped };
  }
  async clearOrphanedMarker(input: { runId: string }): Promise<void> {
    this.clearedMarkers.push(input.runId);
  }
}

class RecordingEmitter implements SpecStrandEventEmitter {
  readonly unstranded: Array<{ specId: string; reason: StrandReason; attempt: number }> = [];
  readonly needsAttention: Array<{ specId: string; reason: StrandReason; attempts: number }> = [];
  async emitUnstranded(input: { specId: string; reason: StrandReason; attempt: number }): Promise<void> {
    this.unstranded.push({ specId: input.specId, reason: input.reason, attempt: input.attempt });
  }
  async emitNeedsAttention(input: { specId: string; reason: StrandReason; attempts: number }): Promise<void> {
    this.needsAttention.push({ specId: input.specId, reason: input.reason, attempts: input.attempts });
  }
}

describe("SpecStrandReconciler (the safety-net coordinator)", () => {
  it("a confirmed strand → flip to pending + dag.spec.unstranded + orphaned marker cleared", async () => {
    const readModel = new FixedReadModel([
      snapshot({
        specId: "spec_a",
        status: "active",
        runs: [
          { runId: "run_prior", status: "cancelled" },
          {
            runId: "run_reexec",
            status: "halted",
            percolationPending: { reexecRunId: "run_dead", reexecRunLive: false },
          },
        ],
      }),
    ]);
    const writer = new RecordingWriter();
    const events = new RecordingEmitter();
    const reconciler = new SpecStrandReconciler({ readModel, writer, events });

    const result = await reconciler.reconcile(PROJECT);

    expect(result.reEnqueued).toEqual(["spec_a"]);
    expect(result.escalated).toEqual([]);
    expect(writer.reEnqueued).toEqual(["spec_a"]);
    expect(writer.clearedMarkers).toEqual(["run_reexec"]);
    expect(events.unstranded).toEqual([{ specId: "spec_a", reason: "halted_reexec", attempt: 1 }]);
    expect(events.needsAttention).toEqual([]);
  });

  it("idempotent: a spec with a now-queued run (already re-enqueued) is a no-op", async () => {
    const readModel = new FixedReadModel([
      snapshot({ specId: "spec_a", status: "active", runs: [{ runId: "run_new", status: "queued" }] }),
    ]);
    const writer = new RecordingWriter();
    const events = new RecordingEmitter();
    const reconciler = new SpecStrandReconciler({ readModel, writer, events });

    const result = await reconciler.reconcile(PROJECT);

    expect(result.reEnqueued).toEqual([]);
    expect(writer.reEnqueued).toEqual([]);
    expect(events.unstranded).toEqual([]);
  });

  it("a merge-queued / live-percolation spec is left alone (precise condition)", async () => {
    const readModel = new FixedReadModel([
      snapshot({
        specId: "spec_mq",
        status: "review",
        runs: [{ runId: "run_done", status: "done" }],
        hasActiveMergeQueueEntry: true,
      }),
      snapshot({
        specId: "spec_live",
        status: "active",
        runs: [
          {
            runId: "run_dep",
            status: "halted",
            percolationPending: { reexecRunId: "run_live", reexecRunLive: true },
          },
        ],
      }),
    ]);
    const writer = new RecordingWriter();
    const events = new RecordingEmitter();
    const reconciler = new SpecStrandReconciler({ readModel, writer, events });

    const result = await reconciler.reconcile(PROJECT);

    expect(result.reEnqueued).toEqual([]);
    expect(result.escalated).toEqual([]);
    expect(writer.reEnqueued).toEqual([]);
  });

  it("bounded escalation: once prior unstrands REACH the cap → needs_attention + dag.spec.needs_attention, NO re-enqueue", async () => {
    const readModel = new FixedReadModel(
      [
        snapshot({
          specId: "spec_a",
          status: "active",
          runs: [
            { runId: "run_prior", status: "cancelled" },
            {
              runId: "run_reexec",
              status: "halted",
              percolationPending: { reexecRunId: "run_dead", reexecRunLive: false },
            },
          ],
        }),
      ],
      // Already re-enqueued the cap number of times (`>=`) ⇒ escalate, do NOT re-enqueue.
      { spec_a: MAX_UNSTRAND_ATTEMPTS },
    );
    const writer = new RecordingWriter();
    const events = new RecordingEmitter();
    const reconciler = new SpecStrandReconciler({ readModel, writer, events });

    const result = await reconciler.reconcile(PROJECT);

    expect(result.escalated).toEqual(["spec_a"]);
    expect(result.reEnqueued).toEqual([]);
    expect(writer.escalated).toEqual(["spec_a"]);
    expect(writer.reEnqueued).toEqual([]);
    expect(writer.clearedMarkers).toEqual(["run_reexec"]);
    expect(events.needsAttention).toEqual([
      { specId: "spec_a", reason: "halted_reexec", attempts: MAX_UNSTRAND_ATTEMPTS },
    ]);
    expect(events.unstranded).toEqual([]);
  });

  it("re-enqueues at most 3 times then escalates (the cap is `>=`, not `>`)", async () => {
    // One BELOW the cap ⇒ still re-enqueues (the 3rd re-enqueue, attempt #3).
    const below = new FixedReadModel(
      [snapshot({ specId: "spec_a", status: "active", runs: [{ runId: "r", status: "cancelled" }] })],
      { spec_a: MAX_UNSTRAND_ATTEMPTS - 1 },
    );
    const wBelow = new RecordingWriter();
    const eBelow = new RecordingEmitter();
    await new SpecStrandReconciler({ readModel: below, writer: wBelow, events: eBelow }).reconcile(PROJECT);
    expect(wBelow.reEnqueued).toEqual(["spec_a"]);
    expect(wBelow.escalated).toEqual([]);
    // The 3rd (final) re-enqueue.
    expect(eBelow.unstranded[0]?.attempt).toBe(MAX_UNSTRAND_ATTEMPTS);

    // AT the cap ⇒ escalates (no 4th re-enqueue).
    const at = new FixedReadModel(
      [snapshot({ specId: "spec_a", status: "active", runs: [{ runId: "r", status: "cancelled" }] })],
      { spec_a: MAX_UNSTRAND_ATTEMPTS },
    );
    const wAt = new RecordingWriter();
    const eAt = new RecordingEmitter();
    await new SpecStrandReconciler({ readModel: at, writer: wAt, events: eAt }).reconcile(PROJECT);
    expect(wAt.reEnqueued).toEqual([]);
    expect(wAt.escalated).toEqual(["spec_a"]);
  });

  it("ATOMIC GUARD: a concurrent live-run creation between the decision and the flip ⇒ the heal is a no-op", async () => {
    // The reconciler DECIDED the spec was a strand (stale snapshot), but the atomic
    // guarded UPDATE matched ZERO rows because a concurrent percolation re-exec
    // reclaimed the spec / created a live queued run in the meantime. The writer
    // returns { flipped: false } — the heal must NOT clear the marker, NOT emit
    // dag.spec.unstranded, and NOT count it as re-enqueued (no double-run).
    const readModel = new FixedReadModel([
      snapshot({
        specId: "spec_a",
        status: "active",
        runs: [
          { runId: "run_prior", status: "cancelled" },
          {
            runId: "run_reexec",
            status: "halted",
            percolationPending: { reexecRunId: "run_dead", reexecRunLive: false },
          },
        ],
      }),
    ]);
    // flipped=false simulates the zero-row path (a concurrent writer won the race).
    const writer = new RecordingWriter(false);
    const events = new RecordingEmitter();
    const reconciler = new SpecStrandReconciler({ readModel, writer, events });

    const result = await reconciler.reconcile(PROJECT);

    // The flip was ATTEMPTED (atomic), but matched zero rows → safe no-op: the
    // marker is NOT cleared and NO spurious unstrand event is emitted.
    expect(writer.reEnqueued).toEqual(["spec_a"]);
    expect(result.reEnqueued).toEqual([]);
    expect(writer.clearedMarkers).toEqual([]);
    expect(events.unstranded).toEqual([]);
  });

  it("ATOMIC GUARD also protects escalation: a lost race on the needs_attention flip ⇒ no-op", async () => {
    const readModel = new FixedReadModel(
      [snapshot({ specId: "spec_a", status: "active", runs: [{ runId: "r", status: "cancelled" }] })],
      { spec_a: MAX_UNSTRAND_ATTEMPTS },
    );
    const writer = new RecordingWriter(false);
    const events = new RecordingEmitter();
    const reconciler = new SpecStrandReconciler({ readModel, writer, events });

    const result = await reconciler.reconcile(PROJECT);

    // The escalation flip was attempted but matched zero rows → no-op.
    expect(writer.escalated).toEqual(["spec_a"]);
    expect(result.escalated).toEqual([]);
    expect(writer.clearedMarkers).toEqual([]);
    expect(events.needsAttention).toEqual([]);
  });
});

/** A fake query client that records the SQL + returns the configured row-count. */
function fakeStrandClient(rowCount: number): {
  client: { query: (text: string, params?: unknown[]) => Promise<{ rowCount: number }> };
  seen: { sql: string; params: unknown[] }[];
} {
  const seen: { sql: string; params: unknown[] }[] = [];
  return {
    seen,
    client: {
      // eslint-disable-next-line @typescript-eslint/require-await
      query: async (sql: string, params: unknown[] = []) => {
        seen.push({ sql, params });
        return { rowCount };
      },
    },
  };
}

describe("applyReconcileStrandedSpec (the atomic guarded UPDATE)", () => {
  it("zero rows matched (a concurrent writer won) ⇒ { flipped: false }", async () => {
    const { client, seen } = fakeStrandClient(0);
    const res = await applyReconcileStrandedSpec(client, { specId: "spec_a", orgId: "org_1", status: "pending" });
    expect(res).toEqual({ flipped: false });
    // The single statement re-checks the FULL strand invariant atomically: still
    // active, no live run, not merge-queued, no live-re-exec percolation marker.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.sql).toContain("status = 'active'");
    expect(seen[0]?.sql).toContain("r.status IN ('queued','running')");
    expect(seen[0]?.sql).toContain("mq.status IN ('queued','merging')");
    expect(seen[0]?.sql).toContain("percolation_pending");
    expect(seen[0]?.params).toEqual(["spec_a", "pending"]);
  });

  it("one row matched (still a strand) ⇒ { flipped: true }", async () => {
    const { client } = fakeStrandClient(1);
    const res = await applyReconcileStrandedSpec(client, {
      specId: "spec_a",
      orgId: "org_1",
      status: "needs_attention",
    });
    expect(res).toEqual({ flipped: true });
  });
});
