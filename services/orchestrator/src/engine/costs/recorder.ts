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
import { resolveWritableClient } from "../data/orgScopedDb.js";
import { type AttributionInput, type CostSource, computeCostUsd, resolveCostSource } from "./sources.js";
import { computeNotionalUsd, type LoudNotionalReason, notionalReasonIsLoud } from "./notional.js";
import type { ModelPriceLookup } from "./pricing/compositePriceSource.js";
import { costPriceSource } from "./pricing/costPriceSource.js";

import { CostReconciler, type CostReconcile } from "./reconciler.js";
import { createLogger } from "../observability/logger.js";
const log = createLogger("cost-recorder");

// Operator-facing prose per loud reason. Keyed on the LOUD subset only — a reason
// that never fires this event has no message to write, and typing it that way makes
// that structural rather than a convention (no empty-string placeholders to drift).
// Kept beside the emission so the message always matches the code, and so each gap
// names ITS OWN remedy rather than one generic sentence that fits none of them well.
const NOTIONAL_UNPRICED_DETAIL: Record<LoudNotionalReason, string> = {
  model_id_absent:
    "a real, token-bearing call reached the cost recorder with NO model id, so no price source could be consulted and notional_cost_usd is NULL. This is a TANREN DEFECT, not a property of the model: the adapter that served this call does not declare `model`, or a decorator between the adapter and the cost path dropped it.",
  model_not_listed:
    "the price source AUTHORITATIVE FOR THIS ROUTE was reachable and does not list this model id, so notional_cost_usd is NULL. Verify the recorded model id against that route's source — OpenRouter's /api/v1/models for an OpenRouter route, the LiteLLM model-price table for a direct-vendor one, whose key spaces differ. Either the id is genuinely unlisted there, or it is not a model id at all — a routing placeholder recorded verbatim.",
  price_source_unavailable:
    "the price source authoritative for this route could not be consulted (its live fetch has not yet succeeded — OpenRouter's /api/v1/models on an OpenRouter route), so notional_cost_usd is NULL. This is an INFRASTRUCTURE fault and says nothing about the model — the row stays repriceable once the fetch recovers.",
};

type RecorderClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface CostRecordContext {
  runId: string;
  /** Present for a triage cost before a fix spec has a run; mutually exclusive at the row. */
  issueLoopId?: string;
  taskId: string;
  specId: string;
  projectId: string;
  orgId: string;
  cli: "codex" | "claude" | "opencode" | "aider" | "pi" | "reasonix" | "fake";
  /**
   * The REAL model id this call was sent to — `cost_records.model` and the NOTIONAL
   * price-source lookup key. NOT a role name: the eight answerer/writer sites used to
   * write pseudo ids (`"tanren-planner"`, `"tanren-writer"`, …) here because `role`
   * had no other channel, which made `notional_cost_usd` structurally NULL in every
   * deployment (no such id exists in the LiteLLM price source). `role` below is that
   * channel; `""` remains the honest "no model id" value.
   */
  model: string;
  /**
   * The AGENT ROLE this call served (`planner`, `writer`, `checker`, …), recorded in
   * `cost_source_raw.role`.
   *
   * DELIBERATELY NOT A COLUMN. `cost_source_raw` is already a `jsonb NOT NULL` this
   * recorder writes, and already carries provenance (authRef / billingMode /
   * costBasis / provider / rawUsage) — role is provenance and belongs with it. A
   * dedicated `role` column would consume a one-owner-one-slot migration for a field
   * with a zero-migration home; if indexed group-by reporting later wants one it is a
   * clean backfill from `cost_source_raw->>'role'`. See
   * docs/_design/openrouter-cost-attribution.md §5.
   */
  role?: string;
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

export type { CostReconcile } from "./reconciler.js";

export class CostRecorder {
  private readonly reconciler: CostReconciler;

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
    reconcile?: CostReconcile,
    // The per-model price source the NOTIONAL estimate is computed from. Defaults to
    // the LIVE composite: OpenRouter's own `/api/v1/models` quote (authoritative for
    // a marketplace route, and the ONLY source that lists the ids tanren sends it),
    // with the LiveModelPriceSource / LiteLLM table behind it for direct-vendor
    // routes. Both are TTL-cached and refresh in the background; neither blocks a
    // lookup. Frozen and network-free under tests. A test injects a fixture instead.
    //
    // Typed on the CAPABILITY (`ModelPriceLookup`) rather than a concrete class, so
    // the composite, either live source, and a test fake are all accepted.
    private readonly priceSource: ModelPriceLookup = costPriceSource(),
  ) {
    this.reconciler = new CostReconciler(pool, eventStore, reconcile);
  }

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
    const notional = computeNotionalUsd(source, tokens, this.priceSource);
    const notionalCostUsd = notional.usd;
    // Route through the ambient org-scoped client when a pool is scoped.
    const issueLoopId = context.issueLoopId;
    const rawCostSource = JSON.stringify({
      authRef: context.authRef,
      // The agent role, on its OWN provenance field rather than smuggled through
      // `model` (see CostRecordContext.role). Null for a call site with no role.
      role: context.role ?? null,
      runtimeSeconds: context.runtimeSeconds ?? null,
      billingMode: source.billingMode,
      costBasis: source.costBasis,
      provider: source.provider,
      // WHY notional_cost_usd is (or is not) a number, on every row. Makes the
      // question queryable: `cost_source_raw->>'notionalReason'`.
      notionalReason: notional.reason,
      rawUsage,
    });
    const commonParams = [
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
      rawCostSource,
      context.userId ?? null,
    ];
    const insert =
      issueLoopId === undefined
        ? {
            sql: `INSERT INTO cost_records
       (task_id, run_id, project_id, org_id, cli, provider, model,
        input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens, reasoning_output_tokens, total_tokens,
        cost_usd, notional_cost_usd, billing_mode, cost_basis, cost_source_raw, user_id)
       VALUES ($1, $2, $3, (SELECT org_id FROM runs WHERE run_id = $2), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18)`,
            params: [context.taskId, context.runId, context.projectId, ...commonParams],
          }
        : {
            sql: `INSERT INTO cost_records
       (task_id, run_id, issue_loop_id, project_id, org_id, cli, provider, model,
        input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens, reasoning_output_tokens, total_tokens,
        cost_usd, notional_cost_usd, billing_mode, cost_basis, cost_source_raw, user_id)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19)`,
            params: [context.taskId, issueLoopId, context.projectId, context.orgId, ...commonParams],
          };
    await resolveWritableClient(this.pool).query(insert.sql, insert.params);
    // ATOMICITY SEAM (audit RC-4 #1): the spend row above is ALREADY committed and is
    // the AUTHORITATIVE source of truth — the budget gate's `sumSpend` reads
    // The committed row is authoritative; the timeline event is best-effort.
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
        // Present on EVERY resolved event, priced or not, so a timeline reader
        // never sees a bare null it cannot explain.
        notionalReason: notional.reason,
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
    //
    // THE GUARD THAT HID THE BUG (XHE-931). This condition used to require
    // `context.model !== ""`, so a real, token-bearing call that arrived with NO
    // model id — which, because the observability decorators dropped `model`, was
    // 100% of production calls — recorded a NULL notional and emitted NOTHING. The
    // escape hatch added for fake fixtures was silencing the one case that most
    // needed to be loud.
    //
    // It is now driven by the REASON, not by re-deriving the condition: any reason
    // in `LOUD_NOTIONAL_REASONS` fires. `no_tokens` (legitimately empty) and
    // `unattributed_credential` (already narrated by `cost.unattributed`) do not,
    // so the alarm keeps its precision.
    if (notionalReasonIsLoud(notional.reason)) {
      // Same atomicity rule: post-committed-row, loud-but-non-fatal.
      await this.appendCostEventNonFatal(context, {
        eventType: "cost.notional_unpriced",
        payload: {
          provider: source.provider,
          model: context.model,
          cli: context.cli,
          taskId: context.taskId,
          reasonCode: notional.reason,
          reason: NOTIONAL_UNPRICED_DETAIL[notional.reason],
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
        orgId: context.orgId,
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
    return this.reconciler.reconcileRunCostFromCcusage(runId, ccusageCostUsd);
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
    return this.reconciler.reconcileRunCostFromCredits(runId, creditsConsumed, creditUsdRate);
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
    return this.reconciler.applyReconcile(runId, totalCostUsd, basis);
  }
}
