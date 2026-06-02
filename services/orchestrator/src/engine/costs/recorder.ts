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
import { isPool, resolveWritableClient, withJobOrgScope, type QueryClient } from "../data/orgScopedDb.js";
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

/**
 * Plane-split P3: a persistence override for {@link CostRecorder.record}. When
 * supplied, `record` delegates the cost_records INSERT (+ its `cost.resolved`
 * event) to this function instead of writing in-process — so the run worker can
 * route the cost write through the control-plane endpoint (`HttpRunStateWriter`)
 * while keeping ONE record shape. The default `DirectRunStateWriter` delegate
 * calls a plain (override-free) recorder, so the persisted row is identical.
 */
export type CostPersist = (input: {
  context: CostRecordContext;
  tokens: TokenUsage;
  rawUsage: Record<string, unknown>;
}) => Promise<RecordedCost>;

/**
 * Plane-split P3c: a reconcile override for the recorder's run-end
 * apportion/back-fill. When supplied, `reconcileRunCostFromCcusage` /
 * `reconcileRunCostFromCredits` delegate the apportioning `cost_records`
 * SELECT+UPDATEs (which the data plane may no longer perform directly —
 * migration 0031 dropped its `cost_records` write grant) to this function
 * instead of writing in-process, so the worker routes them through the
 * control-plane endpoint (`HttpRunStateWriter`). The recorder still resolves the
 * dollar total + basis (the credit/ccusage precedence stays here); only the
 * write moves. The default in-process path is byte-identical.
 */
export type CostReconcile = (input: {
  runId: string;
  totalCostUsd: number;
  basis: "ccusage" | "credits";
}) => Promise<{ updated: number }>;

export class CostRecorder {
  constructor(
    private readonly pool: RecorderClient,
    private readonly eventStore: EventStore,
    // Plane-split P3: optional remote-write delegate. When set, `record` routes
    // the persist through it (the control-plane endpoint) rather than the
    // in-process INSERT below.
    private readonly persist?: CostPersist,
    // Plane-split P3c: optional remote-reconcile delegate. When set, the run-end
    // apportion/back-fill (`reconcileRunCost*`) routes its cost_records
    // SELECT+UPDATEs through the control-plane endpoint rather than this.pool —
    // closing the de-privilege gap where the data plane can no longer UPDATE
    // cost_records directly. Absent (in-process control plane / tests) it writes
    // in-process, unchanged.
    private readonly reconcile?: CostReconcile,
  ) {}

  // record persists a single cost_records row with the full typed token
  // breakdown and a possibly-null dollar figure. It never throws for an
  // unattributable ref — cost-unknown is an allowed state.
  async record(
    context: CostRecordContext,
    tokens: TokenUsage,
    rawUsage: Record<string, unknown>,
  ): Promise<RecordedCost> {
    // Plane-split P3: when a remote-write delegate is wired, the cost_records
    // INSERT + its cost.resolved event run server-side (control plane), so the
    // data plane writes no tenant rows directly. Same shape, same return value.
    if (this.persist !== undefined) {
      return this.persist({ context, tokens, rawUsage });
    }
    const attribution: AttributionInput = {
      cli: context.cli,
      authRef: context.authRef,
      ccusageCostUsd: context.ccusageCostUsd ?? null,
      rawUsage,
    };
    const source = resolveCostSource(attribution);
    const costUsd = computeCostUsd(source, tokens);
    // RLS R2 cohort-2 (cost_records write path): route the INSERT through the
    // ambient org-scoped client when this recorder was handed the shared pool and
    // a `runWithOrgScope` scope is open; fall back to the pool when none (inert,
    // R1-equivalent). Handed a specific client, it is used verbatim. Columns,
    // values, and the in-statement org_id derivation are unchanged.
    await resolveWritableClient(this.pool).query(
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
    // BUDGET-SAFETY (C1): an UNRECOGNIZED credential ref priced this real call as
    // NULL dollars. Do NOT let it slip by as a silent $0 — emit a loud,
    // secret-free `cost.unattributed` event naming the ref KIND only, so an
    // operator sees the misconfig and the budget gate fails closed on the row.
    if (source.unattributedRefKind !== null) {
      await this.eventStore.append({
        runId: context.runId,
        taskId: context.taskId,
        specId: context.specId,
        projectId: context.projectId,
        eventType: "cost.unattributed",
        payload: {
          taskId: context.taskId,
          cli: context.cli,
          refKind: source.unattributedRefKind,
          reason:
            "unrecognized LLM credential ref (no known credential/<kind>/ prefix): cost cannot be priced, recorded as cost_usd=NULL — budget gate fails closed",
        },
      });
    }
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

  // applyReconcile is the SERVER-SIDE entry point for the control-plane
  // reconcile endpoint (plane-split P3c): the worker has already resolved the
  // run-level total + basis (the credit/ccusage precedence ran data-plane-side),
  // so this just performs the in-process apportion under the run's org scope. It
  // NEVER delegates (the endpoint constructs a delegate-free recorder), so it is
  // the actual cost_records write — the same apportion the direct path runs.
  async applyReconcile(
    runId: string,
    totalCostUsd: number,
    basis: "ccusage" | "credits",
  ): Promise<{ updated: number }> {
    return this.apportionRunCost(runId, totalCostUsd, basis);
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
    // Plane-split P3c: when a remote-reconcile delegate is wired, the apportioning
    // SELECT + per-row UPDATEs run server-side (control plane), so the
    // de-privileged data plane never UPDATEs cost_records directly. The dollar
    // total + basis are already resolved above; only the write moves.
    if (this.reconcile !== undefined) {
      return this.reconcile({ runId, totalCostUsd, basis });
    }
    // RLS R2 cohort-2 + R3a-worker (cost_records read+write): the reconcile
    // SELECT and its apportioning UPDATEs are a TIGHT batch with no I/O between
    // them, so they share ONE transaction/snapshot. When the recorder holds the
    // shared pool, run the whole batch through `withJobOrgScope`: an open
    // connection scope is reused, else a per-job org-id opens ONE short
    // `runWithOrgScope` for the batch, else it falls back to the pool (inert).
    // A recorder handed a specific in-transaction client uses it verbatim — the
    // caller owns that transaction. Same query text and params as before.
    const runBatch = (client: QueryClient): Promise<{ updated: number }> =>
      this.apportionOnClient(client, runId, totalCostUsd, basis);
    return isPool(this.pool) ? withJobOrgScope(this.pool, runBatch) : runBatch(this.pool);
  }

  private async apportionOnClient(
    client: QueryClient,
    runId: string,
    totalCostUsd: number,
    basis: "ccusage" | "credits",
  ): Promise<{ updated: number }> {
    const rows = await client.query<{ id: string; total_tokens: number }>(
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
      await client.query("UPDATE cost_records SET cost_usd = $2, cost_basis = $3 WHERE id = $1", [
        row.id,
        costUsd,
        basis,
      ]);
      updated += 1;
    }
    return { updated };
  }
}
