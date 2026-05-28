// CostRecorder — the single entry point that turns a completed Codex (or
// other adapter) call into a persisted `cost_records` row.
//
// Token accounting is MANDATORY: every real CLI call records the full typed
// TokenUsage breakdown. Cost in dollars is BEST-EFFORT: when no reliable cost
// basis exists (subscription / self-hosted / unpriced model) the recorder
// writes cost_usd = NULL with cost_basis = 'unknown' and does NOT fail the
// task or halt the run. There is no fake estimate and no denominator
// machinery — subscription windows are percent-of-window limits, not token
// budgets.
import type pg from "pg";
import type { TokenUsage } from "../providers/types.js";
import type { EventStore } from "../eventStore.js";
import { type AttributionInput, type CostSource, computeCostUsd, resolveCostSource } from "./sources.js";

type RecorderClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface CostRecordContext {
  runId: string;
  taskId: string;
  specId: string;
  projectId: string;
  cli: "codex" | "claude" | "opencode" | "fake";
  model: string;
  authRef: string;
  // Wall-clock runtime of the underlying call — recorded in cost_source_raw
  // for audit; no longer used to fabricate a dollar figure.
  runtimeSeconds?: number;
  tenantId?: string | null;
  userId?: string | null;
}

export interface RecordedCost {
  billingMode: CostSource["billingMode"];
  costBasis: CostSource["costBasis"];
  costUsd: string | null;
  tokens: TokenUsage;
  provider: string;
}

export class CostRecorder {
  constructor(
    private readonly pool: RecorderClient,
    private readonly eventStore: EventStore
  ) {}

  // record persists a single cost_records row with the full typed token
  // breakdown and a possibly-null dollar figure. It never throws for an
  // unattributable ref — cost-unknown is an allowed state.
  async record(context: CostRecordContext, tokens: TokenUsage, rawUsage: Record<string, unknown>): Promise<RecordedCost> {
    const attribution: AttributionInput = {
      cli: context.cli,
      authRef: context.authRef,
      rawUsage
    };
    const source = resolveCostSource(attribution);
    const costUsd = computeCostUsd(source, tokens);
    await this.pool.query(
      `INSERT INTO cost_records
       (task_id, run_id, project_id, cli, provider, model,
        input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens, reasoning_output_tokens, total_tokens,
        cost_usd, billing_mode, cost_basis, cost_source_raw, tenant_id, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18)`,
      [
        context.taskId,
        context.runId,
        context.projectId,
        context.cli,
        source.provider,
        context.model,
        tokens.inputTokens,
        tokens.cachedInputTokens,
        tokens.cacheCreationTokens,
        tokens.outputTokens,
        tokens.reasoningOutputTokens,
        tokens.totalTokens,
        costUsd,
        source.billingMode,
        source.costBasis,
        JSON.stringify({
          authRef: context.authRef,
          runtimeSeconds: context.runtimeSeconds ?? null,
          billingMode: source.billingMode,
          costBasis: source.costBasis,
          provider: source.provider,
          rawUsage
        }),
        context.tenantId ?? null,
        context.userId ?? null
      ]
    );
    await this.eventStore.append({
      runId: context.runId,
      taskId: context.taskId,
      specId: context.specId,
      projectId: context.projectId,
      eventType: "cost.resolved",
      payload: {
        taskId: context.taskId,
        cli: context.cli,
        provider: source.provider,
        model: context.model,
        costUsd,
        billingMode: source.billingMode,
        costBasis: source.costBasis
      }
    });
    return {
      billingMode: source.billingMode,
      costBasis: source.costBasis,
      costUsd,
      tokens,
      provider: source.provider
    };
  }
}
