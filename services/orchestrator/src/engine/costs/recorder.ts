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
import {
  type AttributionInput,
  type CostSource,
  computeCostUsd,
  computeNotionalUsd,
  resolveCostSource,
} from "./sources.js";

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
  // The provider's OWN authoritative per-call charge for THIS call (OpenRouter's
  // `usage.cost` / `/api/v1/generation.total_cost`) — the REAL amount deducted
  // from the balance, no inference markup, native tokenizer. A positive value is
  // the most accurate real-spend figure and OUTRANKS ccusage AND the static table
  // → cost_basis becomes 'provider_response'. null/0 falls back to the next basis.
  //
  // REACHABILITY (today): no CLI adapter (codex/aider/pi/opencode) surfaces this
  // per call — they parse only token fields, never the provider's cost or a
  // generation id — so this is null on every live call right now. The accurate
  // capture path is a post-call OpenRouter `/api/v1/generation` query (built in
  // `costs/openRouterCost.ts`), which needs a generation id the harness does not
  // yet emit. Until that id is surfaced, an OpenRouter per_token row prices from
  // the static table and is flagged `estimateOnly` (LOUD, see sources.ts) — never
  // silently presented as the real deduction. This field is the typed seam the
  // capture wires into the moment the id (or a CLI that emits `usage.cost`) lands.
  realProviderCostUsd?: number | null;
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
  // REAL SPEND (FOCUS BilledCost): NULL for subscription within-window / self-hosted
  // / unpriced; the budget gate sums this.
  costUsd: string | null;
  // NOTIONAL VALUE (FOCUS ListCost): the tokens' dollar value at provider list rates,
  // computed for EVERY billing mode whose provider has a rate (incl. subscription).
  // NULL only when no provider rate is known. NEVER summed by the budget gate.
  notionalCostUsd: string | null;
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
      // The provider's OWN authoritative per-call charge (OpenRouter's
      // `usage.cost`), when a capture surfaced it for this call. HIGHEST
      // precedence — sets real spend as `provider_response`, outranking ccusage
      // AND the static table. null on every live call today (no source surfaces
      // it yet — see CostRecordContext.realProviderCostUsd), so the OpenRouter
      // per_token row prices from the table and is flagged `estimateOnly`.
      realProviderCostUsd: context.realProviderCostUsd ?? null,
      ccusageCostUsd: context.ccusageCostUsd ?? null,
      rawUsage,
    };
    const source = resolveCostSource(attribution);
    const costUsd = computeCostUsd(source, tokens);
    // NOTIONAL (FOCUS ListCost): the list-rate value of the tokens, computed for
    // EVERY call whose provider has a rate (incl. subscription/self_hosted, where
    // `costUsd` real spend is NULL) — the comparable, forecastable figure. NEVER
    // summed by the budget gate.
    const notionalCostUsd = computeNotionalUsd(source, tokens);
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
        cost_usd, notional_cost_usd, billing_mode, cost_basis, cost_source_raw, user_id)
       VALUES ($1, $2, $3, (SELECT org_id FROM runs WHERE run_id = $2), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18)`,
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
        notionalCostUsd,
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
        notionalCostUsd,
        billingMode: source.billingMode,
        costBasis: source.costBasis,
        // LOUD ESTIMATE flag: true when this OpenRouter per_token row's real-spend
        // costUsd is the STATIC list-rate estimate standing in for the provider's
        // authoritative `usage.cost` (which we could capture but have not wired per
        // call yet) — so an operator never mistakes the figure for the real
        // deduction. False for a real provider_response/ccusage/credits figure.
        estimateOnly: source.estimateOnly,
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
      notionalCostUsd,
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
    // The token-share denominator is ALWAYS the run's WHOLE token count (all rows):
    //   - ccusage's run total is the NOTIONAL value of ALL the run's tokens, so it
    //     apportions across EVERY row by token share into `notional_cost_usd`. The
    //     same per-row figure is also the REAL spend (`cost_usd`) — but ONLY for
    //     `billing_mode='per_token'` rows (for per_token real == notional); a
    //     subscription/self_hosted row's real spend stays NULL (no marginal cost).
    //   - a `credits` reconcile is genuine subscription-overage REAL spend, so it
    //     apportions across ALL rows into `cost_usd` ONLY, leaving the notional value
    //     each row already carries from write time untouched (unchanged behavior).
    const rows = await client.query<{ id: string; total_tokens: number; billing_mode: string }>(
      "SELECT id, total_tokens, billing_mode FROM cost_records WHERE run_id = $1",
      [runId],
    );
    const totalTokens = rows.rows.reduce((sum, row) => sum + Number(row.total_tokens), 0);
    if (totalTokens <= 0) {
      return { updated: 0 };
    }
    let updated = 0;
    for (const row of rows.rows) {
      const share = Number(row.total_tokens) / totalTokens;
      const apportioned = (totalCostUsd * share).toFixed(6);
      updated += await this.applyApportionedRow(client, row, apportioned, basis);
    }
    return { updated };
  }

  // Apply ONE apportioned per-row figure under the per-mode column rule, returning 1
  // if a row was written, else 0 (a credits-basis non-per_token row whose notional is
  // unaffected and whose real spend IS this row's share still counts as written).
  private async applyApportionedRow(
    client: QueryClient,
    row: { id: string; billing_mode: string },
    apportioned: string,
    basis: "ccusage" | "credits",
  ): Promise<number> {
    if (basis === "credits") {
      // Genuine subscription-overage REAL spend → `cost_usd` on every row, basis
      // 'credits'. `notional_cost_usd` is left as written (its own list-rate value).
      await client.query("UPDATE cost_records SET cost_usd = $2, cost_basis = $3 WHERE id = $1", [
        row.id,
        apportioned,
        basis,
      ]);
      return 1;
    }
    // ccusage: NOTIONAL on EVERY row; REAL (`cost_usd`) on per_token rows ONLY (real
    // == notional there). A subscription/self_hosted row gets ONLY notional and keeps
    // its NULL real spend — so subscription notional value is captured without ever
    // tripping the real-spend budget gate.
    if (row.billing_mode === "per_token") {
      await client.query(
        "UPDATE cost_records SET cost_usd = $2, notional_cost_usd = $2, cost_basis = $3 WHERE id = $1",
        [row.id, apportioned, basis],
      );
    } else {
      await client.query("UPDATE cost_records SET notional_cost_usd = $2, cost_basis = $3 WHERE id = $1", [
        row.id,
        apportioned,
        basis,
      ]);
    }
    return 1;
  }
}
