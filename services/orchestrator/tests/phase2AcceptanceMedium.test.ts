// P2A-0015 dry-run smoke for the medium-tier acceptance assertions.
//
// Medium adds two requirements on top of the easy tier:
//   - ≥ 2 write tasks under the planner (i.e. the planner emitted ≥ 2
//     subtasks)
//   - ≥ 1 `planner.rerequested` event (the checker rejection loop fired
//     at least once)
//   - a planner cost record alongside writer/checker/auditor
//
// We verify both paths against synthetic completed-run snapshots so CI
// gates the medium criteria even while the live runner against
// `cat-cave/tanren-fixture-medium` is pending operator-setup.

import { describe, expect, it } from "vitest";
import {
  AcceptanceAssertionError,
  assertAcceptanceCriteria,
  type PersistedRunSnapshot
} from "../../../scripts/acceptance/common.js";

function mediumSnapshot(overrides: Partial<PersistedRunSnapshot> = {}): PersistedRunSnapshot {
  return {
    runId: "run_phase2_medium_synthetic",
    status: "done",
    outcome: "phase2_medium_complete",
    prUrl: "https://github.com/cat-cave/tanren-fixture-medium/pull/7",
    taskKinds: ["plan", "write", "check", "write", "check", "audit", "ci"],
    taskCounts: { plan: 1, write: 2, check: 2, audit: 1, ci: 1 },
    costBases: [
      { taskKind: "plan", basis: "unknown", billingMode: "subscription" },
      { taskKind: "write", basis: "unknown", billingMode: "subscription" },
      { taskKind: "check", basis: "unknown", billingMode: "subscription" },
      { taskKind: "write", basis: "unknown", billingMode: "subscription" },
      { taskKind: "check", basis: "unknown", billingMode: "subscription" },
      { taskKind: "audit", basis: "unknown", billingMode: "subscription" }
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
      "ci.passed"
    ],
    plannerRerequestedCount: 1,
    workspacePathHints: ["runner.allocated", "workspace.prepared"],
    ciStatus: "passed",
    ...overrides
  };
}

describe("phase2 acceptance — medium tier dry-run smoke", () => {
  it("passes when every medium-tier criterion is satisfied", () => {
    expect(() =>
      assertAcceptanceCriteria({
        tier: "medium",
        expectedOutcome: "phase2_medium_complete",
        snapshot: mediumSnapshot()
      })
    ).not.toThrow();
  });

  it("fails when the planner emitted fewer than 2 subtasks", () => {
    expect(() =>
      assertAcceptanceCriteria({
        tier: "medium",
        expectedOutcome: "phase2_medium_complete",
        snapshot: mediumSnapshot({
          taskKinds: ["plan", "write", "check", "audit", "ci"],
          taskCounts: { plan: 1, write: 1, check: 1, audit: 1, ci: 1 }
        })
      })
    ).toThrow(/≥ 2 write tasks/);
  });

  it("fails when the checker rejection loop never fired", () => {
    expect(() =>
      assertAcceptanceCriteria({
        tier: "medium",
        expectedOutcome: "phase2_medium_complete",
        snapshot: mediumSnapshot({
          plannerRerequestedCount: 0,
          events: mediumSnapshot().events.filter((name) => name !== "planner.rerequested")
        })
      })
    ).toThrow(/planner\.rerequested/);
  });

  it("fails when the planner cost record is missing", () => {
    expect(() =>
      assertAcceptanceCriteria({
        tier: "medium",
        expectedOutcome: "phase2_medium_complete",
        snapshot: mediumSnapshot({
          costBases: [
            { taskKind: "write", basis: "unknown", billingMode: "subscription" },
            { taskKind: "check", basis: "unknown", billingMode: "subscription" },
            { taskKind: "audit", basis: "unknown", billingMode: "subscription" }
          ]
        })
      })
    ).toThrow(/missing cost_records.*plan/);
  });

  it("fails when run.outcome is not phase2_medium_complete", () => {
    expect(() =>
      assertAcceptanceCriteria({
        tier: "medium",
        expectedOutcome: "phase2_medium_complete",
        snapshot: mediumSnapshot({ outcome: "retry_budget_exhausted" })
      })
    ).toThrow(AcceptanceAssertionError);
  });
});
