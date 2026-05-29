// DB-backed QuotaPolicy: reads ceilings + consumed counters from `org_quotas`.
// The OSS enforces whatever a hosting layer wrote into the table; it never
// computes limits or rolls windows over.
//
// "No row" = unlimited. A self-hosted deployment that never seeds `org_quotas`
// is unrestricted even with this policy wired — so default behavior is
// unchanged. A row with a NULL on a dimension means that dimension is
// uncapped; the gate denies only when a PRESENT limit would be exceeded by the
// request (run dimension) or is already met/exceeded (token/credit dimensions,
// which are only known post-run, so the gate treats an already-exhausted
// budget as a hard stop on the next run).
//
// Accrual advances `runs_used` / `tokens_used` / `credits_used` from a
// completed run's real usage. `credits_used` is advanced by the run's dollar
// cost via the credit rate the hosting layer also wrote nowhere in the OSS —
// the OSS accrues dollars into `credits_used` directly (1:1 USD), leaving the
// hosting layer free to reconcile against its own rate. Accrual is additive +
// idempotent only at the statement level; the caller guarantees one accrual per
// completed run.

import type pg from "pg";
import { z } from "zod";
import type { AdmissionDecision, AdmissionRequest, QuotaPolicy, RunUsage } from "./contracts.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

const QuotaRowSchema = z.object({
  window_key: z.string(),
  run_limit: z.coerce.number().nullable(),
  token_limit: z.coerce.number().nullable(),
  credit_limit: z.coerce.number().nullable(),
  runs_used: z.coerce.number(),
  tokens_used: z.coerce.number(),
  credits_used: z.coerce.number(),
});
type QuotaRow = z.infer<typeof QuotaRowSchema>;

export class DbQuotaPolicy implements QuotaPolicy {
  // `windowKey` selects the active window row. Defaults to "default" — the same
  // default the column carries — so a single-window deployment needs no config.
  constructor(
    private readonly pool: QueryClient,
    private readonly windowKey: string = "default",
  ) {}

  async checkAdmission(orgId: string, requested: AdmissionRequest): Promise<AdmissionDecision> {
    const row = await this.loadRow(orgId);
    if (row === undefined) {
      // No quota configured for this org/window → unlimited.
      return { admit: true };
    }
    const denial = denyReason(row, requested);
    if (denial !== undefined) {
      return { admit: false, reason: denial, windowKey: row.window_key };
    }
    return { admit: true, windowKey: row.window_key };
  }

  async accrueUsage(orgId: string, usage: RunUsage): Promise<void> {
    // Advance consumed counters for the active window. A missing row is a no-op
    // (UPDATE matches nothing) — an org with no quota accrues nowhere.
    await this.pool.query(
      `UPDATE org_quotas
         SET runs_used = runs_used + $3,
             tokens_used = tokens_used + $4,
             credits_used = credits_used + $5,
             updated_at = now()
       WHERE org_id = $1 AND window_key = $2`,
      [orgId, this.windowKey, usage.runs, usage.tokens, usage.costUsd],
    );
  }

  private async loadRow(orgId: string): Promise<QuotaRow | undefined> {
    const result = await this.pool.query(
      `SELECT window_key, run_limit, token_limit, credit_limit, runs_used, tokens_used, credits_used
       FROM org_quotas
       WHERE org_id = $1 AND window_key = $2`,
      [orgId, this.windowKey],
    );
    const raw = result.rows[0];
    return raw === undefined ? undefined : QuotaRowSchema.parse(raw);
  }
}

/** The denial reason for a row, or undefined if the request is admitted. A NULL
 * limit means that dimension is uncapped. Token/credit budgets are checked as
 * "already exhausted" (>= limit) because their consumption is only known after
 * a run, so a run cannot start once its budget is spent. */
function denyReason(row: QuotaRow, requested: AdmissionRequest): string | undefined {
  if (row.run_limit !== null && row.runs_used + requested.runs > row.run_limit) {
    return `run quota exhausted: ${row.runs_used}/${row.run_limit} runs used in window ${row.window_key}`;
  }
  if (row.token_limit !== null && row.tokens_used >= row.token_limit) {
    return `token budget exhausted: ${row.tokens_used}/${row.token_limit} tokens used in window ${row.window_key}`;
  }
  if (row.credit_limit !== null && row.credits_used >= row.credit_limit) {
    return `credit budget exhausted: ${row.credits_used}/${row.credit_limit} credits used in window ${row.window_key}`;
  }
  return undefined;
}
