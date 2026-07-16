// apex v35 — the ONE shared spec-progress classification (specProgress.ts), used by
// BOTH the orphan-slot reconciler (Bug 1) and the build deadlock detector (Bug 2).
// These tests pin the vocabulary so the two callers can never disagree on "can this
// spec still make forward progress?".

import { describe, expect, it } from "vitest";
import type { DagSnapshot } from "../src/engine/contracts/dagWalker.js";
import {
  classifySpecProgress,
  isConverged,
  isDeadlocked,
  tallyBuildProgress,
} from "../src/engine/contracts/specProgress.js";

function snap(
  nodes: Array<{ specId: string; phase: DagSnapshot["nodes"][number]["phase"]; dependsOn?: string[] }>,
): DagSnapshot {
  return {
    projectId: "p",
    projectLifecycle: "active",
    nodes: nodes.map((n, i) => ({
      specId: n.specId,
      phase: n.phase,
      dependsOn: n.dependsOn ?? [],
      priority: "p1",
      orderKey: i,
    })),
  };
}

describe("classifySpecProgress — the shared vocabulary", () => {
  it("classifies done / in_flight / terminal directly", () => {
    const classes = classifySpecProgress(
      snap([
        { specId: "a", phase: "done" },
        { specId: "b", phase: "in_flight" },
        { specId: "c", phase: "terminal_blocked" },
      ]),
    );
    expect(classes.get("a")).toBe("done");
    expect(classes.get("b")).toBe("in_flight");
    expect(classes.get("c")).toBe("terminal");
  });

  it("a pending root (no deps) is runnable_pending", () => {
    expect(classifySpecProgress(snap([{ specId: "a", phase: "pending" }])).get("a")).toBe("runnable_pending");
  });

  it("a pending spec whose ancestor is DONE / IN_FLIGHT is runnable_pending (those can still merge)", () => {
    const classes = classifySpecProgress(
      snap([
        { specId: "done_anc", phase: "done" },
        { specId: "live_anc", phase: "in_flight" },
        { specId: "b", phase: "pending", dependsOn: ["done_anc"] },
        { specId: "c", phase: "pending", dependsOn: ["live_anc"] },
      ]),
    );
    expect(classes.get("b")).toBe("runnable_pending");
    expect(classes.get("c")).toBe("runnable_pending");
  });

  it("a pending spec with a TERMINAL ancestor is transitively_blocked (it can never run)", () => {
    const classes = classifySpecProgress(
      snap([
        { specId: "a", phase: "terminal_blocked" },
        { specId: "b", phase: "pending", dependsOn: ["a"] },
      ]),
    );
    expect(classes.get("b")).toBe("transitively_blocked");
  });

  it("the block PROPAGATES through a chain of pending ancestors (A terminal → B → C all blocked)", () => {
    const classes = classifySpecProgress(
      snap([
        { specId: "a", phase: "terminal_blocked" },
        { specId: "b", phase: "pending", dependsOn: ["a"] },
        { specId: "c", phase: "pending", dependsOn: ["b"] },
      ]),
    );
    expect(classes.get("b")).toBe("transitively_blocked");
    expect(classes.get("c")).toBe("transitively_blocked");
  });

  it("a block does NOT propagate through an IN_FLIGHT ancestor (it may still merge and unblock)", () => {
    // A terminal, B in_flight depends on A (B is occupying a slot, not pending — it is
    // itself a strand candidate, but its dependent C is NOT transitively blocked because
    // B is still live and may merge).
    const classes = classifySpecProgress(
      snap([
        { specId: "a", phase: "terminal_blocked" },
        { specId: "b", phase: "in_flight", dependsOn: ["a"] },
        { specId: "c", phase: "pending", dependsOn: ["b"] },
      ]),
    );
    expect(classes.get("c")).toBe("runnable_pending");
  });

  it("a pending cycle is NOT treated as terminal (cycle guard) — readiness handles cycles, not this", () => {
    const classes = classifySpecProgress(
      snap([
        { specId: "a", phase: "pending", dependsOn: ["b"] },
        { specId: "b", phase: "pending", dependsOn: ["a"] },
      ]),
    );
    expect(classes.get("a")).toBe("runnable_pending");
    expect(classes.get("b")).toBe("runnable_pending");
  });
});

describe("tallyBuildProgress + convergence/deadlock", () => {
  it("converged = all merged", () => {
    const t = tallyBuildProgress(
      snap([
        { specId: "a", phase: "done" },
        { specId: "b", phase: "done" },
      ]),
    );
    expect(isConverged(t)).toBe(true);
    expect(isDeadlocked(t)).toBe(false);
  });

  it("a needs_attention spec + its transitively-blocked dependents = DEADLOCK (progressing === 0)", () => {
    const t = tallyBuildProgress(
      snap([
        { specId: "spec_A", phase: "terminal_blocked" },
        { specId: "spec_B", phase: "pending", dependsOn: ["spec_A"] },
        { specId: "spec_C", phase: "pending", dependsOn: ["spec_B"] },
      ]),
    );
    expect(t.progressing).toBe(0);
    expect(isDeadlocked(t)).toBe(true);
    // The genuine blocker is named; its stranded dependents are listed separately.
    expect(t.terminalSpecIds).toEqual(["spec_A"]);
    expect(t.transitivelyBlockedSpecIds).toEqual(["spec_B", "spec_C"]);
  });

  it("an in-flight / runnable spec beside a transitively-blocked one is NOT a deadlock (keeps progressing)", () => {
    const t = tallyBuildProgress(
      snap([
        { specId: "spec_A", phase: "terminal_blocked" },
        { specId: "spec_B", phase: "pending", dependsOn: ["spec_A"] },
        { specId: "spec_C", phase: "in_flight" },
      ]),
    );
    // Only spec_C is progressing (in_flight); spec_A terminal, spec_B blocked.
    expect(t.progressing).toBe(1);
    expect(isDeadlocked(t)).toBe(false);
  });

  it("the OLD bug shape: a terminal spec + a single transitively-blocked dependent — old count called it progressing", () => {
    // total=2, done=0, terminal_blocked count=1 ⇒ old `total-done-blocked` = 1 (> 0) ⇒
    // the build HUNG. The shared tally: progressing=0 ⇒ DEADLOCK (halt loud).
    const t = tallyBuildProgress(
      snap([
        { specId: "spec_A", phase: "terminal_blocked" },
        { specId: "spec_B", phase: "pending", dependsOn: ["spec_A"] },
      ]),
    );
    expect(t.progressing).toBe(0);
    expect(isDeadlocked(t)).toBe(true);
  });
});
