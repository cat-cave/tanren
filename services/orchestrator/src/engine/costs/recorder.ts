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
import type { EventName, EventPayload } from "../events/index.js";
import { isPool, resolveWritableClient, withJobOrgScope, type QueryClient } from "../data/orgScopedDb.js";
import {
  type AttributionInput,
  type CostSource,
  computeCostUsd,
  computeNotionalUsd,
  resolveCostSource,
} from "./sources.js";
import { defaultModelPriceSource, type ModelPriceSource } from "./pricing/modelPriceSource.js";
import { createLogger } from "../observability/logger.js";
const log = createLogger("cost-recorder");

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
  // CAPTURE PATH: a managed OpenRouter run captures this via a post-call
  // `/api/v1/generation` query (built in `costs/openRouterCost.ts`), keyed off the
  // generation id the managed adapters now surface (TokenUsage.openRouterGenerationId)
  // — see the run worker's capture seam. A positive value makes cost_usd a metered
  // FACT (`provider_response`). null/0 → no fact → cost_usd NULL (`unknown`); there
  // is NO list-rate estimate (REAL SPEND IS A FACT, see sources.ts).
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
 * A persistence override for {@link CostRecorder.record}. When
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
 * a reconcile override for the recorder's run-end
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
    // Optional remote-write delegate. When set, `record` routes
    // the persist through it (the control-plane endpoint) rather than the
    // in-process INSERT below.
    private readonly persist?: CostPersist,
    // optional remote-reconcile delegate. When set, the run-end
    // apportion/back-fill (`reconcileRunCost*`) routes its cost_records
    // SELECT+UPDATEs through the control-plane endpoint rather than this.pool —
    // closing the de-privilege gap where the data plane can no longer UPDATE
    // cost_records directly. Absent (in-process control plane / tests) it writes
    // in-process, unchanged.
    private readonly reconcile?: CostReconcile,
    // The maintained per-model price source the NOTIONAL estimate is computed from
    // (LiteLLM's vendored data). Defaults to the vendored snapshot; a test injects a
    // small fixture map so notional is deterministic without the 1.3 MB file.
    private readonly priceSource: ModelPriceSource = defaultModelPriceSource(),
  ) {}

  // record persists a single cost_records row with the full typed token
  // breakdown and a possibly-null dollar figure. It never throws for an
  // unattributable ref — cost-unknown is an allowed state.
  async record(
    context: CostRecordContext,
    tokens: TokenUsage,
    rawUsage: Record<string, unknown>,
  ): Promise<RecordedCost> {
    // When a remote-write delegate is wired, the cost_records
    // INSERT + its cost.resolved event run server-side (control plane), so the
    // data plane writes no tenant rows directly. Same shape, same return value.
    if (this.persist !== undefined) {
      return this.persist({ context, tokens, rawUsage });
    }
    const attribution: AttributionInput = {
      cli: context.cli,
      authRef: context.authRef,
      // The model id — the NOTIONAL estimate's lookup key (computeNotionalUsd →
      // ModelPriceSource). Never used for real spend.
      model: context.model,
      // The provider's OWN authoritative per-call charge (OpenRouter's
      // `usage.cost`), when a capture surfaced it for this call. HIGHEST
      // precedence — sets real spend as `provider_response`, outranking ccusage.
      // Captured for a managed OpenRouter run via the generation-id query; null
      // otherwise → cost_usd NULL (`unknown`), never a list-rate estimate.
      realProviderCostUsd: context.realProviderCostUsd ?? null,
      ccusageCostUsd: context.ccusageCostUsd ?? null,
      rawUsage,
    };
    const source = resolveCostSource(attribution);
    const costUsd = computeCostUsd(source, tokens);
    // NOTIONAL (FOCUS ListCost): the COMPUTED list value of the tokens from the
    // maintained LiteLLM model price (keyed by model id), for EVERY call (incl.
    // subscription/self_hosted, where `costUsd` real spend is NULL) — the
    // comparable, forecastable figure. NULL when the model is unpriced. NEVER
    // summed by the budget gate; NEVER written to cost_usd.
    const notionalCostUsd = computeNotionalUsd(source, tokens, this.priceSource);
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
    // ATOMICITY SEAM (audit RC-4 #1): the spend row above is ALREADY committed and is
    // the AUTHORITATIVE source of truth — the budget gate's `sumSpend` reads
    // `cost_records.cost_usd` DIRECTLY (row-is-truth), never the event. The
    // `cost.resolved` event is a derived timeline projection. So a post-row event
    // append failure must NOT throw (that would surface a "record failed" to the
    // caller for a spend row that DID commit, and a retry would double-charge);
    // instead it is surfaced LOUDLY via a structured error log so the committed-row /
    // missing-event divergence is operator-visible and never silent. A second event
    // append cannot be the loud signal — the same store just failed — so the log IS
    // the signal. The invariant: a committed spend row is never lost; a missing event
    // is loud, never silent.
    await this.appendCostEventNonFatal(context, {
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
      },
    });
    // BUDGET-SAFETY (C1): an UNRECOGNIZED credential ref priced this real call as
    // NULL dollars. Do NOT let it slip by as a silent $0 — emit a loud,
    // secret-free `cost.unattributed` event naming the ref KIND only, so an
    // operator sees the misconfig and the budget gate fails closed on the row.
    if (source.unattributedRefKind !== null) {
      // Post-committed-row append, same atomicity rule as cost.resolved above: loud,
      // never fatal — the spend row already carries the cost_usd=NULL / 'unattributed'
      // basis the budget gate fails closed on, so a missing event must not throw.
      await this.appendCostEventNonFatal(context, {
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
    // NOTIONAL-UNPRICED (finding 6): a REAL, token-bearing call whose MODEL is not
    // in the maintained price source records notional_cost_usd=NULL. Notional is
    // the comparable, forecastable figure for EVERY billing mode; a model-id drift
    // silently dropping it must be LOUD (not conflated with a legitimately-empty
    // zero-token answerer row, nor an unattributed misconfig already covered above).
    if (
      notionalCostUsd === null &&
      tokens.totalTokens > 0 &&
      context.model !== "" &&
      source.billingMode !== "unattributed"
    ) {
      // Same atomicity rule: post-committed-row, loud-but-non-fatal.
      await this.appendCostEventNonFatal(context, {
        eventType: "cost.notional_unpriced",
        payload: {
          provider: source.provider,
          model: context.model,
          cli: context.cli,
          taskId: context.taskId,
          reason:
            "the call's model is not in the maintained notional price source; notional list-value recorded as NULL — surfaced loudly so the price-source gap is visible",
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

  // ATOMICITY SEAM (audit RC-4 #1): append a derived cost-timeline event AFTER the
  // authoritative `cost_records` row has committed, never throwing for an append
  // failure. The committed row is the row-is-truth budget-gate source; a lost event
  // is a timeline-projection gap, not a spend-accounting one. A failure is surfaced
  // LOUDLY (structured error log) — a retry/second append is impossible (the same store just
  // failed and the row would double-charge on a `record` retry), so the log IS the
  // loud signal. Returns nothing; the caller's `record` always resolves with the
  // committed-row result.
  private async appendCostEventNonFatal<N extends EventName>(
    context: CostRecordContext,
    event: { eventType: N; payload: EventPayload<N> },
  ): Promise<void> {
    try {
      await this.eventStore.append({
        runId: context.runId,
        taskId: context.taskId,
        specId: context.specId,
        projectId: context.projectId,
        eventType: event.eventType,
        payload: event.payload,
      });
    } catch (error) {
      // LOUD-but-non-fatal: the spend row is committed and authoritative; only the
      // derived timeline event is missing (budget accounting row-is-truth is UNAFFECTED).
      const ctx = { runId: context.runId, taskId: context.taskId, eventType: event.eventType };
      log.error("cost.event_append_failed: row committed, timeline event not appended", ctx, error);
    }
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
  // reconcile endpoint (the plane split): the worker has already resolved the
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
    // when a remote-reconcile delegate is wired, the apportioning
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
    // The token-share denominator is the run's tokens EXCLUDING `provider_response` rows:
    //   - ccusage's run total is the NOTIONAL value of the apportioned tokens → it writes
    //     `notional_cost_usd` on EVERY (non-provider_response) row; that figure is ALSO the
    //     REAL spend (`cost_usd`) but ONLY for `billing_mode='per_token'` rows (real ==
    //     notional there) — a subscription/self_hosted row's real spend stays NULL.
    //   - a `credits` reconcile is genuine subscription-overage REAL spend → it writes
    //     `cost_usd` on ALL such rows, leaving each row's write-time notional untouched.
    //   - BASIS FILTER (audit §3.7c): `provider_response` rows are EXCLUDED so an estimate
    //     never overwrites the provider's OWN charge (all-provider_response → loud `no_rows`).
    const rows = await client.query<{ id: string; total_tokens: number; billing_mode: string }>(
      "SELECT id, total_tokens, billing_mode FROM cost_records WHERE run_id = $1 AND cost_basis IS DISTINCT FROM 'provider_response'",
      [runId],
    );
    // RECONCILE-FAILED (finding 7): a POSITIVE real total (ccusage / credit drawdown)
    // that lands on NO row — no cost_records rows for the run, or a zero total-token
    // denominator — means observed real spend would silently VANISH. Surface it
    // LOUDLY rather than returning a quiet `{ updated: 0 }`. (apportionRunCost has
    // already guaranteed totalCostUsd > 0 before reaching here.)
    if (rows.rows.length === 0) {
      await this.emitReconcileFailed(client, runId, totalCostUsd, basis, "no_rows");
      return { updated: 0 };
    }
    const totalTokens = rows.rows.reduce((sum, row) => sum + Number(row.total_tokens), 0);
    if (totalTokens <= 0) {
      await this.emitReconcileFailed(client, runId, totalCostUsd, basis, "zero_token_denominator");
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

  // Emit the LOUD `cost.reconcile_failed` event for a POSITIVE real total that
  // could be applied to no cost_records row (finding 7). Reads the run's
  // project/spec on the SAME client (the append requires a projectId) so the
  // event lands org-scoped in the reconcile's own transaction. Best-effort on the
  // lookup: the loud event is the surfacing, never a new failure of its own.
  private async emitReconcileFailed(
    client: QueryClient,
    runId: string,
    totalCostUsd: number,
    basis: "ccusage" | "credits",
    reason: "no_rows" | "zero_token_denominator",
  ): Promise<void> {
    const run = await client.query<{ project_id: string; spec_id: string | null }>(
      "SELECT project_id, spec_id FROM runs WHERE run_id = $1",
      [runId],
    );
    const projectId = run.rows[0]?.project_id ?? "";
    const specId = run.rows[0]?.spec_id ?? undefined;
    await this.eventStore.append({
      runId,
      ...(specId !== undefined && specId !== null ? { specId } : {}),
      projectId,
      eventType: "cost.reconcile_failed",
      payload: {
        basis,
        totalCostUsd,
        reason,
        reasonText:
          reason === "no_rows"
            ? "a positive real cost total was resolved but the run has no cost_records rows to receive it; observed real spend would otherwise silently vanish"
            : "a positive real cost total was resolved but the run's cost_records carry zero total tokens, so it cannot be apportioned; observed real spend would otherwise silently vanish",
      },
    });
  }
}
