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
  cli: "codex" | "claude" | "opencode" | "aider" | "pi" | "reasonix" | "fake";
  model: string;
  authRef: string;
  // Wall-clock runtime of the underlying call — recorded in cost_source_raw
  // for audit; no longer used to fabricate a dollar figure.
  runtimeSeconds?: number;
  // Real per-call dollar figure derived from ccusage (apportioned by token
  // share against the run-level ccusage total). Positive → cost_basis becomes
  // 'ccusage'. Usually null at first write: the run-level total is only known
  // once every call has run, so the loop back-fills via
  // reconcileRunCostFromCcusage at run end.
  ccusageCostUsd?: number | null;
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
    private readonly eventStore: EventStore,
  ) {}

  // record persists a single cost_records row with the full typed token
  // breakdown and a possibly-null dollar figure. It never throws for an
  // unattributable ref — cost-unknown is an allowed state.
  async record(
    context: CostRecordContext,
    tokens: TokenUsage,
    rawUsage: Record<string, unknown>,
  ): Promise<RecordedCost> {
    const attribution: AttributionInput = {
      cli: context.cli,
      authRef: context.authRef,
      ccusageCostUsd: context.ccusageCostUsd ?? null,
      rawUsage,
    };
    const source = resolveCostSource(attribution);
    const costUsd = computeCostUsd(source, tokens);
    await this.pool.query(
      // org_id is the mandatory tenant-isolation key (tanren tenancy hardening).
      // It is derived in-statement from the parent run so every cost row carries
      // its org directly rather than via a project_id → projects.org_id hop.
      `INSERT INTO cost_records
       (task_id, run_id, project_id, org_id, cli, provider, model,
        input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens, reasoning_output_tokens, total_tokens,
        cost_usd, billing_mode, cost_basis, cost_source_raw, user_id)
       VALUES ($1, $2, $3, (SELECT org_id FROM runs WHERE run_id = $2), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17)`,
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
          rawUsage,
        }),
        context.userId ?? null,
      ],
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
        costBasis: source.costBasis,
      },
    });
    return {
      billingMode: source.billingMode,
      costBasis: source.costBasis,
      costUsd,
      tokens,
      provider: source.provider,
    };
  }

  // reconcileRunCostFromCcusage back-fills the REAL ccusage dollar figure for a
  // run. ccusage reports run-cumulative cost (against the isolated per-run
  // CODEX_HOME), so we apportion it across the run's cost_records rows by
  // total-token share — the rows then sum to the real ccusage total. A
  // zero/absent cost (e.g. a pure subscription window with no computed dollars)
  // is a no-op: cost-unknown stays an honest NULL. Returns rows repriced.
  async reconcileRunCostFromCcusage(runId: string, ccusageCostUsd: number): Promise<{ updated: number }> {
    return this.apportionRunCost(runId, ccusageCostUsd, "ccusage");
  }

  // reconcileRunCostFromCredits back-fills the REAL marginal dollar cost of a
  // run from prepaid-credit drawdown. Within-window subscription usage draws no
  // credits, so a positive consumed-credits delta IS the run's true marginal
  // spend (PROJECT_BRIEF §4) — it takes precedence over notional ccusage
  // token-pricing for subscription overage. dollars = creditsConsumed × rate,
  // apportioned across the run's rows by token share (cost_basis='credits').
  async reconcileRunCostFromCredits(
    runId: string,
    creditsConsumed: number,
    creditUsdRate: number,
  ): Promise<{ updated: number }> {
    if (
      !(Number.isFinite(creditsConsumed) && creditsConsumed > 0 && Number.isFinite(creditUsdRate) && creditUsdRate > 0)
    ) {
      return { updated: 0 };
    }
    return this.apportionRunCost(runId, creditsConsumed * creditUsdRate, "credits");
  }

  // Apportions a run-level dollar total across the run's cost_records rows by
  // total-token share so the rows sum to the total, stamping each with `basis`.
  private async apportionRunCost(
    runId: string,
    totalCostUsd: number,
    basis: "ccusage" | "credits",
  ): Promise<{ updated: number }> {
    if (!(Number.isFinite(totalCostUsd) && totalCostUsd > 0)) {
      return { updated: 0 };
    }
    const rows = await this.pool.query<{ id: string; total_tokens: number }>(
      "SELECT id, total_tokens FROM cost_records WHERE run_id = $1",
      [runId],
    );
    const totalTokens = rows.rows.reduce((sum, row) => sum + Number(row.total_tokens), 0);
    if (totalTokens <= 0) {
      return { updated: 0 };
    }
    let updated = 0;
    for (const row of rows.rows) {
      const share = Number(row.total_tokens) / totalTokens;
      const costUsd = (totalCostUsd * share).toFixed(6);
      await this.pool.query("UPDATE cost_records SET cost_usd = $2, cost_basis = $3 WHERE id = $1", [
        row.id,
        costUsd,
        basis,
      ]);
      updated += 1;
    }
    return { updated };
  }
}
