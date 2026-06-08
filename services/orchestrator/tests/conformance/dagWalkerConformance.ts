// Seam conformance suite for the DagWalker contract
// (`engine/contracts/dagWalker.ts`). The reusable behavior spec every DagWalker
// implementation must satisfy — the keystone of the autonomy engine
// (autonomy-engine.md §1a). It pins the SCHEDULING CONTRACT behaviorally, through
// the public `walk(projectId)` surface + the observable enqueue/event effects
// only: readiness respects dependencies (all deps DONE), the governed concurrency
// ceiling is honored, a spec already in-flight is never re-enqueued (idempotency),
// the genuine dollar-budget gate pauses the tick when spend reaches the configured
// ceiling, and the drained / budget.paused / concurrency.saturated / spec.enqueued
// outcomes fire correctly.
//
// It never inspects private fields or mock-call internals beyond the harness's
// own recorded enqueues/events (the contract's observable surface). The harness
// supplies a fresh DAG read model the test can mutate (set spec phases + deps +
// the ceiling) and records every enqueue + emitted event, so the SAME spec runs
// against any DagWalker impl. Mirrors the Allocator/JobQueue/Repositories suites.

import { describe, expect, it } from "vitest";
import type { DagSpecNode, DagSpecPhase, DagWalker, ProjectBudgetState } from "../../src/engine/contracts/dagWalker.js";
import type { SpecPriority } from "../../src/engine/state/spec.js";

/** A recorded dag.* event the walker emitted (the contract's visibility surface). */
export interface RecordedDagEvent {
  type:
    | "dag.spec.enqueued"
    | "dag.drained"
    | "dag.budget.paused"
    | "dag.budget.milestone"
    | "dag.concurrency.saturated";
  specId?: string;
  // The budget FRACTION milestone band (50 / 80) — present only on dag.budget.milestone.
  band?: 50 | 80;
  runId?: string;
  inFlightBefore?: number;
  concurrencyCeiling?: number;
  readyHeldBack?: number;
  doneCount?: number;
  inFlightCount?: number;
  blockedCount?: number;
  satisfiedDependsOn?: string[];
  // The GENUINE dollar-budget pause payload (dag.budget.paused).
  ceilingUsd?: number;
  spentUsd?: number;
  period?: "monthly" | "total";
  // BUDGET-SAFETY (C1b/M5): the fail-closed reason when the pause is a safety pause.
  reason?: "unpriced_spend" | "unparseable_config";
}

/** A recorded enqueue (the createQueuedRunFromSpec effect). */
export interface RecordedEnqueue {
  projectId: string;
  specId: string;
  runId: string;
}

/**
 * The harness the conformance suite drives. The test seeds the DAG via `setSpec`
 * + `setCeiling`, runs `walk`, then asserts on `enqueues` + `events`. `phaseOf`
 * reflects the read model AFTER the walk so idempotency (a re-walk does not
 * re-enqueue an already-claimed spec) is observable through the public surface.
 */
export interface DagWalkerConformanceHarness {
  walker: DagWalker;
  readonly projectId: string;
  /** Seed/override a spec node in the DAG read model. */
  setSpec(node: DagSpecNode): void;
  /** Set the governed concurrency ceiling the walker reads. */
  setCeiling(ceiling: number): void;
  /**
   * Set the project's resolved budget state the walker's budget gate returns.
   * `notionalUsd`/`gatedFigure` default (notional 0, gates real spend) — the walker
   * gate only reads `spentUsd`/`ceilingUsd`/`failClosed`, so these tests omit them.
   */
  setBudget(state: Omit<ProjectBudgetState, "notionalUsd" | "gatedFigure">): void;
  /** The spec's current phase in the read model (reflects walk-time claims). */
  phaseOf(specId: string): DagSpecPhase | undefined;
  /** Every enqueue the walker performed, in order. */
  readonly enqueues: RecordedEnqueue[];
  /** Every dag.* event the walker emitted, in order. */
  readonly events: RecordedDagEvent[];
}

export interface DagWalkerConformanceSuite {
  /** Build a fresh harness with an empty DAG + the given ceiling. */
  make(ceiling: number): DagWalkerConformanceHarness;
}

function node(specId: string, phase: DagSpecPhase, dependsOn: string[], orderKey: number): DagSpecNode {
  // The dependency/headroom/idempotency suite is priority-agnostic, so every node
  // carries the same `tbd` priority — ordering then falls through to the
  // creation-order tiebreak the suite asserts on. The priority ORDERING contract
  // is pinned separately (dagWalkerPlan + dagWalkerPriority tests).
  return { specId, phase, dependsOn, priority: "tbd", orderKey };
}

/** Like `node`, but with an explicit priority — for the §1b ordering cases. */
function priNode(
  specId: string,
  phase: DagSpecPhase,
  dependsOn: string[],
  orderKey: number,
  priority: SpecPriority,
): DagSpecNode {
  return { specId, phase, dependsOn, priority, orderKey };
}

export function describeDagWalkerConformance(label: string, suite: DagWalkerConformanceSuite): void {
  describe(`DagWalker conformance: ${label}`, () => {
    it("enqueues a single ready root spec and emits dag.spec.enqueued", async () => {
      const h = suite.make(3);
      h.setSpec(node("spec_root", "pending", [], 0));
      const result = await h.walker.walk(h.projectId);

      expect(result.status).toBe("enqueued");
      expect(result.enqueuedSpecIds).toEqual(["spec_root"]);
      expect(h.enqueues).toEqual([expect.objectContaining({ projectId: h.projectId, specId: "spec_root" })]);
      const enqueuedEvent = h.events.find((e) => e.type === "dag.spec.enqueued");
      expect(enqueuedEvent?.specId).toBe("spec_root");
      expect(enqueuedEvent?.runId).toBe(result.enqueuedRunIds[0]);
    });

    it("does NOT enqueue a spec whose dependency is not yet done", async () => {
      const h = suite.make(3);
      // spec_a is the ancestor still running; spec_b is blocked on it.
      h.setSpec(node("spec_a", "in_flight", [], 0));
      h.setSpec(node("spec_b", "pending", ["spec_a"], 1));
      const result = await h.walker.walk(h.projectId);

      expect(result.enqueuedSpecIds).toEqual([]);
      expect(h.enqueues).toEqual([]);
      // A is in-flight, B is blocked ⇒ nothing ready, nothing held back ⇒ drained.
      expect(result.status).toBe("drained");
      const drained = h.events.find((e) => e.type === "dag.drained");
      expect(drained?.blockedCount).toBe(1);
      expect(drained?.inFlightCount).toBe(1);
    });

    it("enqueues a dependent once its dependency is done", async () => {
      const h = suite.make(3);
      h.setSpec(node("spec_a", "done", [], 0));
      h.setSpec(node("spec_b", "pending", ["spec_a"], 1));
      const result = await h.walker.walk(h.projectId);

      expect(result.enqueuedSpecIds).toEqual(["spec_b"]);
    });

    it("requires ALL dependencies done before a multi-dep spec is ready", async () => {
      const h = suite.make(3);
      h.setSpec(node("spec_a", "done", [], 0));
      // spec_b is not done yet, so spec_c (depending on both) is blocked.
      h.setSpec(node("spec_b", "in_flight", [], 1));
      h.setSpec(node("spec_c", "pending", ["spec_a", "spec_b"], 2));
      const first = await h.walker.walk(h.projectId);
      expect(first.enqueuedSpecIds).toEqual([]);

      // B finishes ⇒ C becomes ready.
      h.setSpec(node("spec_b", "done", [], 1));
      const second = await h.walker.walk(h.projectId);
      expect(second.enqueuedSpecIds).toEqual(["spec_c"]);
    });

    it("treats a merged dependency as satisfied (all deps merged/done)", async () => {
      const h = suite.make(3);
      // The read model carries the normalized phase; a merged spec normalizes to
      // `done` for the walker, so the dependent is ready.
      h.setSpec(node("spec_a", "done", [], 0));
      h.setSpec(node("spec_b", "pending", ["spec_a"], 1));
      const result = await h.walker.walk(h.projectId);
      expect(result.enqueuedSpecIds).toEqual(["spec_b"]);
    });

    it("honors the governed concurrency ceiling — never enqueues past headroom", async () => {
      const h = suite.make(2);
      h.setSpec(node("spec_a", "pending", [], 0));
      h.setSpec(node("spec_b", "pending", [], 1));
      h.setSpec(node("spec_c", "pending", [], 2));
      const result = await h.walker.walk(h.projectId);

      // Ceiling 2, zero in-flight ⇒ exactly two enqueued; the third held back.
      expect(result.enqueuedSpecIds).toHaveLength(2);
      expect(result.status).toBe("enqueued");
      expect(h.enqueues).toHaveLength(2);
    });

    it("counts existing in-flight specs against the ceiling", async () => {
      const h = suite.make(2);
      // spec_a already occupies one slot.
      h.setSpec(node("spec_a", "in_flight", [], 0));
      h.setSpec(node("spec_b", "pending", [], 1));
      h.setSpec(node("spec_c", "pending", [], 2));
      const result = await h.walker.walk(h.projectId);

      // Ceiling 2, one in-flight ⇒ headroom 1 ⇒ exactly one enqueued, by order.
      expect(result.enqueuedSpecIds).toHaveLength(1);
      expect(result.enqueuedSpecIds[0]).toBe("spec_b");
    });

    it("emits dag.concurrency.saturated when ready specs exceed headroom", async () => {
      const h = suite.make(1);
      // spec_a saturates the ceiling; spec_b is ready but has no slot. This is slot
      // pressure — NOT a dollar-budget pause (the two are honestly distinguished).
      h.setSpec(node("spec_a", "in_flight", [], 0));
      h.setSpec(node("spec_b", "pending", [], 1));
      const result = await h.walker.walk(h.projectId);

      expect(result.status).toBe("concurrency_saturated");
      expect(result.enqueuedSpecIds).toEqual([]);
      const saturated = h.events.find((e) => e.type === "dag.concurrency.saturated");
      expect(saturated?.readyHeldBack).toBe(1);
      expect(saturated?.inFlightCount).toBe(1);
      expect(saturated?.concurrencyCeiling).toBe(1);
      // Slot pressure is NOT a budget pause, and not a drain.
      expect(h.events.some((e) => e.type === "dag.budget.paused")).toBe(false);
      expect(h.events.some((e) => e.type === "dag.drained")).toBe(false);
    });

    it("enqueues normally when spend is under the configured ceiling", async () => {
      const h = suite.make(3);
      h.setBudget({ ceilingUsd: 50, period: "monthly", spentUsd: 10 });
      h.setSpec(node("spec_root", "pending", [], 0));
      const result = await h.walker.walk(h.projectId);

      // Under budget ⇒ the gate is transparent; the spec enqueues as usual.
      expect(result.status).toBe("enqueued");
      expect(result.enqueuedSpecIds).toEqual(["spec_root"]);
      expect(h.events.some((e) => e.type === "dag.budget.paused")).toBe(false);
    });

    it("emits a 50% budget milestone (heads-up, NOT a pause) when spend crosses half the ceiling", async () => {
      const h = suite.make(3);
      // Spend at 60% of the ceiling — past 50%, under 80% and under the pause.
      h.setBudget({ ceilingUsd: 50, period: "total", spentUsd: 30 });
      h.setSpec(node("spec_root", "pending", [], 0));
      const result = await h.walker.walk(h.projectId);

      // The run is NOT paused — work still enqueues; the milestone is a heads-up.
      expect(result.status).toBe("enqueued");
      expect(h.events.some((e) => e.type === "dag.budget.paused")).toBe(false);
      const bands = h.events.filter((e) => e.type === "dag.budget.milestone").map((e) => e.band);
      expect(bands).toEqual([50]);
    });

    it("emits BOTH the 50% and 80% milestones when spend jumps straight past both", async () => {
      const h = suite.make(3);
      // Spend at 90% — both fraction bands are crossed but the ceiling is not reached.
      h.setBudget({ ceilingUsd: 50, period: "total", spentUsd: 45 });
      h.setSpec(node("spec_root", "pending", [], 0));
      const result = await h.walker.walk(h.projectId);

      expect(result.status).toBe("enqueued");
      expect(h.events.some((e) => e.type === "dag.budget.paused")).toBe(false);
      const bands = h.events.filter((e) => e.type === "dag.budget.milestone").map((e) => e.band);
      expect(bands).toEqual([50, 80]);
      const milestone = h.events.find((e) => e.type === "dag.budget.milestone" && e.band === 80);
      expect(milestone?.ceilingUsd).toBe(50);
      expect(milestone?.spentUsd).toBe(45);
    });

    it("does NOT re-emit a budget milestone on a re-walk (idempotent per band per window)", async () => {
      const h = suite.make(3);
      h.setBudget({ ceilingUsd: 50, period: "total", spentUsd: 30 });
      h.setSpec(node("spec_root", "pending", [], 0));
      await h.walker.walk(h.projectId);
      // A second walk under the SAME crossed band must NOT re-ping (no milestone spam).
      await h.walker.walk(h.projectId);
      const bands = h.events.filter((e) => e.type === "dag.budget.milestone");
      expect(bands).toHaveLength(1);
      expect(bands[0]?.band).toBe(50);
    });

    it("emits NO budget milestone when spend is below the 50% band", async () => {
      const h = suite.make(3);
      h.setBudget({ ceilingUsd: 50, period: "monthly", spentUsd: 10 });
      h.setSpec(node("spec_root", "pending", [], 0));
      await h.walker.walk(h.projectId);
      expect(h.events.some((e) => e.type === "dag.budget.milestone")).toBe(false);
    });

    it("emits NO budget milestone when there is no ceiling (unlimited)", async () => {
      const h = suite.make(3);
      h.setBudget({ ceilingUsd: undefined, period: "monthly", spentUsd: 999999 });
      h.setSpec(node("spec_root", "pending", [], 0));
      await h.walker.walk(h.projectId);
      expect(h.events.some((e) => e.type === "dag.budget.milestone")).toBe(false);
    });

    it("pauses on budget and enqueues NOTHING when spend reaches the ceiling", async () => {
      const h = suite.make(3);
      // Spend has reached the ceiling — the genuine dollar-budget gate fires.
      h.setBudget({ ceilingUsd: 50, period: "total", spentUsd: 50 });
      h.setSpec(node("spec_root", "pending", [], 0));
      h.setSpec(node("spec_other", "pending", [], 1));
      const result = await h.walker.walk(h.projectId);

      expect(result.status).toBe("budget_paused");
      expect(result.enqueuedSpecIds).toEqual([]);
      expect(h.enqueues).toEqual([]);
      const paused = h.events.find((e) => e.type === "dag.budget.paused");
      expect(paused?.ceilingUsd).toBe(50);
      expect(paused?.spentUsd).toBe(50);
      expect(paused?.period).toBe("total");
      // A budget pause is neither a concurrency hold nor a drain.
      expect(h.events.some((e) => e.type === "dag.concurrency.saturated")).toBe(false);
      expect(h.events.some((e) => e.type === "dag.drained")).toBe(false);
    });

    it("pauses on budget when spend EXCEEDS the ceiling too", async () => {
      const h = suite.make(3);
      h.setBudget({ ceilingUsd: 50, period: "monthly", spentUsd: 73.25 });
      h.setSpec(node("spec_root", "pending", [], 0));
      const result = await h.walker.walk(h.projectId);
      expect(result.status).toBe("budget_paused");
      expect(result.enqueuedSpecIds).toEqual([]);
    });

    it("BUDGET-SAFETY C1b: FAILS CLOSED on unpriced spend even though measured spend is under-ceiling", async () => {
      const h = suite.make(3);
      // Spend MEASURES at $0 (NULL-cost unattributed rows contribute nothing to the
      // sum) but the gate signals fail-closed — the walker must NOT enqueue.
      h.setBudget({ ceilingUsd: 50, period: "monthly", spentUsd: 0, failClosed: "unpriced_spend" });
      h.setSpec(node("spec_root", "pending", [], 0));
      const result = await h.walker.walk(h.projectId);

      expect(result.status).toBe("budget_paused");
      expect(result.enqueuedSpecIds).toEqual([]);
      expect(h.enqueues).toEqual([]);
      const paused = h.events.find((e) => e.type === "dag.budget.paused");
      expect(paused?.reason).toBe("unpriced_spend");
    });

    it("BUDGET-SAFETY M5: FAILS CLOSED on an unparseable budget config (never unlimited)", async () => {
      const h = suite.make(3);
      // An unparseable config resolves ceilingUsd undefined BUT failClosed set — the
      // gate must pause, NOT fall through to unlimited enqueuing.
      h.setBudget({ ceilingUsd: undefined, period: "monthly", spentUsd: 0, failClosed: "unparseable_config" });
      h.setSpec(node("spec_root", "pending", [], 0));
      const result = await h.walker.walk(h.projectId);

      expect(result.status).toBe("budget_paused");
      expect(result.enqueuedSpecIds).toEqual([]);
      const paused = h.events.find((e) => e.type === "dag.budget.paused");
      expect(paused?.reason).toBe("unparseable_config");
    });

    it("is unlimited when no budget is configured (byte-identical to today)", async () => {
      const h = suite.make(3);
      // ceilingUsd undefined ⇒ no ceiling; even a huge spend never pauses.
      h.setBudget({ ceilingUsd: undefined, period: "monthly", spentUsd: 999999 });
      h.setSpec(node("spec_root", "pending", [], 0));
      const result = await h.walker.walk(h.projectId);
      expect(result.status).toBe("enqueued");
      expect(result.enqueuedSpecIds).toEqual(["spec_root"]);
      expect(h.events.some((e) => e.type === "dag.budget.paused")).toBe(false);
    });

    it("orders the ready set by the stable creation-order tiebreak", async () => {
      const h = suite.make(3);
      // Insert out of order; the walker must enqueue by orderKey ascending.
      h.setSpec(node("spec_z", "pending", [], 2));
      h.setSpec(node("spec_x", "pending", [], 0));
      h.setSpec(node("spec_y", "pending", [], 1));
      const result = await h.walker.walk(h.projectId);
      expect(result.enqueuedSpecIds).toEqual(["spec_x", "spec_y", "spec_z"]);
    });

    it("orders by priority (P0→P1→P2→tbd) ahead of the creation-order tiebreak (§1b)", async () => {
      // Headroom 1, four ready specs whose creation order is the INVERSE of
      // priority — only a priority-honoring walker enqueues the P0 first.
      const h = suite.make(1);
      h.setSpec(priNode("spec_tbd", "pending", [], 0, "tbd"));
      h.setSpec(priNode("spec_p2", "pending", [], 1, "P2"));
      h.setSpec(priNode("spec_p1", "pending", [], 2, "P1"));
      h.setSpec(priNode("spec_p0", "pending", [], 3, "P0"));
      const result = await h.walker.walk(h.projectId);
      expect(result.enqueuedSpecIds).toEqual(["spec_p0"]);
    });

    it("breaks a priority tie by the deterministic creation-order tiebreak (§1b)", async () => {
      // Three ready P1 specs: ordering falls through to orderKey then specId.
      const h = suite.make(2);
      h.setSpec(priNode("spec_late", "pending", [], 2, "P1"));
      h.setSpec(priNode("spec_b", "pending", [], 0, "P1"));
      h.setSpec(priNode("spec_a", "pending", [], 0, "P1"));
      const result = await h.walker.walk(h.projectId);
      // Same priority, lowest orderKey wins; specId breaks the orderKey tie.
      expect(result.enqueuedSpecIds).toEqual(["spec_a", "spec_b"]);
    });

    it("is idempotent — a claimed spec is never re-enqueued on a re-walk", async () => {
      const h = suite.make(3);
      h.setSpec(node("spec_a", "pending", [], 0));
      const first = await h.walker.walk(h.projectId);
      expect(first.enqueuedSpecIds).toEqual(["spec_a"]);
      // The enqueue claimed the spec (pending → in_flight) in the read model.
      expect(h.phaseOf("spec_a")).toBe("in_flight");

      const second = await h.walker.walk(h.projectId);
      expect(second.enqueuedSpecIds).toEqual([]);
      // Still exactly ONE enqueue total across both walks — no double-enqueue.
      expect(h.enqueues).toHaveLength(1);
    });

    it("emits dag.drained with an accurate spec breakdown", async () => {
      const h = suite.make(3);
      h.setSpec(node("spec_a", "done", [], 0));
      h.setSpec(node("spec_b", "in_flight", [], 1));
      // spec_c is blocked on the still-running spec_b.
      h.setSpec(node("spec_c", "pending", ["spec_b"], 2));
      const result = await h.walker.walk(h.projectId);

      expect(result.status).toBe("drained");
      const drained = h.events.find((e) => e.type === "dag.drained");
      expect(drained?.doneCount).toBe(1);
      expect(drained?.inFlightCount).toBe(1);
      expect(drained?.blockedCount).toBe(1);
    });

    it("drives a layered DAG to completion across successive walks", async () => {
      const h = suite.make(5);
      // a → b → c chain plus an independent d ready at once with a.
      h.setSpec(node("spec_a", "pending", [], 0));
      h.setSpec(node("spec_b", "pending", ["spec_a"], 1));
      h.setSpec(node("spec_c", "pending", ["spec_b"], 2));
      h.setSpec(node("spec_d", "pending", [], 3));

      // Walk 1: a + d are ready (roots); b, c blocked.
      const w1 = await h.walker.walk(h.projectId);
      expect(new Set(w1.enqueuedSpecIds)).toEqual(new Set(["spec_a", "spec_d"]));

      // a + d finish. Walk 2: b ready (a done); c still blocked.
      h.setSpec(node("spec_a", "done", [], 0));
      h.setSpec(node("spec_d", "done", [], 3));
      const w2 = await h.walker.walk(h.projectId);
      expect(w2.enqueuedSpecIds).toEqual(["spec_b"]);

      // b finishes. Walk 3: c ready.
      h.setSpec(node("spec_b", "done", [], 1));
      const w3 = await h.walker.walk(h.projectId);
      expect(w3.enqueuedSpecIds).toEqual(["spec_c"]);

      // c finishes. Walk 4: fully drained.
      h.setSpec(node("spec_c", "done", [], 2));
      const w4 = await h.walker.walk(h.projectId);
      expect(w4.status).toBe("drained");
      expect(w4.enqueuedSpecIds).toEqual([]);
    });
  });
}
