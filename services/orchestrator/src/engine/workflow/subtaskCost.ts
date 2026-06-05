// cost-recording helpers for the planner-feedback loop. Extracted
// out of subtaskLoop.ts so the orchestration file stays under the 500-line
// architecture cap. Every Answerer/Writer call in the loop runs through these
// helpers. Token accounting is mandatory; cost is best-effort (NULL when
// unknown), so recording never fails the task for missing cost.
import type { CostRecorder } from "../costs/index.js";
import type { RealProviderCostCapturer } from "../costs/generationCostCapture.js";
import { emptyTokenUsage, type AnswererAdapter, type TokenUsage, type WriterAdapter } from "../providers/types.js";

export interface SubtaskCostContext {
  recorder: CostRecorder;
  runId: string;
  specId: string;
  projectId: string;
  // MANAGED-run real-cost capture: given the OpenRouter generation id a managed
  // adapter surfaced (TokenUsage.openRouterGenerationId), resolve the REAL platform
  // `usage.cost` so cost_usd is recorded as a metered FACT (`provider_response`).
  // Absent on a BYOK / non-managed run → no capture → cost_usd NULL (no estimate).
  captureRealProviderCost?: RealProviderCostCapturer;
}

// Resolve the REAL provider cost for a call when (a) a managed-run capturer is
// wired AND (b) the adapter surfaced an OpenRouter generation id on its token
// usage. Returns null otherwise — cost_usd then stays NULL (`unknown`), never a
// list-rate estimate (REAL SPEND IS A FACT).
async function captureRealProviderCostUsd(
  ctx: SubtaskCostContext,
  tokenUsage: TokenUsage | undefined,
): Promise<number | null> {
  const generationId = tokenUsage?.openRouterGenerationId;
  if (ctx.captureRealProviderCost === undefined || generationId === undefined) {
    return null;
  }
  return ctx.captureRealProviderCost(generationId);
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
  // MANAGED OpenRouter run: query the REAL `usage.cost` for this call's generation
  // id so cost_usd is a metered FACT (`provider_response`). null on BYOK / no id.
  const realProviderCostUsd = await captureRealProviderCostUsd(input.ctx, input.tokenUsage);
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
      realProviderCostUsd,
    },
    tokens,
    input.rawUsage,
  );
}

export function secondsSince(startedAtMs: number): number {
  const elapsed = (Date.now() - startedAtMs) / 1000;
  return elapsed > 0 ? elapsed : 0.001;
}
