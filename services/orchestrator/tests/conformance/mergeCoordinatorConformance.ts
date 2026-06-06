// Seam conformance suite for the MergeCoordinator contract
// (`engine/contracts/mergeCoordinator.ts`) — the native intelligent merge queue
// (autonomy-engine.md §2d). It pins the queue's CONTRACT behaviorally, through the
// public `coordinate(projectId)` surface + the observable queue-state / merge-drive
// / event effects only: a ready run enters the queue, the coordinator merges in DAG
// order (ancestor before dependent) + priority within a layer, ONE merge at a time
// (serialization), a conflict-prone item stays active with bounded retry and loud
// alerting, and idempotency (no double-queue / no double-merge).
//
// It never inspects private fields — only the harness's recorded queue rows, drive
// calls, and emitted events (the contract's observable surface). The harness
// supplies a fresh in-memory queue model + a scripted merge runner the test
// controls, so the SAME spec runs against any MergeCoordinator impl. Mirrors the
// DagWalker/Allocator/JobQueue suites.

import { describe, expect, it } from "vitest";
import type { MergeCoordinator, MergeDriveOutcome } from "../../src/engine/contracts/mergeCoordinator.js";
import type { SpecPriority } from "../../src/engine/state/spec.js";

/** A seed for one queued run + its DAG facts. */
export interface SeedEntry {
  runId: string;
  specId: string;
  dependsOn: string[];
  priority?: SpecPriority;
}

/** A recorded merge-drive call (the per-run merge-path effect). */
export interface RecordedDrive {
  runId: string;
}

/** A recorded queue event (the §2d visibility surface). */
export interface RecordedQueueEvent {
  type: "merge.queue.advanced" | "merge.dequeued" | "merge.queue.infra_blocked";
  specId: string;
  reason?: "conflict" | "blocked" | "failed" | "superseded" | "needs_attention";
  queueDepth?: number;
}

/** A recorded non-bricking §2c escalation (the spec parked at `needs_attention`). */
export interface RecordedEscalation {
  specId: string;
  message: string;
}

/**
 * The harness the conformance suite drives. The test seeds queued entries + merged
 * specs + scripts each run's drive outcome, runs `coordinate`, then asserts on the
 * recorded drives + events + the queue's resulting state.
 */
export interface MergeCoordinatorConformanceHarness {
  coordinator: MergeCoordinator;
  readonly projectId: string;
  /** Seed a queued entry (and its spec's DAG facts). */
  seed(entry: SeedEntry): void;
  /** Seed a legacy dequeued entry that startup recovery may consider. */
  seedLegacyDequeued(entry: SeedEntry & { reason: "blocked" | "conflict" }): void;
  /** Mark a spec as genuinely merged (a satisfied ancestor). */
  setMerged(specId: string): void;
  /** Script the outcome a run's merge drive returns (default: merged). */
  scriptDrive(runId: string, outcome: MergeDriveOutcome): void;
  /** The queue status of a run's entry, reflecting the coordinate effects. */
  statusOf(runId: string): "queued" | "merging" | "merged" | "dequeued" | undefined;
  /** Every merge-drive call the coordinator made, in order. */
  readonly drives: RecordedDrive[];
  /** Every queue event the coordinator emitted, in order. */
  readonly events: RecordedQueueEvent[];
  /** Every spec the coordinator escalated to `needs_attention` (the §2c non-bricking park). */
  readonly escalations: RecordedEscalation[];
}

export interface MergeCoordinatorConformanceSuite {
  make(): MergeCoordinatorConformanceHarness;
}

export function describeMergeCoordinatorConformance(label: string, suite: MergeCoordinatorConformanceSuite): void {
  describe(`MergeCoordinator conformance: ${label}`, () => {
    it("merges a single ready entry and emits merge.queue.advanced", async () => {
      const h = suite.make();
      h.seed({ runId: "run_a", specId: "spec_a", dependsOn: [] });
      const result = await h.coordinator.coordinate(h.projectId);

      expect(result.mergedSpecId).toBe("spec_a");
      expect(h.drives).toEqual([{ runId: "run_a" }]);
      expect(h.statusOf("run_a")).toBe("merged");
      const advanced = h.events.find((e) => e.type === "merge.queue.advanced");
      expect(advanced?.specId).toBe("spec_a");
    });

    it("merges ONE entry at a time (serialization)", async () => {
      const h = suite.make();
      h.seed({ runId: "run_a", specId: "spec_a", dependsOn: [] });
      h.seed({ runId: "run_b", specId: "spec_b", dependsOn: [] });
      // One pass merges exactly one entry; the other stays queued for the next pass.
      const first = await h.coordinator.coordinate(h.projectId);
      expect(h.drives).toHaveLength(1);
      expect(first.mergedSpecId).toBeDefined();

      // The next pass (re-triggered in production by the merge.completed) merges the
      // other. Two passes ⇒ two drives, never two at once.
      const second = await h.coordinator.coordinate(h.projectId);
      expect(h.drives).toHaveLength(2);
      expect(second.mergedSpecId).toBeDefined();
      expect(h.statusOf("run_a")).toBe("merged");
      expect(h.statusOf("run_b")).toBe("merged");
    });

    it("merges in DAG order — an ancestor before its dependent", async () => {
      const h = suite.make();
      // B depends on A; both queued. A must merge first.
      h.seed({ runId: "run_b", specId: "spec_b", dependsOn: ["spec_a"] });
      h.seed({ runId: "run_a", specId: "spec_a", dependsOn: [] });

      await h.coordinator.coordinate(h.projectId);
      // The first drive MUST be A (the ancestor), never B.
      expect(h.drives[0]).toEqual({ runId: "run_a" });
      // A merged ⇒ now B is eligible. Mark A merged (the merge-stage effect) + re-pass.
      h.setMerged("spec_a");
      await h.coordinator.coordinate(h.projectId);
      expect(h.drives).toEqual([{ runId: "run_a" }, { runId: "run_b" }]);
    });

    it("a dependent is NOT eligible while its ancestor is merely QUEUED — only once the ancestor's drive MERGES it", async () => {
      // The cardinal-sin regression lock: a queued-but-UNMERGED ancestor must
      // NOT satisfy a dependent. This drives the WHOLE loop with NO manual setMerged
      // — the dependent becomes eligible ONLY because the coordinator's own drive
      // merged the ancestor (which is the single point an ancestor reaches merged).
      const h = suite.make();
      h.seed({ runId: "run_dep", specId: "spec_dep", dependsOn: ["spec_anc"], priority: "P0" });
      h.seed({ runId: "run_anc", specId: "spec_anc", dependsOn: [], priority: "P2" });

      // Pass 1: the ancestor (lower priority) is driven; the dependent (P0) is held
      // because its ancestor is queued, NOT merged.
      await h.coordinator.coordinate(h.projectId);
      expect(h.drives).toEqual([{ runId: "run_anc" }]);
      expect(h.statusOf("run_dep")).toBe("queued");
      expect(h.statusOf("run_anc")).toBe("merged");

      // Pass 2: the ancestor's merge (from pass 1's drive) is what makes the
      // dependent eligible — now it merges, in order, second.
      await h.coordinator.coordinate(h.projectId);
      expect(h.drives).toEqual([{ runId: "run_anc" }, { runId: "run_dep" }]);
    });

    it("NEVER merges a dependent before its ancestor, even if the dependent sorts first", async () => {
      const h = suite.make();
      // The dependent has higher priority (P0) but depends on a lower-priority (P2)
      // ancestor that is STILL QUEUED — DAG order beats priority.
      h.seed({ runId: "run_dep", specId: "spec_dep", dependsOn: ["spec_anc"], priority: "P0" });
      h.seed({ runId: "run_anc", specId: "spec_anc", dependsOn: [], priority: "P2" });

      await h.coordinator.coordinate(h.projectId);
      expect(h.drives[0]).toEqual({ runId: "run_anc" });
      expect(h.statusOf("run_dep")).toBe("queued");
    });

    it("orders by priority WITHIN a DAG layer (P0 before P2)", async () => {
      const h = suite.make();
      // Two independent roots; P0 must merge before P2.
      h.seed({ runId: "run_lo", specId: "spec_lo", dependsOn: [], priority: "P2" });
      h.seed({ runId: "run_hi", specId: "spec_hi", dependsOn: [], priority: "P0" });
      await h.coordinator.coordinate(h.projectId);
      expect(h.drives[0]).toEqual({ runId: "run_hi" });
    });

    it("keeps a recoverable blocked candidate queued through the retry ceiling", async () => {
      const h = suite.make();
      // The head is blocked; it should not be stranded as a recoverable dequeue.
      h.seed({ runId: "run_x", specId: "spec_x", dependsOn: [], priority: "P0" });
      h.seed({ runId: "run_y", specId: "spec_y", dependsOn: [], priority: "P1" });
      h.scriptDrive("run_x", { kind: "blocked", message: "percolation owns the spec" });

      const first = await h.coordinator.coordinate(h.projectId);
      expect(first.holdReason).toBe("merge_retry");
      expect(h.statusOf("run_x")).toBe("queued");
      expect(h.events.some((e) => e.type === "merge.dequeued")).toBe(false);

      // Bounded liveness: repeated recoverable holds eventually alert, but the
      // retriable candidate stays queued so recovery remains autonomous.
      let last = first;
      for (let i = 0; i < 10 && last.holdReason === "merge_retry"; i += 1) {
        last = await h.coordinator.coordinate(h.projectId);
      }
      expect(h.statusOf("run_x")).toBe("queued");
      expect(h.statusOf("run_y")).toBe("queued");
      expect(h.events.some((e) => e.type === "merge.queue.infra_blocked")).toBe(true);
      expect(h.events.some((e) => e.type === "merge.dequeued")).toBe(false);
    });

    it("does not recover and re-drive a legacy terminal conflict with only a dequeue signal", async () => {
      const h = suite.make();
      h.seedLegacyDequeued({
        runId: "run_conflict",
        specId: "spec_conflict",
        dependsOn: [],
        priority: "P0",
        reason: "conflict",
      });
      h.seed({ runId: "run_next", specId: "spec_next", dependsOn: [], priority: "P1" });

      await h.coordinator.coordinate(h.projectId);

      expect(h.statusOf("run_conflict")).toBe("dequeued");
      expect(h.drives.some((d) => d.runId === "run_conflict")).toBe(false);
      expect(h.drives).toEqual([{ runId: "run_next" }]);
      expect(h.statusOf("run_next")).toBe("merged");
    });

    it("a conflict the drive RESOLVES now MERGES (no dequeue + no re-exec) — the real resolver wired", async () => {
      // The drive-path intent-preserving resolver (driveConflictResolve.ts) reconciled
      // the conflict + re-gated clean, so the per-run merge path RETRIED the merge and
      // it landed — the drive RETURNS `merged`, not the old `conflict` dequeue+re-exec.
      // The conformance harness scripts the per-run merge-drive OUTCOME (the resolver
      // runs INSIDE the drive), so a resolving drive is exactly a `merged` outcome.
      const h = suite.make();
      h.seed({ runId: "run_r", specId: "spec_r", dependsOn: [], priority: "P0" });
      h.scriptDrive("run_r", { kind: "merged" });

      const result = await h.coordinator.coordinate(h.projectId);

      // It MERGED — never dequeued (the pre-PR2 blind-re-exec stub would have dequeued
      // `conflict` here and re-enqueued a fresh run that re-hit the same conflict).
      expect(result.mergedSpecId).toBe("spec_r");
      expect(h.statusOf("run_r")).toBe("merged");
      expect(h.events.some((e) => e.type === "merge.dequeued")).toBe(false);
      // TERMINAL: a re-pass never re-drives the merged entry (no re-exec loop).
      await h.coordinator.coordinate(h.projectId);
      expect(h.drives.filter((d) => d.runId === "run_r")).toHaveLength(1);
    });

    it("ESCALATES a genuinely-irreconcilable head to needs_attention (non-bricking, terminal, NEVER re-queued)", async () => {
      const h = suite.make();
      // The head is judged genuinely irreconcilable; an independent later item must
      // still merge (the escalation FREES the slot — it never bricks the DAG).
      h.seed({ runId: "run_x", specId: "spec_x", dependsOn: [], priority: "P0" });
      h.seed({ runId: "run_y", specId: "spec_y", dependsOn: [], priority: "P1" });
      h.scriptDrive("run_x", { kind: "needs_attention", message: "irreconcilable with spec_z" });

      // Pass 1: the P0 head is driven, judged irreconcilable, ESCALATED + dequeued
      // `needs_attention` — NOT routed through the recoverable conflict path.
      await h.coordinator.coordinate(h.projectId);
      expect(h.statusOf("run_x")).toBe("dequeued");
      // The spec was parked at needs_attention (the loud, non-bricking escalation).
      expect(h.escalations).toEqual([{ specId: "spec_x", message: "irreconcilable with spec_z" }]);
      const dq = h.events.find((e) => e.type === "merge.dequeued");
      expect(dq?.specId).toBe("spec_x");
      expect(dq?.reason).toBe("needs_attention");

      // Pass 2: the independent P1 item proceeds — the escalation never blocked it.
      await h.coordinator.coordinate(h.projectId);
      expect(h.statusOf("run_y")).toBe("merged");

      // TERMINAL: the irreconcilable head is dequeued for good — it is NEVER re-driven
      // (a re-pass selects only the empty/remaining ready set, never run_x again).
      const drivesOfX = h.drives.filter((d) => d.runId === "run_x");
      expect(drivesOfX).toHaveLength(1);
    });

    it("removes a terminally-failed head so the queue makes progress (liveness)", async () => {
      const h = suite.make();
      h.seed({ runId: "run_f", specId: "spec_f", dependsOn: [], priority: "P0" });
      h.seed({ runId: "run_g", specId: "spec_g", dependsOn: [], priority: "P1" });
      h.scriptDrive("run_f", { kind: "failed", message: "merge failed" });

      await h.coordinator.coordinate(h.projectId);
      expect(h.statusOf("run_f")).toBe("dequeued");
      await h.coordinator.coordinate(h.projectId);
      expect(h.statusOf("run_g")).toBe("merged");
    });

    it("is idempotent — a re-pass never re-drives an already-merged entry", async () => {
      const h = suite.make();
      h.seed({ runId: "run_a", specId: "spec_a", dependsOn: [] });
      await h.coordinator.coordinate(h.projectId);
      const drivesAfterFirst = h.drives.length;
      // A second pass over the now-empty ready set drives nothing.
      const second = await h.coordinator.coordinate(h.projectId);
      expect(h.drives).toHaveLength(drivesAfterFirst);
      expect(second.mergedSpecId).toBeUndefined();
      expect(second.holdReason).toBe("empty");
    });

    it("holds (no drive) when the queue is empty", async () => {
      const h = suite.make();
      const result = await h.coordinator.coordinate(h.projectId);
      expect(h.drives).toEqual([]);
      expect(result.holdReason).toBe("empty");
    });

    // END-TO-END (the conflict-resolution sequence's liveness contract): two
    // genuinely-conflicting SIBLING specs. The first merges; the second's drive hits
    // the conflict, and the drive path either RESOLVES-and-merges (happy) OR ESCALATES
    // `needs_attention` (a genuine product clash). In BOTH the rest of the DAG keeps
    // draining (liveness), there is NO infinite re-exec (each conflicting entry is
    // driven exactly once), and there is NO blind `merge_conflict_reexec` re-run on the
    // drive path (the deleted pre-PR2 stub) — the resolver/escalator replaced it.
    it("two conflicting siblings — RESOLVED: first merges, second's conflict RESOLVES-and-merges, an independent item still drains", async () => {
      const h = suite.make();
      // Two siblings (both roots) that conflict with each other, plus an independent
      // third spec that must keep draining regardless.
      h.seed({ runId: "run_s1", specId: "spec_s1", dependsOn: [], priority: "P0" });
      h.seed({ runId: "run_s2", specId: "spec_s2", dependsOn: [], priority: "P1" });
      h.seed({ runId: "run_ind", specId: "spec_ind", dependsOn: [], priority: "P2" });
      // The second sibling's drive RESOLVES the conflict in-drive (the real resolver
      // reconciled + re-gated), so the per-run merge path retried + LANDED — a `merged`
      // outcome (NOT a `conflict` dequeue + blind re-exec).
      h.scriptDrive("run_s2", { kind: "merged" });

      // Pass 1: the P0 sibling merges first.
      await h.coordinator.coordinate(h.projectId);
      expect(h.statusOf("run_s1")).toBe("merged");
      // Pass 2: the second sibling's conflict RESOLVES → it merges (no dequeue).
      await h.coordinator.coordinate(h.projectId);
      expect(h.statusOf("run_s2")).toBe("merged");
      // Pass 3: the independent item drains (liveness — never blocked by the siblings).
      await h.coordinator.coordinate(h.projectId);
      expect(h.statusOf("run_ind")).toBe("merged");

      // No re-exec: each entry is driven EXACTLY once (no infinite re-run loop).
      expect(h.drives.filter((d) => d.runId === "run_s2")).toHaveLength(1);
      // No spec was parked, and NO blind `merge_conflict_reexec` re-run fired.
      expect(h.escalations).toEqual([]);
      assertNoBlindReexec(h.events);
    });

    it("two conflicting siblings — ESCALATED: first merges, second's conflict is genuinely irreconcilable → needs_attention, the rest of the DAG keeps draining", async () => {
      const h = suite.make();
      h.seed({ runId: "run_s1", specId: "spec_s1", dependsOn: [], priority: "P0" });
      h.seed({ runId: "run_s2", specId: "spec_s2", dependsOn: [], priority: "P1" });
      h.seed({ runId: "run_ind", specId: "spec_ind", dependsOn: [], priority: "P2" });
      // The second sibling's intents GENUINELY conflict with the first (the resolver
      // exhausted its bounded re-plan budget) → the drive returns `needs_attention`.
      h.scriptDrive("run_s2", { kind: "needs_attention", message: "intents genuinely conflict with spec_s1" });

      // Pass 1: the P0 sibling merges.
      await h.coordinator.coordinate(h.projectId);
      expect(h.statusOf("run_s1")).toBe("merged");
      // Pass 2: the second sibling is judged irreconcilable → PARKED at needs_attention
      // + dequeued `needs_attention` (NOT the recoverable conflict path, NOT re-queued).
      await h.coordinator.coordinate(h.projectId);
      expect(h.statusOf("run_s2")).toBe("dequeued");
      expect(h.escalations).toEqual([{ specId: "spec_s2", message: "intents genuinely conflict with spec_s1" }]);
      const dq = h.events.find((e) => e.type === "merge.dequeued" && e.specId === "spec_s2");
      expect(dq?.reason).toBe("needs_attention");
      // Pass 3: the independent item drains — the escalation FREED the slot (liveness).
      await h.coordinator.coordinate(h.projectId);
      expect(h.statusOf("run_ind")).toBe("merged");

      // TERMINAL + no re-exec: the parked sibling is driven exactly once, NEVER again.
      expect(h.drives.filter((d) => d.runId === "run_s2")).toHaveLength(1);
      // A re-pass over the now-drained queue re-drives nothing (no infinite re-exec).
      const drivesBefore = h.drives.length;
      await h.coordinator.coordinate(h.projectId);
      expect(h.drives).toHaveLength(drivesBefore);
      // And NO blind `merge_conflict_reexec` re-run ever fired on the drive path.
      assertNoBlindReexec(h.events);
    });
  });
}

/**
 * Assert the deleted pre-PR2 blind re-run never reappears on the drive path. The old
 * stub re-enqueued a fresh run on a conflict via a `merge_conflict_reexec` trigger
 * that re-hit the same conflict forever; the real resolver/escalator replaced it. No
 * recorded queue event may carry that trigger string in its type or reason.
 */
function assertNoBlindReexec(events: ReadonlyArray<RecordedQueueEvent>): void {
  for (const event of events) {
    expect(event.type).not.toContain("merge_conflict_reexec");
    expect(event.reason ?? "").not.toContain("merge_conflict_reexec");
  }
}
