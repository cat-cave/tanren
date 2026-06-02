// Unit tests for the PURE DagWalker scheduling core (autonomy-engine.md §1a): the
// `planDagTick` readiness/ordering/headroom decision + `orderReadySet` tiebreak +
// the `classifySpecStatus` status normalization. These are the deterministic
// heart the conformance suite exercises through the walker; here they are pinned
// directly (no DB, no I/O, no clock).

import { describe, expect, it } from "vitest";
import { type DagSnapshot, type DagSpecNode, orderReadySet, planDagTick } from "../src/engine/contracts/dagWalker.js";
import { classifySpecStatus } from "../src/engine/dag/walker.js";
import type { SpecPriority } from "../src/engine/state/spec.js";

function snap(nodes: DagSpecNode[]): DagSnapshot {
  return { projectId: "project_p", nodes };
}
function n(
  specId: string,
  phase: DagSpecNode["phase"],
  dependsOn: string[],
  orderKey: number,
  priority: SpecPriority = "tbd",
): DagSpecNode {
  return { specId, phase, dependsOn, priority, orderKey };
}

describe("classifySpecStatus", () => {
  it("maps pending → pending", () => {
    expect(classifySpecStatus("pending")).toBe("pending");
  });
  it("maps active / in_flight / open / review → in_flight (slot consumers)", () => {
    for (const s of ["active", "in_flight", "open", "review"]) {
      expect(classifySpecStatus(s)).toBe("in_flight");
    }
  });
  it("maps done AND merged → done (a merged dep is satisfied)", () => {
    expect(classifySpecStatus("done")).toBe("done");
    expect(classifySpecStatus("merged")).toBe("done");
  });
  it("maps halted / cancelled → terminal_blocked (blocks dependents, not satisfied)", () => {
    expect(classifySpecStatus("halted")).toBe("terminal_blocked");
    expect(classifySpecStatus("cancelled")).toBe("terminal_blocked");
  });
  it("treats an unknown status as a slot consumer, never a satisfied dependency", () => {
    expect(classifySpecStatus("something_new")).toBe("in_flight");
  });
});

describe("orderReadySet", () => {
  it("sorts by orderKey ascending then specId for total determinism (within a priority)", () => {
    const ordered = orderReadySet([
      n("spec_b", "pending", [], 1),
      // Same orderKey as spec_b ⇒ the specId tiebreak decides.
      n("spec_a", "pending", [], 1),
      n("spec_c", "pending", [], 0),
    ]);
    expect(ordered.map((x) => x.specId)).toEqual(["spec_c", "spec_a", "spec_b"]);
  });

  it("orders P0 before P1 before P2 before tbd, regardless of creation order (§1b)", () => {
    // Creation order is deliberately the INVERSE of priority order, so a FIFO
    // sort would fail this — only a priority-first sort passes.
    const ordered = orderReadySet([
      n("spec_tbd", "pending", [], 0, "tbd"),
      n("spec_p2", "pending", [], 1, "P2"),
      n("spec_p1", "pending", [], 2, "P1"),
      n("spec_p0", "pending", [], 3, "P0"),
    ]);
    expect(ordered.map((x) => x.specId)).toEqual(["spec_p0", "spec_p1", "spec_p2", "spec_tbd"]);
  });

  it("breaks a priority tie deterministically by creation order then specId", () => {
    const ordered = orderReadySet([
      n("spec_late", "pending", [], 2, "P0"),
      // Same priority + same orderKey as spec_first ⇒ specId decides.
      n("spec_b", "pending", [], 0, "P0"),
      n("spec_a", "pending", [], 0, "P0"),
    ]);
    expect(ordered.map((x) => x.specId)).toEqual(["spec_a", "spec_b", "spec_late"]);
  });

  it("does not mutate its input", () => {
    const input = [n("spec_b", "pending", [], 1), n("spec_a", "pending", [], 0)];
    const copy = [...input];
    orderReadySet(input);
    expect(input).toEqual(copy);
  });
});

describe("planDagTick", () => {
  it("rejects a non-positive ceiling", () => {
    expect(() => planDagTick(snap([]), 0)).toThrow(RangeError);
    expect(() => planDagTick(snap([]), -1)).toThrow(RangeError);
  });

  it("a root pending spec is ready", () => {
    const plan = planDagTick(snap([n("spec_a", "pending", [], 0)]), 3);
    expect(plan.status).toBe("enqueued");
    expect(plan.toEnqueue).toEqual(["spec_a"]);
  });

  it("a pending spec with an unfinished dependency is blocked, not ready", () => {
    const plan = planDagTick(snap([n("spec_a", "in_flight", [], 0), n("spec_b", "pending", ["spec_a"], 1)]), 3);
    expect(plan.toEnqueue).toEqual([]);
    expect(plan.blockedCount).toBe(1);
    expect(plan.status).toBe("drained");
  });

  it("a pending spec whose dep is missing from the snapshot is held (never run on a phantom)", () => {
    const plan = planDagTick(snap([n("spec_b", "pending", ["spec_ghost"], 0)]), 3);
    expect(plan.toEnqueue).toEqual([]);
    expect(plan.blockedCount).toBe(1);
  });

  it("caps enqueues to the headroom below the ceiling, counting in-flight", () => {
    const plan = planDagTick(
      snap([
        n("spec_a", "in_flight", [], 0),
        n("spec_b", "pending", [], 1),
        n("spec_c", "pending", [], 2),
        n("spec_d", "pending", [], 3),
      ]),
      2,
    );
    // ceiling 2, one in-flight ⇒ headroom 1.
    expect(plan.toEnqueue).toEqual(["spec_b"]);
    expect(plan.readyHeldBack).toBe(2);
    expect(plan.status).toBe("enqueued");
  });

  it("enqueues higher-priority ready specs first when headroom is scarce (§1b)", () => {
    // Two ready specs, headroom 1: the P0 wins even though the tbd spec was
    // created first (lower orderKey) — priority dominates the FIFO tiebreak.
    const plan = planDagTick(
      snap([n("spec_old_tbd", "pending", [], 0, "tbd"), n("spec_new_p0", "pending", [], 1, "P0")]),
      1,
    );
    expect(plan.toEnqueue).toEqual(["spec_new_p0"]);
    expect(plan.readyHeldBack).toBe(1);
    expect(plan.status).toBe("enqueued");
  });

  it("reports budget_paused when ready specs exist but headroom is zero", () => {
    const plan = planDagTick(snap([n("spec_a", "in_flight", [], 0), n("spec_b", "pending", [], 1)]), 1);
    expect(plan.toEnqueue).toEqual([]);
    expect(plan.status).toBe("budget_paused");
    expect(plan.readyHeldBack).toBe(1);
  });

  it("reports drained when nothing is ready and nothing is held back", () => {
    const plan = planDagTick(snap([n("spec_a", "done", [], 0), n("spec_b", "in_flight", [], 1)]), 3);
    expect(plan.status).toBe("drained");
    expect(plan.doneCount).toBe(1);
    expect(plan.inFlightCount).toBe(1);
    expect(plan.blockedCount).toBe(0);
  });
});
