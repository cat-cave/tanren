// CostReconciler — the run-end persistence path for distributing a resolved
// run-level cost across its individual cost_records rows.
import type pg from "pg";
import type { EventStore } from "../eventStore.js";
import { isPool, withJobOrgScope, type QueryClient } from "../data/orgScopedDb.js";

type RecorderClient = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * A reconcile override for the recorder's run-end apportion/back-fill. When
 * supplied, the apportioning `cost_records` SELECT+UPDATEs (which the data
 * plane may no longer perform directly — migration 0031 dropped its
 * `cost_records` write grant) route through the control-plane endpoint
 * (`HttpRunStateWriter`) instead of writing in-process. The reconciler still
 * resolves the dollar total + basis (the credit/ccusage precedence stays
 * there); only the write moves. The default in-process path is byte-identical.
 */
export type CostReconcile = (input: {
  runId: string;
  totalCostUsd: number;
  basis: "ccusage" | "credits";
}) => Promise<{ updated: number }>;

export class CostReconciler {
  constructor(
    private readonly pool: RecorderClient,
    private readonly eventStore: EventStore,
    private readonly reconcile?: CostReconcile,
  ) {}

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
    // When a remote-reconcile delegate is wired, the apportioning SELECT +
    // per-row UPDATEs run server-side (control plane), so the de-privileged
    // data plane never UPDATEs cost_records directly. The dollar total + basis
    // are already resolved above; only the write moves.
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
    const totalTokens = rows.rows.reduce((sum, row) => sum + row.total_tokens, 0);
    if (totalTokens <= 0) {
      await this.emitReconcileFailed(client, runId, totalCostUsd, basis, "zero_token_denominator");
      return { updated: 0 };
    }
    let updated = 0;
    for (const row of rows.rows) {
      const share = row.total_tokens / totalTokens;
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
    const r = await client.query<{ project_id: string; org_id: string; spec_id: string | null }>(
      "SELECT project_id, org_id, spec_id FROM runs WHERE run_id = $1",
      [runId],
    );
    const { project_id: projectId = "", org_id: orgId = "", spec_id: specId } = r.rows[0] ?? {};
    await this.eventStore.append({
      runId,
      ...(specId === null || specId === undefined ? {} : { specId }),
      projectId,
      orgId,
      eventType: "cost.reconcile_failed",
      payload: { basis, totalCostUsd, reason, reasonText: reconcileFailedReasonText(reason) },
    });
  }
}

function reconcileFailedReasonText(reason: "no_rows" | "zero_token_denominator"): string {
  return reason === "no_rows"
    ? "a positive real cost total was resolved but the run has no cost_records rows to receive it; observed real spend would otherwise silently vanish"
    : "a positive real cost total was resolved but the run's cost_records carry zero total tokens, so it cannot be apportioned; observed real spend would otherwise silently vanish";
}
