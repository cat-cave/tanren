// cost-recording helpers for the planner-feedback loop. Extracted
// out of subtaskLoop.ts so the orchestration file stays under the 500-line
// architecture cap. Every Answerer/Writer call in the loop runs through these
// helpers. Token accounting is MANDATORY for a real CLI call: a real call that
// records its cost with NO token telemetry is parser/adapter drift that would
// otherwise silently land as a zero-token, zero-notional row — so it is surfaced
// LOUDLY (`usage.token_accounting_failed`), NEVER conflated with a genuine
// zero-token call (a fake fixture). Dollar cost stays best-effort (NULL when
// unknown), so recording never fails the task for missing cost.
import type { CostRecorder } from "../costs/index.js";
import type { RealProviderCostCapturer } from "../costs/generationCostCapture.js";
import { emptyTokenUsage, type AnswererAdapter, type TokenUsage, type WriterAdapter } from "../providers/types.js";
import type { AppendEvent } from "./subtaskLoop.js";

// The agent role whose real call was found to carry no token telemetry — the
// `usage.token_accounting_failed` discriminant.
export type TokenAccountingRole = "planner" | "checker" | "auditor" | "writer" | "triage" | "convergence" | "demoRun";

// A narrow callback that emits the loud `usage.token_accounting_failed` event.
// Threaded from the loop (which owns the typed AppendEvent) so this helper stays
// free of an EventName import cycle. Absent on a path with no event sink (tests).
export type EmitTokenAccountingFailed = (input: {
  role: TokenAccountingRole;
  cli: string;
  model: string;
  taskId: string;
}) => Promise<void>;

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
  // The loud-event sink for a real CLI call missing token telemetry. Threaded
  // from the loop; absent ⇒ no sink (the recording still proceeds).
  emitTokenAccountingFailed?: EmitTokenAccountingFailed;
  // The loud-event sink for a MANAGED OpenRouter real-cost capture failure
  // (auth/transport/API). Threaded from the loop; absent ⇒ no sink.
  emitProviderCaptureFailed?: EmitProviderCaptureFailed;
}

// A narrow callback that emits the loud `cost.provider_capture_failed` event.
export type EmitProviderCaptureFailed = (input: {
  generationId: string;
  detail: string;
  taskId: string;
}) => Promise<void>;

// A REAL CLI (NOT a fake fixture). A "fake" cli is a test fixture whose zero-token
// usage is legitimate and stays quiet; any other cli is a real call whose missing
// telemetry is mandatory-accounting drift, surfaced LOUDLY.
function isRealCli(cli: string): boolean {
  return cli !== "fake";
}

// A REAL CLI call whose token telemetry is absent or all-zero — mandatory-accounting
// drift, distinct from a genuine zero-token call.
function isRealMissingTelemetry(cli: string, tokenUsage: TokenUsage | undefined): boolean {
  return isRealCli(cli) && (tokenUsage === undefined || tokenUsage.totalTokens <= 0);
}

// Resolve the REAL provider cost for a call when (a) a managed-run capturer is
// wired AND (b) the adapter surfaced an OpenRouter generation id on its token
// usage. Returns null when no capturer / no id — cost_usd then stays NULL
// (`unknown`), never a list-rate estimate (REAL SPEND IS A FACT). A capturer that
// returns a LOUD `{ failed }` (managed auth/transport/API miss) erases
// AUTHORITATIVE platform spend: emit `cost.provider_capture_failed` and record
// cost_usd null (no silent $0), rather than swallowing the failure.
async function captureRealProviderCostUsd(
  ctx: SubtaskCostContext,
  tokenUsage: TokenUsage | undefined,
  taskId: string,
): Promise<number | null> {
  const generationId = tokenUsage?.openRouterGenerationId;
  if (ctx.captureRealProviderCost === undefined || generationId === undefined) {
    return null;
  }
  const capture = await ctx.captureRealProviderCost(generationId);
  if ("failed" in capture) {
    await ctx.emitProviderCaptureFailed?.({
      generationId: capture.failed.generationId,
      detail: capture.failed.detail,
      taskId,
    });
    return null;
  }
  return capture.cost;
}

export interface AnswererCostInput<TOutput> {
  ctx: SubtaskCostContext;
  adapter: AnswererAdapter<TOutput>;
  // The answerer role whose call this records — the loud-event discriminant. Covers
  // the spec-loop redesign stages (triage/convergence/demoRun) alongside the original
  // planner/checker/auditor answerers (the writer records via recordWriterCost).
  role: Extract<TokenAccountingRole, "planner" | "checker" | "auditor" | "triage" | "convergence" | "demoRun">;
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
// call sites. Today's answerer adapters do not surface a token breakdown, so a
// REAL answerer call records zero tokens — which is mandatory-accounting drift,
// NOT a genuine zero-token call. We record the row (cost stays best-effort NULL)
// AND emit the loud `usage.token_accounting_failed` so the systematic
// zero-token-answerer gap is visible rather than silently accepted. A `fake`
// fixture is legitimately zero and stays quiet.
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
  // An answerer surfaces no telemetry today → emptyTokenUsage → loud for a real CLI.
  if (isRealCli(input.adapter.cli)) {
    await input.ctx.emitTokenAccountingFailed?.({
      role: input.role,
      cli: input.adapter.cli,
      model: input.model,
      taskId: input.taskId,
    });
  }
}

export async function recordWriterCost(input: WriterCostInput): Promise<void> {
  const tokens = input.tokenUsage ?? emptyTokenUsage;
  // MANAGED OpenRouter run: query the REAL `usage.cost` for this call's generation
  // id so cost_usd is a metered FACT (`provider_response`). null on BYOK / no id.
  const realProviderCostUsd = await captureRealProviderCostUsd(input.ctx, input.tokenUsage, input.taskId);
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
  // A REAL writer call missing token telemetry (parser drift) looks like a
  // zero-token call — surface it LOUDLY, distinct from a genuine zero-token call.
  if (isRealMissingTelemetry(input.adapter.cli, input.tokenUsage)) {
    await input.ctx.emitTokenAccountingFailed?.({
      role: "writer",
      cli: input.adapter.cli,
      model: "tanren-writer",
      taskId: input.taskId,
    });
  }
}

export function secondsSince(startedAtMs: number): number {
  const elapsed = (Date.now() - startedAtMs) / 1000;
  return elapsed > 0 ? elapsed : 0.001;
}

// buildSubtaskCostContext assembles the SubtaskCostContext for a run, wiring the
// two LOUD discriminated-failure event sinks over the loop's typed appendEvent:
// `usage.token_accounting_failed` (a real CLI call with no token telemetry) and
// `cost.provider_capture_failed` (a managed OpenRouter real-cost capture failure).
// Extracted from subtaskLoop.ts to keep that orchestration file under the 500-line
// cap; the appendEvent type is imported type-only (no runtime import cycle).
export function buildSubtaskCostContext(
  core: {
    recorder: CostRecorder;
    runId: string;
    specId: string;
    projectId: string;
    captureRealProviderCost?: RealProviderCostCapturer;
  },
  appendEvent: AppendEvent,
): SubtaskCostContext {
  return {
    recorder: core.recorder,
    runId: core.runId,
    specId: core.specId,
    projectId: core.projectId,
    ...(core.captureRealProviderCost !== undefined && { captureRealProviderCost: core.captureRealProviderCost }),
    emitTokenAccountingFailed: async ({ role, cli, model, taskId }) => {
      await appendEvent(
        "usage.token_accounting_failed",
        {
          role,
          cli,
          model,
          reason:
            "a real CLI call recorded its cost with no token telemetry; token accounting is mandatory, so this is surfaced loudly rather than as a silent zero-token call",
        },
        taskId,
      );
    },
    emitProviderCaptureFailed: async ({ generationId, detail, taskId }) => {
      await appendEvent(
        "cost.provider_capture_failed",
        {
          generationId,
          detail,
          reason:
            "the managed OpenRouter per-call real-cost query failed; authoritative platform spend could not be captured, so it is surfaced loudly rather than silently recorded as $0",
        },
        taskId,
      );
    },
  };
}
