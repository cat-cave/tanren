// P2A-0015 dry-run smoke for the easy-tier acceptance assertions.
//
// The live `just acceptance-easy` recipe is local-only (real Codex, real
// GitHub PR). This test exercises the persisted-state assertion module
// against synthetic completed-run snapshots so CI gates the criteria
// without ever calling out to Codex or GitHub.
//
// We verify both the positive (all criteria pass) and the negative
// (each criterion fails with a clear error) paths so a regression in
// scripts/acceptance/common.ts is caught at the same level as a missing
// PR URL or a stranded cost row would be in a live run.

import { describe, expect, it } from "vitest";
import {
  AcceptanceAssertionError,
  assertAcceptanceCriteria,
  type PersistedRunSnapshot,
} from "../../../scripts/acceptance/common.js";

function easySnapshot(overrides: Partial<PersistedRunSnapshot> = {}): PersistedRunSnapshot {
  return {
    runId: "run_phase2_easy_synthetic",
    status: "done",
    outcome: "phase2_easy_complete",
    prUrl: "https://github.com/cat-cave/tanren-fixture-easy/pull/123",
    taskKinds: ["plan", "write", "check", "audit", "ci"],
    taskCounts: { plan: 1, write: 1, check: 1, audit: 1, ci: 1 },
    costBases: [
      { taskKind: "write", basis: "unknown", billingMode: "subscription" },
      { taskKind: "check", basis: "unknown", billingMode: "subscription" },
      { taskKind: "audit", basis: "unknown", billingMode: "subscription" },
    ],
    events: [
      "phase1.fixture.started",
      "runner.allocated",
      "workspace.prepared",
      "writer.completed",
      "checker.completed",
      "auditor.completed",
      "github.pr.created",
      "ci.passed",
      "phase1.fixture.completed",
    ],
    plannerRerequestedCount: 0,
    workspacePathHints: ["runner.allocated", "workspace.prepared"],
    ciStatus: "passed",
    ...overrides,
  };
}

describe("phase2 acceptance — easy tier dry-run smoke", () => {
  it("passes when every easy-tier criterion is satisfied", () => {
    expect(() =>
      assertAcceptanceCriteria({
        tier: "easy",
        expectedOutcome: "phase2_easy_complete",
        snapshot: easySnapshot(),
      }),
    ).not.toThrow();
  });

  it("fails when run.outcome is not phase2_easy_complete", () => {
    expect(() =>
      assertAcceptanceCriteria({
        tier: "easy",
        expectedOutcome: "phase2_easy_complete",
        snapshot: easySnapshot({ outcome: "phase1_fixture_complete" }),
      }),
    ).toThrow(AcceptanceAssertionError);
  });

  it("fails when pr_url is null or malformed", () => {
    expect(() =>
      assertAcceptanceCriteria({
        tier: "easy",
        expectedOutcome: "phase2_easy_complete",
        snapshot: easySnapshot({ prUrl: null }),
      }),
    ).toThrow(/pr_url/u);

    expect(() =>
      assertAcceptanceCriteria({
        tier: "easy",
        expectedOutcome: "phase2_easy_complete",
        snapshot: easySnapshot({ prUrl: "not-a-url" }),
      }),
    ).toThrow(/pr_url/u);
  });

  it("fails when CI did not pass", () => {
    expect(() =>
      assertAcceptanceCriteria({
        tier: "easy",
        expectedOutcome: "phase2_easy_complete",
        snapshot: easySnapshot({ ciStatus: "failed" }),
      }),
    ).toThrow(/ci\.passed/u);
  });

  it("fails when writer/checker/auditor cost records are missing", () => {
    expect(() =>
      assertAcceptanceCriteria({
        tier: "easy",
        expectedOutcome: "phase2_easy_complete",
        snapshot: easySnapshot({
          costBases: [{ taskKind: "write", basis: "unknown", billingMode: "subscription" }],
        }),
      }),
    ).toThrow(/cost_records/u);
  });

  it("accepts 'unknown' cost basis (cost is best-effort)", () => {
    expect(() =>
      assertAcceptanceCriteria({
        tier: "easy",
        expectedOutcome: "phase2_easy_complete",
        snapshot: easySnapshot({
          costBases: [
            { taskKind: "write", basis: "provider_pricing", billingMode: "per_token" },
            { taskKind: "check", basis: "unknown", billingMode: "subscription" },
            { taskKind: "audit", basis: "unknown", billingMode: "self_hosted" },
          ],
        }),
      }),
    ).not.toThrow();
  });

  it("rejects cost rows missing a billing_mode", () => {
    expect(() =>
      assertAcceptanceCriteria({
        tier: "easy",
        expectedOutcome: "phase2_easy_complete",
        snapshot: easySnapshot({
          costBases: [
            { taskKind: "write", basis: "unknown", billingMode: "subscription" },
            { taskKind: "check", basis: "unknown", billingMode: "subscription" },
            { taskKind: "audit", basis: "unknown", billingMode: "" },
          ],
        }),
      }),
    ).toThrow(/billing_mode/u);
  });
});
