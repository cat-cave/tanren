// P2c-1 (autonomy-engine.md §2c): the pure speculative-readiness core + the
// speculative tick planner. Proves the THRESHOLD predicate (conservative needs
// merged; moderate unblocks on CI-green+audited-no-P0/P1; aggressive on PR-open),
// the transitive unmerged-ancestor stacking, and the DEPTH CAP holding a too-deep
// spec — plus the planner classifying a start as speculative vs. not.

import { describe, expect, it } from "vitest";
import type {
  DagLifecycleSnapshot,
  SpecLifecycle,
  SpecLifecycleState,
  OpenFindingSeverity,
} from "../src/engine/contracts/dagLifecycle.js";
import type { DagSnapshot, DagSpecNode } from "../src/engine/contracts/dagWalker.js";
import { planSpeculativeDagTick } from "../src/engine/contracts/dagWalker.js";
import {
  ancestorCrossedThreshold,
  computeReadiness,
  transitiveUnmergedAncestors,
} from "../src/engine/dag/speculation.js";

function node(specId: string, phase: DagSpecNode["phase"], dependsOn: string[], orderKey: number): DagSpecNode {
  return { specId, phase, dependsOn, priority: "tbd", orderKey };
}

function life(state: SpecLifecycleState, severity: OpenFindingSeverity = "none"): SpecLifecycle {
  return { specId: "x", state, openFindingMaxSeverity: severity };
}

function lifecycleSnap(entries: Record<string, SpecLifecycle>): DagLifecycleSnapshot {
  return { projectId: "p", bySpecId: new Map(Object.entries(entries)) };
}

const snap = (nodes: DagSpecNode[]): DagSnapshot => ({ projectId: "p", nodes, archived: false });

describe("ancestorCrossedThreshold", () => {
  it("conservative requires merged", () => {
    expect(ancestorCrossedThreshold(life("merged"), "conservative")).toBe(true);
    expect(ancestorCrossedThreshold(life("review"), "conservative")).toBe(false);
    expect(ancestorCrossedThreshold(life("audited"), "conservative")).toBe(false);
  });

  it("aggressive crosses at pr_open (pre-CI)", () => {
    expect(ancestorCrossedThreshold(life("pr_open"), "aggressive")).toBe(true);
    expect(ancestorCrossedThreshold(life("building"), "aggressive")).toBe(false);
  });

  it("moderate: CI-green+audited with no P0/P1 crosses even with review pending", () => {
    // audited, only P2 polish, review still pending → crosses.
    expect(ancestorCrossedThreshold(life("audited", "P2"), "moderate")).toBe(true);
    expect(ancestorCrossedThreshold(life("review", "none"), "moderate")).toBe(true);
  });

  it("moderate: an open P0/P1 finding blocks", () => {
    expect(ancestorCrossedThreshold(life("audited", "P0"), "moderate")).toBe(false);
    expect(ancestorCrossedThreshold(life("audited", "P1"), "moderate")).toBe(false);
  });

  it("moderate: 'technically complete but pending automated audits' is NOT ready", () => {
    // ci_green but unaudited → audits gate, not ready.
    expect(ancestorCrossedThreshold(life("ci_green", "unaudited"), "moderate")).toBe(false);
  });

  it("a blocked (halted) ancestor never crosses any threshold", () => {
    expect(ancestorCrossedThreshold(life("blocked"), "aggressive")).toBe(false);
    expect(ancestorCrossedThreshold(life("blocked"), "moderate")).toBe(false);
    expect(ancestorCrossedThreshold(life("blocked"), "conservative")).toBe(false);
  });
});

describe("transitiveUnmergedAncestors", () => {
  it("stacks only the UNMERGED transitive ancestors, DAG-ordered", () => {
    // C depends on B depends on A. A merged, B unmerged → C's stack is [B].
    const nodes = [
      node("spec_a", "done", [], 0),
      node("spec_b", "in_flight", ["spec_a"], 1),
      node("spec_c", "pending", ["spec_b"], 2),
    ];
    const depsById = new Map(nodes.map((n) => [n.specId, n.dependsOn]));
    const orderById = new Map(nodes.map((n) => [n.specId, n.orderKey]));
    const lc = lifecycleSnap({ spec_a: life("merged"), spec_b: life("audited"), spec_c: life("pending") });
    const stack = transitiveUnmergedAncestors(nodes[2]!, depsById, lc, orderById);
    expect(stack).toEqual(["spec_b"]);
  });

  it("stacks a deep unmerged chain transitively", () => {
    // C → B → A, all unmerged → C's stack is [A, B] (DAG order by creation).
    const nodes = [
      node("spec_a", "in_flight", [], 0),
      node("spec_b", "in_flight", ["spec_a"], 1),
      node("spec_c", "pending", ["spec_b"], 2),
    ];
    const depsById = new Map(nodes.map((n) => [n.specId, n.dependsOn]));
    const orderById = new Map(nodes.map((n) => [n.specId, n.orderKey]));
    const lc = lifecycleSnap({ spec_a: life("audited"), spec_b: life("audited"), spec_c: life("pending") });
    const stack = transitiveUnmergedAncestors(nodes[2]!, depsById, lc, orderById);
    expect(stack).toEqual(["spec_a", "spec_b"]);
  });
});

describe("computeReadiness — depth cap", () => {
  it("HOLDS a spec whose unmerged-ancestor depth exceeds the cap (not silently truncated)", () => {
    // C → B → A all unmerged (depth 2) with cap 1 → held.
    const nodes = [
      node("spec_a", "in_flight", [], 0),
      node("spec_b", "in_flight", ["spec_a"], 1),
      node("spec_c", "pending", ["spec_b"], 2),
    ];
    const lc = lifecycleSnap({ spec_a: life("audited"), spec_b: life("audited"), spec_c: life("pending") });
    const readiness = computeReadiness([nodes[2]!], nodes, lc, "moderate", 1);
    const c = readiness.get("spec_c")!;
    expect(c.ready).toBe(false);
    expect(c.held).toBe(true);
    expect(c.depth).toBe(2);
    expect(c.unmergedAncestors).toEqual(["spec_a", "spec_b"]);
  });

  it("admits the same spec when the cap allows the depth", () => {
    const nodes = [
      node("spec_a", "in_flight", [], 0),
      node("spec_b", "in_flight", ["spec_a"], 1),
      node("spec_c", "pending", ["spec_b"], 2),
    ];
    const lc = lifecycleSnap({ spec_a: life("audited"), spec_b: life("audited"), spec_c: life("pending") });
    const readiness = computeReadiness([nodes[2]!], nodes, lc, "moderate", 2);
    const c = readiness.get("spec_c")!;
    expect(c.ready).toBe(true);
    expect(c.speculative).toBe(true);
  });
});

describe("planSpeculativeDagTick — speculative classification", () => {
  it("moderate: a dependent on an audited (review-pending) ancestor starts SPECULATIVELY", () => {
    const nodes = [node("spec_a", "in_flight", [], 0), node("spec_b", "pending", ["spec_a"], 1)];
    const lc = lifecycleSnap({ spec_a: life("audited", "P2"), spec_b: life("pending") });
    const plan = planSpeculativeDagTick(snap(nodes), lc, { concurrencyCeiling: 3, threshold: "moderate", depthCap: 2 });
    expect(plan.toEnqueue).toEqual(["spec_b"]);
    const enqueue = plan.enqueues.find((e) => e.specId === "spec_b")!;
    expect(enqueue.speculative).toBe(true);
    expect(enqueue.unmergedAncestors).toEqual(["spec_a"]);
  });

  it("moderate: a P0 finding on the ancestor BLOCKS the dependent", () => {
    const nodes = [node("spec_a", "in_flight", [], 0), node("spec_b", "pending", ["spec_a"], 1)];
    const lc = lifecycleSnap({ spec_a: life("audited", "P0"), spec_b: life("pending") });
    const plan = planSpeculativeDagTick(snap(nodes), lc, { concurrencyCeiling: 3, threshold: "moderate", depthCap: 2 });
    expect(plan.toEnqueue).toEqual([]);
    expect(plan.blockedCount).toBe(1);
  });

  it("conservative: a dependent waits for the ancestor to MERGE (no speculation)", () => {
    const nodes = [node("spec_a", "done", [], 0), node("spec_b", "pending", ["spec_a"], 1)];
    const lc = lifecycleSnap({ spec_a: life("merged"), spec_b: life("pending") });
    const plan = planSpeculativeDagTick(snap(nodes), lc, {
      concurrencyCeiling: 3,
      threshold: "conservative",
      depthCap: 2,
    });
    expect(plan.toEnqueue).toEqual(["spec_b"]);
    // Ancestor merged ⇒ NOT speculative.
    expect(plan.enqueues[0]!.speculative).toBe(false);
  });

  it("aggressive: a dependent starts as soon as the ancestor's PR is open", () => {
    const nodes = [node("spec_a", "in_flight", [], 0), node("spec_b", "pending", ["spec_a"], 1)];
    const lc = lifecycleSnap({ spec_a: life("pr_open", "unaudited"), spec_b: life("pending") });
    const plan = planSpeculativeDagTick(snap(nodes), lc, {
      concurrencyCeiling: 3,
      threshold: "aggressive",
      depthCap: 2,
    });
    expect(plan.toEnqueue).toEqual(["spec_b"]);
    expect(plan.enqueues[0]!.speculative).toBe(true);
  });

  it("a too-deep spec is surfaced in plan.held (the depth-cap hold)", () => {
    const nodes = [
      node("spec_a", "in_flight", [], 0),
      node("spec_b", "in_flight", ["spec_a"], 1),
      node("spec_c", "pending", ["spec_b"], 2),
    ];
    const lc = lifecycleSnap({ spec_a: life("audited"), spec_b: life("audited"), spec_c: life("pending") });
    const plan = planSpeculativeDagTick(snap(nodes), lc, { concurrencyCeiling: 3, threshold: "moderate", depthCap: 1 });
    expect(plan.toEnqueue).toEqual([]);
    expect(plan.held.map((h) => h.specId)).toEqual(["spec_c"]);
    // Held is NOT counted as blocked (it would be ready but for the cap).
    expect(plan.blockedCount).toBe(0);
  });
});
