// P3-0001: the dequeue→execute seam. `executeNextPlanJob` atomically claims one
// queued `plan` job, re-hydrates its `PlannerRunContext`, and runs the real
// plan→write→check→audit→draft-PR→CI workflow to completion.
//
// The workflow (`runPlannerLoopWorkflow`) owns its own run finalization: it
// lands `done/ok` on a pass, `halted/<reason>` on a non-pass loop outcome, and
// (for a generic mid-run throw) `failed/failed`. The worker-level catch here
// does only two extra things the workflow can't:
//   1. fail the claimed job row (so the queue reflects the failure), and
//   2. re-finalize a run the workflow left in a NON-recoverable terminal state
//      (`failed`) or still `running` (a crash) into a recoverable `halted`
//      outcome, so the run surfaces on the P2B-0008 recovery surface rather
//      than disappearing or looking stuck.
//
// Idempotency: the claim is atomic (`FOR UPDATE SKIP LOCKED` → CAS to
// `running`), so a job is handed to exactly one worker. A crash between claim
// and finalize leaves the job `running`; the recovery surface + a future
// reaper own re-queueing — the worker never double-executes a claimed job.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { Allocator } from "../contracts/allocator.js";
import type { JobQueue } from "../contracts/jobQueue.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import type { EscapeHatches } from "../config/index.js";
import { PgEventStore } from "../eventStore.js";
import type { GitHubHttpClient } from "../providers/github.js";
import { loadRunExecutionContext } from "./runExecutionContext.js";
import { runPlannerLoopWorkflow, type PlannerRunResult, type RunPlannerLoopInput } from "../workflow/plannerRun.js";
import { NoopQuotaPolicy, SINGLE_RUN_REQUEST, getRunUsage, type QuotaPolicy } from "../quota/index.js";

/** Escape-hatch + CI-poll defaults the run worker applies to a dequeued plan job. */
export const DEFAULT_ESCAPE_HATCHES: Pick<
  EscapeHatches,
  "maxPlannerRerunsPerSpec" | "maxWriterIterPerSubtask" | "maxRetriesPerTransientFailure"
> = {
  maxPlannerRerunsPerSpec: 5,
  maxWriterIterPerSubtask: 5,
  maxRetriesPerTransientFailure: 3,
};

export const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_CI_POLLS = 18;
export const DEFAULT_CI_POLL_DELAY_MS = 10_000;

// P3-0028 queue lease recovery. While a claimed job executes, the worker
// renews its lease on this interval; the lease window is a multiple of the
// interval so a single missed heartbeat does not trip the reaper. A crashed
// worker stops heartbeating, its lease lapses, and the reaper recovers the job.
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_LEASE_MS = 60_000;

export interface RunExecutorDeps {
  pool: pg.Pool;
  jobQueue: JobQueue;
  allocator: Allocator;
  ssh: SshSubstrate;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  identitySecretRef: string;
  escapeHatches?: Pick<
    EscapeHatches,
    "maxPlannerRerunsPerSpec" | "maxWriterIterPerSubtask" | "maxRetriesPerTransientFailure"
  >;
  timeoutMs?: number;
  maxCiPolls?: number;
  ciPollDelayMs?: number;
  // P3-0028 lease tuning. `leaseMs` is the lease window stamped on claim and on
  // each heartbeat; `heartbeatIntervalMs` is how often the worker renews it
  // while the workflow runs.
  leaseMs?: number;
  heartbeatIntervalMs?: number;
  // SaaS Tier-B quota-admission-gate (OSS↔hosting seam). Defaults to the
  // unlimited NoopQuotaPolicy so self-hosters are unrestricted; a hosting layer
  // wires its own policy (or the DbQuotaPolicy reading `org_quotas`). The
  // executor calls `checkAdmission` pre-flight and `accrueUsage` on completion.
  quotaPolicy?: QuotaPolicy;
  // Test seam: defaults to the real planner-loop workflow. Tests inject a
  // wrapper that calls the real workflow with fake adapters / usage probe so
  // the dequeue→execute seam is proven without real Codex/SSH.
  runWorkflow?: (input: RunPlannerLoopInput) => Promise<PlannerRunResult>;
}

export type ExecuteJobResult =
  | { kind: "idle" }
  | { kind: "completed"; jobId: string; runId: string; outcome: string }
  // SaaS Tier-B quota-admission-gate: the wired QuotaPolicy denied the run
  // pre-flight. The run is finalized `quota_exceeded` (recoverable) and the job
  // is completed (not failed/retried) — re-running is the operator's call once
  // the hosting layer lifts the quota.
  | { kind: "quota_denied"; jobId: string; runId: string; reason: string }
  | { kind: "failed"; jobId: string; runId?: string; failure: { kind: string; message: string } };

/**
 * Claim one queued `plan` job and execute it to completion. Returns `idle`
 * when the queue is empty, `completed` on a finished workflow (including a
 * recoverable halted outcome the workflow itself finalized), or `failed` when
 * the workflow threw — in which case the job is failed and the run is forced
 * into a recoverable state.
 */
export async function executeNextPlanJob(deps: RunExecutorDeps): Promise<ExecuteJobResult> {
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const job = await deps.jobQueue.claim("plan", { leaseMs });
  if (job === undefined) {
    return { kind: "idle" };
  }
  const runId = job.runId;
  if (runId === undefined) {
    const failure = { kind: "invalid_job", message: "plan job is missing a run id" };
    await deps.jobQueue.fail(job.id, failure);
    return { kind: "failed", jobId: job.id, failure };
  }

  // P3-0028: renew the lease on an interval so a healthy worker holds its claim
  // while the (potentially long) workflow runs. The reaper only recovers a job
  // whose lease has lapsed — i.e. a crashed worker that stopped heartbeating.
  const stopHeartbeat = startHeartbeat(deps, job.id, leaseMs);
  const quotaPolicy = deps.quotaPolicy ?? new NoopQuotaPolicy();
  // RLS R2 cohort-3: hoisted so the catch-path recoverable finalize can org-scope
  // its writes. Resolved once the run's execution context loads; stays null for a
  // legacy/unscoped run, or if the context load itself threw (the finalize then
  // falls back to the pool, the pre-cohort-3 behavior).
  let resolvedOrgId: string | null = null;
  try {
    const { context, orgId } = await loadRunExecutionContext(deps.pool, {
      runId,
      identitySecretRef: deps.identitySecretRef,
    });
    resolvedOrgId = orgId;

    // RLS wave R1: the claim above ran under the worker's SYSTEM context — the
    // `job_queue` claim spans tenants (job_queue stays OUTSIDE RLS in R2), so it
    // must NOT carry an org. Now that the claimed job's org is resolved, the
    // worker establishes the PER-JOB org session context and confirms the run is
    // reachable under it. Inert in R1 (no policies read the GUC); R2's policy
    // will key off this `SET LOCAL app.current_org_id`. A legacy/unscoped run
    // (org_id NULL) has no org to set — the per-job context is skipped.
    if (orgId !== null) {
      await establishJobOrgContext(deps.pool, orgId, runId);
    }

    // SaaS Tier-B quota-admission-gate: PRE-FLIGHT check before ANY runner /
    // credential / workflow work. A legacy unscoped run (org_id NULL) is never
    // gated — the unlimited default already admits, and there is no org to
    // attribute usage to. A denied run lands `quota_exceeded` (recoverable) and
    // the job is completed; we never start the workflow.
    if (orgId !== null) {
      // RLS R2 cohort-3 (org_quotas read): run the admission gate inside a short
      // org-scoped transaction so the DbQuotaPolicy's `org_quotas` SELECT carries
      // org context (`SET LOCAL app.current_org_id = <orgId>`). Inert in R1 — the
      // NoopQuotaPolicy default ignores the scope and a pool/scoped read return
      // the same decision.
      const decision = await runWithOrgScope(deps.pool, orgId, () =>
        quotaPolicy.checkAdmission(orgId, SINGLE_RUN_REQUEST),
      );
      if (!decision.admit) {
        const reason = decision.reason ?? "quota exceeded";
        await finalizeRunQuotaExceeded(deps.pool, runId, reason, decision.windowKey, orgId);
        await deps.jobQueue.complete(job.id);
        return { kind: "quota_denied", jobId: job.id, runId, reason };
      }
    }

    const runWorkflow = deps.runWorkflow ?? runPlannerLoopWorkflow;
    const result = await runWorkflow({
      pool: deps.pool,
      allocator: deps.allocator,
      ssh: deps.ssh,
      secrets: deps.secrets,
      githubHttp: deps.githubHttp,
      context,
      escapeHatches: deps.escapeHatches ?? DEFAULT_ESCAPE_HATCHES,
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxCiPolls: deps.maxCiPolls ?? DEFAULT_MAX_CI_POLLS,
      ciPollDelayMs: deps.ciPollDelayMs ?? DEFAULT_CI_POLL_DELAY_MS,
    });
    await deps.jobQueue.complete(job.id);
    // POST-RUN accrual: feed the policy the run's REAL usage from cost_records
    // (org_id). Best-effort — a metering/accrual blip must never mask a
    // completed run, so failures are swallowed.
    if (orgId !== null) {
      await accrueRunUsage(deps.pool, quotaPolicy, orgId, runId);
    }
    return { kind: "completed", jobId: job.id, runId, outcome: result.outcome.kind };
  } catch (error) {
    const failure = { kind: failureKind(error), message: messageOf(error) };
    await deps.jobQueue.fail(job.id, failure);
    await finalizeRunRecoverable(deps.pool, runId, failure.message, resolvedOrgId);
    return { kind: "failed", jobId: job.id, runId, failure };
  } finally {
    await stopHeartbeat();
  }
}

/**
 * RLS wave R1: establish the claimed job's PER-JOB org session context. Opens
 * an org-scoped transaction (`SET LOCAL app.current_org_id = <orgId>`) and
 * confirms the run row is reachable under it — the inert proof that the worker,
 * having claimed cross-org under the system context, then narrows to the job's
 * org before doing tenant work. Throws `JobOrgContextLostError` if the run is
 * not visible under the org GUC (in R1 that can only mean the org/run pairing is
 * wrong; in R2 it would mean a policy filtered it out).
 */
export async function establishJobOrgContext(pool: pg.Pool, orgId: string, runId: string): Promise<void> {
  const visible = await runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query("SELECT 1 FROM runs WHERE run_id = $1 AND org_id = $2", [runId, orgId]);
    return (result.rowCount ?? 0) > 0;
  });
  if (!visible) {
    throw new JobOrgContextLostError(runId, orgId);
  }
}

/** Thrown when a claimed job's run is not reachable under its own org context. */
export class JobOrgContextLostError extends Error {
  constructor(runId: string, orgId: string) {
    super(`run ${runId} not reachable under org context ${orgId}`);
    this.name = "JobOrgContextLostError";
  }
}

/**
 * Start a periodic lease-renewal loop for a claimed job. Returns a stopper that
 * cancels the loop and resolves once it has stopped. The interval defaults to a
 * fraction of the lease window so a single slow/missed beat does not lapse the
 * lease. Heartbeat failures are swallowed — a transient DB blip should not kill
 * the job; if the worker has truly crashed the lease lapses and the reaper acts.
 */
function startHeartbeat(deps: RunExecutorDeps, jobId: string, leaseMs: number): () => Promise<void> {
  const intervalMs = Math.max(1, deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  const control = {
    running: true,
    inFlight: Promise.resolve(),
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  };

  const schedule = (): void => {
    if (!control.running) {
      return;
    }
    control.timer = setTimeout(() => {
      // Swallow heartbeat failures: a transient DB blip should not kill the
      // job; a truly crashed worker stops beating and the reaper recovers it.
      control.inFlight = deps.jobQueue
        .heartbeat(jobId, leaseMs)
        .catch(() => undefined)
        .then(schedule);
    }, intervalMs);
    if (typeof control.timer.unref === "function") {
      control.timer.unref();
    }
  };

  schedule();

  return async () => {
    control.running = false;
    if (control.timer !== undefined) {
      clearTimeout(control.timer);
    }
    await control.inFlight;
  };
}

/**
 * Force a run that a failed workflow left in a non-recoverable terminal state
 * (`failed`) or still `running` (crash) into a recoverable `halted` outcome so
 * it lands on the recovery surface (`RECOVERABLE_OUTCOMES`). A run the workflow
 * already finalized as recoverable (halted / window_exhausted /
 * retry_budget_exhausted) or terminal-good (`done`) is left untouched.
 */
async function finalizeRunRecoverable(
  pool: pg.Pool,
  runId: string,
  message: string,
  orgId: string | null,
): Promise<void> {
  // RLS R2 cohort-3 (worker failure-path finalizer): when the run's org is known
  // (resolved from its execution context), run the finalize UPDATE + the
  // run.failed event in ONE org-scoped transaction so both writes carry org
  // context (`SET LOCAL app.current_org_id = <orgId>`). The catch path previously
  // ran with NO ambient scope; this establishes one. A legacy/unscoped run
  // (org_id NULL) — or a context load that itself failed — falls back to the pool,
  // the pre-cohort-3 behavior. Inert in R1; RLS-correct in R3.
  await withRunFinalizeScope(pool, orgId, async (client) => {
    const updated = await client.query(
      "UPDATE runs SET status = 'halted', outcome = 'halted', ended_at = now() WHERE run_id = $1 AND status IN ('running', 'queued', 'failed') RETURNING run_id, spec_id, project_id",
      [runId],
    );
    const row = updated.rows[0] as { spec_id?: unknown; project_id?: unknown } | undefined;
    if (row !== undefined) {
      // Mirror the workflow's recoverable-finalize: emit run.failed so the
      // timeline/notifications surface the worker-level failure. Best-effort —
      // never let an event write mask the original error path. PgEventStore is
      // handed the in-scope client so its INSERT joins this transaction.
      await new PgEventStore(client)
        .append({
          runId,
          specId: String(row.spec_id ?? ""),
          projectId: String(row.project_id ?? ""),
          eventType: "run.failed",
          payload: { status: "halted", message },
        })
        .catch(() => undefined);
    }
  });
}

/**
 * Finalize a denied run into the recoverable `quota_exceeded` terminal state
 * and emit `run.quota_exceeded` so it surfaces on the P2B-0008 recovery surface
 * + the hosting layer's billing/upgrade UX. Mirrors `finalizeRunRecoverable`'s
 * best-effort event append (an event-write blip never masks the deny path).
 */
async function finalizeRunQuotaExceeded(
  pool: pg.Pool,
  runId: string,
  reason: string,
  windowKey: string | undefined,
  orgId: string | null,
): Promise<void> {
  // RLS R2 cohort-3 (worker failure-path finalizer): the deny path's finalize
  // UPDATE + run.quota_exceeded event run in one org-scoped transaction when the
  // org is known (the gate's call site always has it). Mirrors
  // `finalizeRunRecoverable`'s scoping + best-effort event append.
  await withRunFinalizeScope(pool, orgId, async (client) => {
    const updated = await client.query(
      "UPDATE runs SET status = 'halted', outcome = 'quota_exceeded', ended_at = now() WHERE run_id = $1 AND status IN ('running', 'queued') RETURNING spec_id, project_id",
      [runId],
    );
    const row = updated.rows[0] as { spec_id?: unknown; project_id?: unknown } | undefined;
    if (row !== undefined) {
      await new PgEventStore(client)
        .append({
          runId,
          specId: String(row.spec_id ?? ""),
          projectId: String(row.project_id ?? ""),
          eventType: "run.quota_exceeded",
          payload: windowKey === undefined ? { reason } : { reason, windowKey },
        })
        .catch(() => undefined);
    }
  });
}

/**
 * Run a run-finalize body (UPDATE + best-effort event append) under the run's
 * org scope when the org is known, else on the pool (the pre-cohort-3 fallback).
 * Centralizes the org-scoping the two worker failure-path finalizers share: a
 * known org opens a `SET LOCAL app.current_org_id = <org>` transaction and hands
 * the body the scoped client; a null org hands it the pool verbatim so behavior
 * is identical to before the cohort.
 */
async function withRunFinalizeScope(
  pool: pg.Pool,
  orgId: string | null,
  body: (client: pg.Pool | pg.PoolClient) => Promise<void>,
): Promise<void> {
  if (orgId === null) {
    await body(pool);
    return;
  }
  await runWithOrgScope(pool, orgId, (client) => body(client));
}

/**
 * Accrue a completed run's real usage into the quota policy. Reads the run's
 * cost_records (org_id) for the token + dollar totals — ground truth, not an
 * estimate — and hands them to the policy. Best-effort: swallowed so a metering
 * blip never masks a completed run.
 */
async function accrueRunUsage(pool: pg.Pool, policy: QuotaPolicy, orgId: string, runId: string): Promise<void> {
  try {
    // RLS R2 cohort-2 (cost_records read) + cohort-3 (org_quotas write): both the
    // post-run metering read AND the policy's accrual UPDATE run inside ONE short
    // org-scoped transaction (`SET LOCAL app.current_org_id = <orgId>`), so the
    // `cost_records` SELECT and the `org_quotas` write both carry org context.
    // Inert in R1 — same totals + same accrued counters as the pool path — and
    // RLS-correct in R3.
    await runWithOrgScope(pool, orgId, async (client) => {
      const usage = await getRunUsage(client, runId);
      await policy.accrueUsage(orgId, { runs: 1, tokens: usage.tokens, costUsd: usage.costUsd });
    });
  } catch {
    // Accrual is best-effort; never fail a completed run on a metering blip.
  }
}

function failureKind(error: unknown): string {
  if (error instanceof Error && error.name !== "" && error.name !== "Error") {
    return error.name;
  }
  return "run_execution_failed";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
