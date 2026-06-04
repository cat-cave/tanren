// Seam conformance suite for the MergeCoordinator contract
// (`engine/contracts/mergeCoordinator.ts`) — the native intelligent merge queue
// (autonomy-engine.md §2d). It pins the queue's CONTRACT behaviorally, through the
// public `coordinate(projectId)` surface + the observable queue-state / merge-drive
// / event effects only: a ready run enters the queue, the coordinator merges in DAG
// order (ancestor before dependent) + priority within a layer, ONE merge at a time
// (serialization), a conflict-prone item dequeues (recoverable) without deadlocking
// independent items, and idempotency (no double-queue / no double-merge).
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
  type: "merge.queue.advanced" | "merge.dequeued";
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
      // The cardinal-sin regression lock (P2d): a queued-but-UNMERGED ancestor must
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

    it("routes a conflict to a recoverable dequeue WITHOUT deadlocking independent items", async () => {
      const h = suite.make();
      // The head conflicts; an independent later item must still merge.
      h.seed({ runId: "run_x", specId: "spec_x", dependsOn: [], priority: "P0" });
      h.seed({ runId: "run_y", specId: "spec_y", dependsOn: [], priority: "P1" });
      h.scriptDrive("run_x", { kind: "conflict", message: "branch conflicts with base" });

      // Pass 1: the P0 head is driven, conflicts, and is dequeued (not stuck merging).
      await h.coordinator.coordinate(h.projectId);
      expect(h.statusOf("run_x")).toBe("dequeued");
      const dq = h.events.find((e) => e.type === "merge.dequeued");
      expect(dq?.specId).toBe("spec_x");
      expect(dq?.reason).toBe("conflict");

      // Pass 2: the independent P1 item proceeds — the conflict never blocked it.
      await h.coordinator.coordinate(h.projectId);
      expect(h.statusOf("run_y")).toBe("merged");
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
  });
}
