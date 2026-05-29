// SaaS Tier-B quota-admission-gate — the pluggable seam between the OSS repo and
// a closed hosting layer. The OSS *enforces* whatever policy is wired and
// *accrues* usage; it never decides pricing or limits. A hosting layer supplies
// its own QuotaPolicy implementation (e.g. reading a plan/entitlements service);
// the OSS ships an unlimited no-op default (self-hosters are unrestricted) plus
// a DB-backed policy that reads the `org_quotas` table.
//
// Two responsibilities, deliberately split:
//   1. checkAdmission — a PRE-FLIGHT decision, called before a run executes.
//   2. accrueUsage    — a POST-RUN hook, called on completion with the run's
//      already-recorded cost (derived from `cost_records`), so the policy can
//      advance its consumed counters.
//
// The interface is intentionally narrow + side-effect-honest: admission is a
// pure read; accrual is the only write. Neither throws for the unlimited case —
// the no-op default always admits and ignores accrual.

/** What a run is requesting up-front. The OSS knows it wants to start ONE run;
 * token/credit consumption is only known after the run completes, so the
 * pre-flight check is run-count-oriented and the post-run accrual carries the
 * real token/credit figures. */
export interface AdmissionRequest {
  /** Number of runs this admission covers. Always 1 today; kept explicit so a
   * future batch-admission path doesn't change the seam. */
  runs: number;
}

/** The admission decision. `admit: false` MUST carry a human-readable reason
 * (surfaced on the recovery surface + emitted as `run.quota_exceeded`). */
export interface AdmissionDecision {
  admit: boolean;
  /** Present when `admit` is false; the denial reason shown to the operator. */
  reason?: string;
  /** The hosting-layer window the decision was made against, when known. Echoed
   * into the `run.quota_exceeded` event so the billing UX can deep-link. */
  windowKey?: string;
}

/** The real usage a completed run consumed, derived from its `cost_records`
 * (grouped by org_id). Passed to {@link QuotaPolicy.accrueUsage} so the policy
 * advances its consumed counters from ground truth, not an estimate. */
export interface RunUsage {
  /** Runs to accrue (always 1 for a single completed run). */
  runs: number;
  /** Total tokens the run consumed across every cost_records row. */
  tokens: number;
  /** Real marginal dollar cost where known (NULL cost rows contribute 0). The
   * hosting layer maps dollars→credits with its own rate; the OSS just reports
   * the figure cost accounting already computed. */
  costUsd: number;
}

/**
 * The pluggable quota seam. A self-hosted deployment uses
 * {@link NoopQuotaPolicy} (unlimited). A hosting layer wires its own
 * implementation (or {@link DbQuotaPolicy} reading limits it writes into
 * `org_quotas`). The OSS run-executor calls `checkAdmission` pre-flight and
 * `accrueUsage` on completion.
 */
export interface QuotaPolicy {
  /** PRE-FLIGHT gate. Return `{admit:false, reason}` to block a run before any
   * runner/credential work. MUST NOT throw for a normal deny — denial is a
   * value, not an exception. */
  checkAdmission(orgId: string, requested: AdmissionRequest): Promise<AdmissionDecision>;

  /** POST-RUN accrual. Advance consumed counters from the run's real usage.
   * Best-effort: an accrual failure must never mask a completed run. */
  accrueUsage(orgId: string, usage: RunUsage): Promise<void>;
}

/** A single run's admission request. The only shape the executor constructs. */
export const SINGLE_RUN_REQUEST: AdmissionRequest = { runs: 1 };
