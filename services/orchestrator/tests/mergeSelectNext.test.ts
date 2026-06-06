// (autonomy-engine.md §2d): the PURE merge-queue selection core
// (`selectNextMerge`) — the DAG-order + priority + serialization decision, pinned
// with no DB or VCS. The conformance suite drives the full coordinator; this pins
// the ordering algorithm directly so each rule is unambiguous.

import { describe, expect, it } from "vitest";
import { selectNextMerge, type MergeQueueEntry } from "../src/engine/contracts/mergeCoordinator.js";
import type { SpecPriority } from "../src/engine/state/spec.js";

function entry(specId: string, dependsOn: string[], orderKey: number, priority: SpecPriority = "tbd"): MergeQueueEntry {
  return {
    queueId: `mq_${specId}`,
    runId: `run_${specId}`,
    specId,
    prUrl: `https://github.test/pr/${specId}`,
    prNumber: orderKey,
    dependsOn,
    priority,
    orderKey,
  };
}

describe("selectNextMerge (pure §2d ordering core)", () => {
  it("holds (serialized) when another merge is already in flight — one at a time", () => {
    const sel = selectNextMerge({
      projectId: "p",
      entries: [entry("a", [], 0)],
      mergedSpecIds: new Set(),
      mergingInFlight: true,
    });
    expect(sel.next).toBeUndefined();
    expect(sel.holdReason).toBe("serialized");
  });

  it("holds (empty) when there are no queued entries", () => {
    const sel = selectNextMerge({ projectId: "p", entries: [], mergedSpecIds: new Set(), mergingInFlight: false });
    expect(sel.next).toBeUndefined();
    expect(sel.holdReason).toBe("empty");
  });

  it("picks the ancestor before the dependent (DAG order)", () => {
    const sel = selectNextMerge({
      projectId: "p",
      entries: [entry("b", ["a"], 1), entry("a", [], 0)],
      mergedSpecIds: new Set(),
      mergingInFlight: false,
    });
    expect(sel.next?.specId).toBe("a");
    expect(sel.blockedByDependency.map((e) => e.specId)).toEqual(["b"]);
  });

  it("never picks a dependent ahead of an unmerged ancestor, even with higher priority", () => {
    const sel = selectNextMerge({
      projectId: "p",
      entries: [entry("dep", ["anc"], 0, "P0"), entry("anc", [], 1, "P2")],
      mergedSpecIds: new Set(),
      mergingInFlight: false,
    });
    // The ancestor (lower priority) still wins — DAG order beats priority.
    expect(sel.next?.specId).toBe("anc");
  });

  it("becomes eligible once the ancestor has genuinely merged", () => {
    const sel = selectNextMerge({
      projectId: "p",
      entries: [entry("b", ["a"], 1)],
      mergedSpecIds: new Set(["a"]),
      mergingInFlight: false,
    });
    expect(sel.next?.specId).toBe("b");
  });

  it("orders by priority within a DAG layer (P0 before P1 before P2)", () => {
    const sel = selectNextMerge({
      projectId: "p",
      entries: [entry("lo", [], 0, "P2"), entry("mid", [], 1, "P1"), entry("hi", [], 2, "P0")],
      mergedSpecIds: new Set(),
      mergingInFlight: false,
    });
    expect(sel.next?.specId).toBe("hi");
  });

  it("breaks a priority tie by orderKey then specId (deterministic)", () => {
    const sel = selectNextMerge({
      projectId: "p",
      entries: [entry("z", [], 5, "P1"), entry("y", [], 2, "P1")],
      mergedSpecIds: new Set(),
      mergingInFlight: false,
    });
    // Lower orderKey first.
    expect(sel.next?.specId).toBe("y");
  });

  it("picks an INDEPENDENT eligible item when the priority head is dependency-blocked (liveness)", () => {
    const sel = selectNextMerge({
      projectId: "p",
      // dep (P0) is blocked on an unmerged queued ancestor; free (P1) is unblocked.
      entries: [entry("dep", ["anc"], 0, "P0"), entry("anc", [], 1, "P1"), entry("free", [], 2, "P1")],
      mergedSpecIds: new Set(),
      mergingInFlight: false,
    });
    // anc (P1) sorts ahead of free (P1) by orderKey, and is eligible (a root), so
    // it is chosen — but crucially `dep` is NOT chosen (its ancestor is unmerged).
    expect(sel.next?.specId).toBe("anc");
    expect(sel.next?.specId).not.toBe("dep");
  });

  it("blocks a dependent when its ancestor is neither queued nor merged", () => {
    // `external` is not a queued entry and not in mergedSpecIds. That still means
    // it has not genuinely landed, so the dependent cannot merge.
    const sel = selectNextMerge({
      projectId: "p",
      entries: [entry("b", ["external"], 0)],
      mergedSpecIds: new Set(),
      mergingInFlight: false,
    });
    expect(sel.next).toBeUndefined();
    expect(sel.holdReason).toBe("all_blocked");
    expect(sel.blockedByDependency.map((e) => e.specId)).toEqual(["b"]);
  });
});
