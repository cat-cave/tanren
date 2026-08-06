import { describe, expect, it } from "vitest";
import type { CostRecorder } from "../src/engine/costs/index.js";
import { JsonlObjectDecodeError } from "../src/engine/providers/findTokenUsage.js";
import { runPlannerStage } from "../src/engine/workflow/subtaskStages.js";
import type { SubtaskCostContext } from "../src/engine/workflow/subtaskCost.js";
import { InMemoryRunStateWriter } from "./fixtures/inMemoryRunStateWriter.js";

describe("planner JSONL failure accounting", () => {
  it("preserves buildUsage metadata and provider usage on malformed streams", async () => {
    const tokenUsage = {
      inputTokens: 7,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 4,
      reasoningOutputTokens: 0,
      totalTokens: 11,
    };
    const decodeError = new JsonlObjectDecodeError(
      "fake",
      {
        kind: "jsonl_object_decode_failed",
        failures: [{ lineNumber: 2, reason: "invalid_json" }],
      },
      tokenUsage,
    );
    const adapter = {
      kind: "answerer" as const,
      cli: "fake" as const,
      authRef: "credential/self-hosted/tanren-fake",
      lastTokenUsage: () => tokenUsage,
      async runAnswerer() {
        throw decodeError;
      },
    };
    const writer = new InMemoryRunStateWriter({ forwardAppend: async () => {} });
    const costs: Array<{ tokenUsage: Record<string, unknown>; rawUsage: Record<string, unknown> }> = [];
    const costCtx: SubtaskCostContext = {
      recorder: {
        record: async (_context, recordedUsage, rawUsage) => {
          costs.push({ tokenUsage: recordedUsage, rawUsage });
          return undefined as never;
        },
      } as unknown as CostRecorder,
      runId: "run_1",
      specId: "spec_1",
      projectId: "project_1",
      orgId: "org_1",
    };

    await expect(
      runPlannerStage({
        pool: { query: async () => ({ rows: [], rowCount: 1 }) },
        writer,
        costCtx,
        adapter,
        spec: {
          specTitle: "S",
          specDescription: "D",
          acceptanceCriteria: ["AC1"],
          behaviorIds: [],
          behaviorContext: [],
        },
        runId: "run_1",
        workspacePath: "/ws",
        plannerTaskId: "task_plan",
        appendEvent: async () => {},
        attempt: 5,
        rejectionHistory: [],
        buildUsage: ({ plannerTaskId, attempt }) => ({ custom: "planner-failure", plannerTaskId, attempt }),
      }),
    ).rejects.toBe(decodeError);

    expect(costs).toEqual([
      {
        tokenUsage,
        rawUsage: { custom: "planner-failure", plannerTaskId: "task_plan", attempt: 5 },
      },
    ]);
  });
});
