import { describe, expect, it, vi } from "vitest";
import type { QueryClient } from "../src/engine/data/orgScopedDb.js";
import type { BehaviorVerdictOutcome } from "../src/engine/contracts/runtimeVerification.js";
import {
  BEHAVIOR_CI_SUITE,
  behaviorAttemptTestId,
  mapBehaviorOutcomeToCiOutcome,
  projectBehaviorAttempts,
  projectBehaviorAttemptToCiTestResult,
  type BehaviorAttemptProjectionInput,
} from "../src/engine/runtimeVerification/behaviorCiProjection.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** A fake org-scoped data-plane client that records every INSERT it is handed (no pg). */
function recordingClient(): { client: QueryClient; calls: RecordedQuery[] } {
  const calls: RecordedQuery[] = [];
  const client = {
    query: vi.fn(async (text: string, values: readonly unknown[]) => {
      calls.push({ text, values });
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as QueryClient;
  return { client, calls };
}

const SCOPE = { orgId: "org-1", projectId: "proj-1" } as const;

function attempt(overrides: Partial<BehaviorAttemptProjectionInput> = {}): BehaviorAttemptProjectionInput {
  return {
    behaviorRevisionId: "brev-1",
    exampleHash: "ex-abc",
    matrixHash: "mx-123",
    outcome: "passed",
    workflowRunId: "run-1",
    headSha: "a".repeat(40),
    attempt: 1,
    startedAt: "2026-07-16T00:00:00.000Z",
    finishedAt: "2026-07-16T00:00:02.500Z",
    ...overrides,
  };
}

// The `ci_test_results` column order this projection reuses from `ingestJunitResults`.
const COL = {
  id: 0,
  projectId: 1,
  orgId: 2,
  testId: 3,
  file: 4,
  suite: 5,
  headSha: 6,
  runId: 7,
  attempt: 8,
  outcome: 9,
  durationMs: 10,
  retries: 11,
} as const;

describe("behaviorAttemptTestId", () => {
  it("builds the composite behavior:<rev>:<example>:<matrix> identity", () => {
    expect(behaviorAttemptTestId({ behaviorRevisionId: "brev-9", exampleHash: "ex-x", matrixHash: "mx-y" })).toBe(
      "behavior:brev-9:ex-x:mx-y",
    );
  });
});

describe("mapBehaviorOutcomeToCiOutcome", () => {
  it("maps each RBV outcome onto the passed|failed|error|skipped check vocabulary", () => {
    const cases: ReadonlyArray<[BehaviorVerdictOutcome, "passed" | "failed" | "error" | "skipped"]> = [
      ["passed", "passed"],
      ["failed_product", "failed"],
      ["failed_verification_contract", "failed"],
      ["failed_visual", "failed"],
      ["inconclusive_infrastructure", "error"],
      ["inconclusive_external", "error"],
      ["cancelled_superseded", "skipped"],
    ];
    for (const [outcome, expected] of cases) {
      expect(mapBehaviorOutcomeToCiOutcome(outcome)).toBe(expected);
    }
  });

  it("NEGATIVE CONTROL — only a genuinely passed attempt maps to passed (unexercisable ⇒ never green)", () => {
    const nonPassed: readonly BehaviorVerdictOutcome[] = [
      "failed_product",
      "failed_verification_contract",
      "failed_visual",
      "inconclusive_infrastructure",
      "inconclusive_external",
      "cancelled_superseded",
    ];
    for (const outcome of nonPassed) {
      expect(mapBehaviorOutcomeToCiOutcome(outcome)).not.toBe("passed");
    }
  });
});

describe("projectBehaviorAttemptToCiTestResult", () => {
  it("inserts ONE ci_test_results row with the composite behavior identity + reused column contract", async () => {
    const { client, calls } = recordingClient();
    const result = await projectBehaviorAttemptToCiTestResult(client, SCOPE, attempt());

    expect(calls).toHaveLength(1);
    const { text, values } = calls[0]!;
    expect(text).toContain("INSERT INTO ci_test_results");
    expect(text).toContain(
      "(id, project_id, org_id, test_id, file, suite, head_sha, run_id, attempt, outcome, duration_ms, retries, observed_at)",
    );
    expect(values[COL.projectId]).toBe("proj-1");
    expect(values[COL.orgId]).toBe("org-1");
    expect(values[COL.testId]).toBe("behavior:brev-1:ex-abc:mx-123");
    expect(result.testId).toBe("behavior:brev-1:ex-abc:mx-123");
    expect(values[COL.file]).toBeNull();
    expect(values[COL.suite]).toBe(BEHAVIOR_CI_SUITE);
    expect(values[COL.headSha]).toBe("a".repeat(40));
    expect(values[COL.runId]).toBe("run-1");
    expect(values[COL.attempt]).toBe(1);
    expect(values[COL.outcome]).toBe("passed");
    expect(values[COL.durationMs]).toBe(2500);
    expect(values[COL.retries]).toBe(0);
  });

  it("emits duration null when the attempt never finished", async () => {
    const { client, calls } = recordingClient();
    await projectBehaviorAttemptToCiTestResult(client, SCOPE, attempt({ finishedAt: undefined }));
    expect(calls[0]!.values[COL.durationMs]).toBeNull();
  });

  it("projects an unexercisable (inconclusive) attempt as an error row, not a passed row", async () => {
    const { client, calls } = recordingClient();
    const result = await projectBehaviorAttemptToCiTestResult(
      client,
      SCOPE,
      attempt({ outcome: "inconclusive_infrastructure" }),
    );
    expect(result.outcome).toBe("error");
    expect(calls[0]!.values[COL.outcome]).toBe("error");
    expect(calls[0]!.values[COL.outcome]).not.toBe("passed");
  });
});

describe("projectBehaviorAttempts (batch)", () => {
  it("POSITIVE — a run with N executed attempts yields N ci_test_results rows with behavior:... ids", async () => {
    const { client, calls } = recordingClient();
    const inputs = [
      attempt({ behaviorRevisionId: "brev-1", attempt: 1, outcome: "failed_product" }),
      attempt({ behaviorRevisionId: "brev-1", attempt: 2, outcome: "passed" }),
      attempt({ behaviorRevisionId: "brev-2", matrixHash: "mx-z", outcome: "passed" }),
    ];
    const result = await projectBehaviorAttempts(client, SCOPE, inputs);

    expect(result.inserted).toBe(3);
    expect(calls).toHaveLength(3);
    for (const row of result.rows) {
      expect(row.testId.startsWith("behavior:")).toBe(true);
    }
    // Every projected test_id carries the behavior: prefix — directly disproving ci_test_results=0.
    expect(calls.every((c) => String(c.values[COL.testId]).startsWith("behavior:"))).toBe(true);
    // Distinct attempt ordinals preserved for same-run flaky detection.
    expect(calls[0]!.values[COL.attempt]).toBe(1);
    expect(calls[1]!.values[COL.attempt]).toBe(2);
  });

  it("NEGATIVE CONTROL — a run with zero executed attempts inserts ZERO rows (no fabricated green rows)", async () => {
    const { client, calls } = recordingClient();
    const result = await projectBehaviorAttempts(client, SCOPE, []);
    expect(result.inserted).toBe(0);
    expect(result.rows).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
