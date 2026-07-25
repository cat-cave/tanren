import { expect } from "vitest";
import type { PlanAnswer } from "../../src/engine/answerers/schemas/index.js";
import type { RunStateWriter, UpdateTaskWithEventInput } from "../../src/engine/contracts/runStateWriter.js";
import type { CostRecorder } from "../../src/engine/costs/index.js";
import type { TokenUsage, AnswererAdapter } from "../../src/engine/providers/types.js";
import { JsonlObjectDecodeError } from "../../src/engine/providers/findTokenUsage.js";
import { runPlannerStage } from "../../src/engine/workflow/subtaskStages.js";
export async function runMalformedPlanner(adapter: AnswererAdapter<PlanAnswer>) {
  const costs: TokenUsage[] = [];
  const terminals: UpdateTaskWithEventInput[] = [];
  const recorder = {
    record: (_context: unknown, usage: TokenUsage) => {
      costs.push(usage);
      return Promise.resolve({});
    },
  } as unknown as CostRecorder;
  const writer = {
    updateTaskWithEvent: (input: UpdateTaskWithEventInput) => {
      terminals.push(input);
      return Promise.resolve({ alreadyTerminal: false });
    },
  } as unknown as RunStateWriter;
  const thrown = await runPlannerStage({
    pool: { query: () => Promise.resolve({ rows: [], rowCount: 0 }) },
    writer,
    costCtx: { recorder, runId: "run_jsonl", specId: "spec_jsonl", projectId: "project_jsonl", orgId: "org_jsonl" },
    adapter,
    spec: {
      specTitle: "JSONL negative",
      specDescription: "Reject malformed provider records",
      acceptanceCriteria: ["malformed JSONL fails closed"],
      behaviorIds: [],
      behaviorContext: [],
    },
    runId: "run_jsonl",
    workspacePath: "/workspace",
    plannerTaskId: "task_jsonl",
    appendEvent: () => Promise.resolve(),
    attempt: 1,
    rejectionHistory: [],
  }).then(
    () => null,
    (error: unknown) => error,
  );
  return { costs, terminals, thrown };
}
export function expectMalformedPlanner(
  observed: Awaited<ReturnType<typeof runMalformedPlanner>>,
  secret: string,
): void {
  expect(observed.thrown).toBeInstanceOf(JsonlObjectDecodeError);
  expect(observed.costs).toHaveLength(1);
  expect(observed.costs[0]).toMatchObject({ inputTokens: 7, outputTokens: 4, totalTokens: 11 });
  expect(observed.terminals).toHaveLength(1);
  expect(observed.terminals[0]?.event.payload).toMatchObject({
    taskKind: "plan",
    failureKind: "jsonl_object_decode_failed",
    jsonlDecodeFailure: {
      kind: "jsonl_object_decode_failed",
      failures: [{ lineNumber: 2, reason: "invalid_json" }],
    },
  });
  expect(JSON.stringify(observed.terminals)).not.toContain(secret);
}
