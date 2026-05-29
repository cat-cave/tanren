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

/** Escape-hatch + CI-poll defaults mirroring scripts/acceptance/medium.ts. */
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
  try {
    const { context, orgId } = await loadRunExecutionContext(deps.pool, {
      runId,
      identitySecretRef: deps.identitySecretRef,
    });

    // SaaS Tier-B quota-admission-gate: PRE-FLIGHT check before ANY runner /
    // credential / workflow work. A legacy unscoped run (org_id NULL) is never
    // gated — the unlimited default already admits, and there is no org to
    // attribute usage to. A denied run lands `quota_exceeded` (recoverable) and
    // the job is completed; we never start the workflow.
    if (orgId !== null) {
      const decision = await quotaPolicy.checkAdmission(orgId, SINGLE_RUN_REQUEST);
      if (!decision.admit) {
        const reason = decision.reason ?? "quota exceeded";
        await finalizeRunQuotaExceeded(deps.pool, runId, reason, decision.windowKey);
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
    await finalizeRunRecoverable(deps.pool, runId, failure.message);
    return { kind: "failed", jobId: job.id, runId, failure };
  } finally {
    await stopHeartbeat();
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
async function finalizeRunRecoverable(pool: pg.Pool, runId: string, message: string): Promise<void> {
  const updated = await pool.query(
    "UPDATE runs SET status = 'halted', outcome = 'halted', ended_at = now() WHERE run_id = $1 AND status IN ('running', 'queued', 'failed') RETURNING run_id, spec_id, project_id",
    [runId],
  );
  const row = updated.rows[0] as { spec_id?: unknown; project_id?: unknown } | undefined;
  if (row !== undefined) {
    // Mirror the workflow's recoverable-finalize: emit run.failed so the
    // timeline/notifications surface the worker-level failure. Best-effort —
    // never let an event write mask the original error path.
    await new PgEventStore(pool)
      .append({
        runId,
        specId: String(row.spec_id ?? ""),
        projectId: String(row.project_id ?? ""),
        eventType: "run.failed",
        payload: { status: "halted", message },
      })
      .catch(() => undefined);
  }
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
): Promise<void> {
  const updated = await pool.query(
    "UPDATE runs SET status = 'halted', outcome = 'quota_exceeded', ended_at = now() WHERE run_id = $1 AND status IN ('running', 'queued') RETURNING spec_id, project_id",
    [runId],
  );
  const row = updated.rows[0] as { spec_id?: unknown; project_id?: unknown } | undefined;
  if (row !== undefined) {
    await new PgEventStore(pool)
      .append({
        runId,
        specId: String(row.spec_id ?? ""),
        projectId: String(row.project_id ?? ""),
        eventType: "run.quota_exceeded",
        payload: windowKey === undefined ? { reason } : { reason, windowKey },
      })
      .catch(() => undefined);
  }
}

/**
 * Accrue a completed run's real usage into the quota policy. Reads the run's
 * cost_records (org_id) for the token + dollar totals — ground truth, not an
 * estimate — and hands them to the policy. Best-effort: swallowed so a metering
 * blip never masks a completed run.
 */
async function accrueRunUsage(pool: pg.Pool, policy: QuotaPolicy, orgId: string, runId: string): Promise<void> {
  try {
    const usage = await getRunUsage(pool, runId);
    await policy.accrueUsage(orgId, { runs: 1, tokens: usage.tokens, costUsd: usage.costUsd });
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
