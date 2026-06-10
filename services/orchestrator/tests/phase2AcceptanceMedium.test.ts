// dry-run smoke for the medium-tier acceptance assertions.
//
// Medium adds two requirements on top of the easy tier:
//   - ≥ 2 write tasks under the planner (i.e. the planner emitted ≥ 2
//     subtasks)
//   - a planner cost record alongside writer/checker/auditor
//
// The checker-rejection loop (planner.rerequested) is a capability exercised
// opportunistically, NOT a hard per-run gate — asserting it would assert
// nondeterministic LLM behavior. Deterministic "tests pass" lives in post-PR
// CI. We verify these paths against synthetic completed-run snapshots so CI
// gates the medium criteria even while the live runner against
// `cat-cave/tanren-fixture-medium` is exercised locally.

import { describe, expect, it } from "vitest";
import {
  AcceptanceAssertionError,
  assertAcceptanceCriteria,
  type PersistedRunSnapshot,
} from "../../../scripts/acceptance/common.js";

function mediumSnapshot(overrides: Partial<PersistedRunSnapshot> = {}): PersistedRunSnapshot {
  return {
    runId: "run_phase2_medium_synthetic",
    status: "done",
    outcome: "ok",
    prUrl: "https://github.com/cat-cave/tanren-fixture-medium/pull/7",
    taskKinds: ["plan", "write", "check", "write", "check", "audit", "ci"],
    taskCounts: { plan: 1, write: 2, check: 2, audit: 1, ci: 1 },
    costBases: [
      { taskKind: "plan", basis: "unknown", billingMode: "subscription" },
      { taskKind: "write", basis: "unknown", billingMode: "subscription" },
      { taskKind: "check", basis: "unknown", billingMode: "subscription" },
      { taskKind: "write", basis: "unknown", billingMode: "subscription" },
      { taskKind: "check", basis: "unknown", billingMode: "subscription" },
      { taskKind: "audit", basis: "unknown", billingMode: "subscription" },
    ],
    events: [
      "planner.started",
      "planner.subtasks.emitted",
      "writer.subtask.completed",
      "checker.verdict",
      "planner.rerequested",
      "planner.subtasks.emitted",
      "writer.subtask.completed",
      "checker.verdict",
      "auditor.verdict",
      "github.pr.created",
      "ci.passed",
    ],
    plannerRerequestedCount: 1,
    workspacePathHints: ["runner.allocated", "workspace.prepared"],
    ciStatus: "passed",
    ...overrides,
  };
}

describe("phase2 acceptance — medium tier dry-run smoke", () => {
  it("passes when every medium-tier criterion is satisfied", () => {
    expect(() =>
      assertAcceptanceCriteria({
        tier: "medium",
        expectedOutcome: "ok",
        snapshot: mediumSnapshot(),
      }),
    ).not.toThrow();
  });

  it("fails when the planner emitted fewer than 2 subtasks", () => {
    expect(() =>
      assertAcceptanceCriteria({
        tier: "medium",
        expectedOutcome: "ok",
        snapshot: mediumSnapshot({
          taskKinds: ["plan", "write", "check", "audit", "ci"],
          taskCounts: { plan: 1, write: 1, check: 1, audit: 1, ci: 1 },
        }),
      }),
    ).toThrow(/≥ 2 write tasks/u);
  });

  it("passes when the loop converged on the first plan (rejection loop is opportunistic, not required)", () => {
    // A medium run where the writer satisfied the checker on the first plan —
    // no planner.rerequested. This must NOT fail: the rejection loop is a
    // capability, not a per-run gate (it would assert nondeterministic LLM
    // behavior). ≥ 2 subtasks + completion + costs + post-PR CI still hold.
    expect(() =>
      assertAcceptanceCriteria({
        tier: "medium",
        expectedOutcome: "ok",
        snapshot: mediumSnapshot({
          plannerRerequestedCount: 0,
          events: mediumSnapshot().events.filter((name) => name !== "planner.rerequested"),
        }),
      }),
    ).not.toThrow();
  });

  it("fails when the planner cost record is missing", () => {
    expect(() =>
      assertAcceptanceCriteria({
        tier: "medium",
        expectedOutcome: "ok",
        snapshot: mediumSnapshot({
          costBases: [
            { taskKind: "write", basis: "unknown", billingMode: "subscription" },
            { taskKind: "check", basis: "unknown", billingMode: "subscription" },
            { taskKind: "audit", basis: "unknown", billingMode: "subscription" },
          ],
        }),
      }),
    ).toThrow(/missing cost_records.*plan/u);
  });

  it("fails when run.outcome is not the canonical ok success outcome", () => {
    expect(() =>
      assertAcceptanceCriteria({
        tier: "medium",
        expectedOutcome: "ok",
        snapshot: mediumSnapshot({ outcome: "retry_budget_exhausted" }),
      }),
    ).toThrow(AcceptanceAssertionError);
  });
});
