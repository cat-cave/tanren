// CostRecorder — the single entry point that turns a completed Codex (or
// other adapter) call into a persisted `cost_records` row attributed to one
// of the three v0 cost models (P2A-0011). The recorder is invoked at task
// completion. When attribution fails it raises CostUnattributableError so
// the task transitions to `failed` with failureKind="cost.unattributable"
// and the run halts. No row with a placeholder source ever lands.
import type pg from "pg";
import type { EventStore } from "../eventStore.js";
import {
  type AttributionInput,
  type CostSource,
  CostUnattributableError,
  type TokenCounts,
  computeCostUsd,
  resolveCostSource
} from "./sources.js";

type RecorderClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface CostRecordContext {
  runId: string;
  taskId: string;
  specId: string;
  projectId: string;
  cli: "codex" | "claude" | "opencode" | "fake";
  model: string;
  authRef: string;
  // Wall-clock runtime of the underlying call — required for
  // opportunity_computed attribution; ignored for the other two sources but
  // still recorded in cost_source_raw for audit.
  runtimeSeconds?: number;
  // Optional explicit override of the codexbar denominator. When omitted the
  // recorder reads the rolling 30-day estimate from
  // subscription_window_denominators and falls back to the conservative
  // theoretical default if no row exists yet.
  observedMaxMonthlyTokens?: number;
  tenantId?: string | null;
  userId?: string | null;
}

export interface RecordedCost {
  costSource: CostSource["source"];
  pricingMode: CostSource["pricingMode"];
  costUsd: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  provider: string;
  observedMaxMonthlyTokens?: number;
}

export class CostRecorder {
  constructor(
    private readonly pool: RecorderClient,
    private readonly eventStore: EventStore
  ) {}

  // record persists a single cost_records row and (for codexbar) refines the
  // subscription-window denominator. Throws CostUnattributableError when the
  // auth ref does not match any v0 rule; callers must surface that as a
  // task failure.
  async record(context: CostRecordContext, tokens: TokenCounts, rawUsage: Record<string, unknown>): Promise<RecordedCost> {
    let denominator = context.observedMaxMonthlyTokens;
    if (denominator === undefined && context.authRef.startsWith("credential/codex/")) {
      denominator = await this.readDenominator(context.authRef);
    }
    const attribution: AttributionInput = {
      cli: context.cli,
      authRef: context.authRef,
      rawUsage,
      runtimeSeconds: context.runtimeSeconds,
      observedMaxMonthlyTokens: denominator
    };
    let source: CostSource;
    try {
      source = resolveCostSource(attribution);
    } catch (error) {
      if (error instanceof CostUnattributableError) {
        await this.emitUnattributable(context, error, tokens);
      }
      throw error;
    }
    const costUsd = computeCostUsd(source, tokens);
    await this.pool.query(
      `INSERT INTO cost_records
       (task_id, run_id, project_id, cli, provider, model, input_tokens, output_tokens, cached_tokens,
        cost_usd, pricing_mode, cost_source, cost_source_raw, tenant_id, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15)`,
      [
        context.taskId,
        context.runId,
        context.projectId,
        context.cli,
        source.provider,
        context.model,
        tokens.inputTokens,
        tokens.outputTokens,
        tokens.cachedTokens,
        costUsd,
        source.pricingMode,
        source.source,
        JSON.stringify({
          authRef: context.authRef,
          runtimeSeconds: context.runtimeSeconds ?? null,
          source,
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
        pricingMode: source.pricingMode,
        costSource: source.source
      }
    });
    let refinedDenominator: number | undefined;
    if (source.source === "codexbar") {
      refinedDenominator = await this.refineDenominator(context.authRef, tokens);
    }
    return {
      costSource: source.source,
      pricingMode: source.pricingMode,
      costUsd,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cachedTokens: tokens.cachedTokens,
      provider: source.provider,
      observedMaxMonthlyTokens: refinedDenominator
    };
  }

  private async readDenominator(authRef: string): Promise<number | undefined> {
    const result = await this.pool.query<{ observed_max_monthly_tokens: number }>(
      `SELECT observed_max_monthly_tokens
       FROM subscription_window_denominators
       WHERE auth_ref = $1`,
      [authRef]
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    if (row.observed_max_monthly_tokens <= 0) {
      return undefined;
    }
    return row.observed_max_monthly_tokens;
  }

  // refineDenominator updates the rolling 30-day denominator using the sum
  // of input + output + cached tokens for every codexbar-attributed row at
  // this auth ref over the past 30 days, plus the brand-new row we just
  // wrote in the same transaction. We keep the running estimate above zero;
  // operators see the conservative theoretical default until at least one
  // window's history accumulates.
  private async refineDenominator(authRef: string, tokens: TokenCounts): Promise<number> {
    const result = await this.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(input_tokens + output_tokens + cached_tokens), 0)::text AS total
       FROM cost_records
       WHERE cost_source = 'codexbar'
         AND (cost_source_raw->>'authRef') = $1
         AND recorded_at >= NOW() - INTERVAL '30 days'`,
      [authRef]
    );
    const totalTokens = Number(result.rows[0]?.total ?? "0");
    const observed = Math.max(totalTokens, tokens.inputTokens + tokens.outputTokens + tokens.cachedTokens);
    await this.pool.query(
      `INSERT INTO subscription_window_denominators (auth_ref, observed_max_monthly_tokens, last_updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (auth_ref) DO UPDATE
         SET observed_max_monthly_tokens = EXCLUDED.observed_max_monthly_tokens,
             last_updated_at = EXCLUDED.last_updated_at`,
      [authRef, observed]
    );
    return observed;
  }

  private async emitUnattributable(
    context: CostRecordContext,
    error: CostUnattributableError,
    tokens: TokenCounts
  ): Promise<void> {
    await this.eventStore.append({
      runId: context.runId,
      taskId: context.taskId,
      specId: context.specId,
      projectId: context.projectId,
      eventType: "cost.unattributable",
      payload: {
        taskId: context.taskId,
        cli: context.cli,
        authRef: error.authRef,
        reason: error.reason,
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cachedTokens: tokens.cachedTokens
      }
    });
  }
}
