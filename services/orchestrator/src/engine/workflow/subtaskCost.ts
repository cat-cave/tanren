// P2A-0012: cost-recording helpers for the planner-feedback loop. Extracted
// out of subtaskLoop.ts so the orchestration file stays under the 500-line
// architecture cap. Every Answerer/Writer call in the loop runs through these
// helpers. Token accounting is mandatory; cost is best-effort (NULL when
// unknown), so recording never fails the task for missing cost.
import type { CostRecorder } from "../costs/index.js";
import { emptyTokenUsage, type AnswererAdapter, type TokenUsage, type WriterAdapter } from "../providers/types.js";

export interface SubtaskCostContext {
  recorder: CostRecorder;
  runId: string;
  specId: string;
  projectId: string;
}

export interface AnswererCostInput<TOutput> {
  ctx: SubtaskCostContext;
  adapter: AnswererAdapter<TOutput>;
  taskId: string;
  model: string;
  runtimeSeconds: number;
  rawUsage: Record<string, unknown>;
}

export interface WriterCostInput {
  ctx: SubtaskCostContext;
  adapter: WriterAdapter;
  taskId: string;
  runtimeSeconds: number;
  tokenUsage: TokenUsage | undefined;
  rawUsage: Record<string, unknown>;
}

// recordAnswererCost wraps the CostRecorder for the planner/checker/auditor
// call sites. Answerer adapters do not surface a token breakdown, so the
// audit row carries zero tokens; cost is recorded best-effort (NULL when the
// ref has no per-token price basis).
export async function recordAnswererCost<TOutput>(input: AnswererCostInput<TOutput>): Promise<void> {
  await input.ctx.recorder.record(
    {
      runId: input.ctx.runId,
      taskId: input.taskId,
      specId: input.ctx.specId,
      projectId: input.ctx.projectId,
      cli: input.adapter.cli,
      model: input.model,
      authRef: input.adapter.authRef,
      runtimeSeconds: input.runtimeSeconds,
    },
    emptyTokenUsage,
    input.rawUsage,
  );
}

export async function recordWriterCost(input: WriterCostInput): Promise<void> {
  const tokens = input.tokenUsage ?? emptyTokenUsage;
  await input.ctx.recorder.record(
    {
      runId: input.ctx.runId,
      taskId: input.taskId,
      specId: input.ctx.specId,
      projectId: input.ctx.projectId,
      cli: input.adapter.cli,
      model: "tanren-writer",
      authRef: input.adapter.authRef,
      runtimeSeconds: input.runtimeSeconds,
    },
    tokens,
    input.rawUsage,
  );
}

export function secondsSince(startedAtMs: number): number {
  const elapsed = (Date.now() - startedAtMs) / 1000;
  return elapsed > 0 ? elapsed : 0.001;
}
