// The job-CLAIM seam between the data plane (worker) and the
// control plane (orchestrator). The worker can claim directly from `job_queue`
// via DB-CAS, or — when wired — behind a control-plane endpoint so the data
// plane needs no direct `job_queue` write access in the cross-process topology.
//
// The seam is one interface — {@link JobClaimClient} — with two impls:
//   - `DirectJobClaimClient` wraps the existing `JobQueue.claim` (the same
//     atomic `FOR UPDATE SKIP LOCKED` CAS). The single-process dev path
//     (`TANREN_RUN_WORKER=1`) keeps this — it shares the API's pool, so routing
//     its claim over a network hop would add risk for no isolation gain.
//   - `HttpJobClaimClient` POSTs to the control-plane `/internal/claim-job`
//     endpoint over the mTLS channel ({@link MtlsFetch}). The cross-process
//     `worker` container uses this so its claim crosses the authenticated
//     control↔data boundary instead of touching the DB.
//
// CLAIM SEMANTICS ARE UNCHANGED in both impls: the endpoint's handler calls the
// SAME `JobQueue.claim`, so exactly-once is preserved end to end. Only the
// TRANSPORT to that CAS differs. See docs/roadmap/saas-rls-and-plane-split-plan.md
//.

import type { JobEnvelope, JobQueue } from "./jobQueue.js";
import type { MtlsFetch } from "./mtlsChannel.js";

/** Options carried with a claim (the lease window the claim stamps). */
export interface ClaimJobOptions {
  taskKind: string;
  runId?: string;
  leaseMs?: number;
}

/**
 * Claim one queued job for execution. Returns the claimed {@link JobEnvelope}
 * (incl. its `org_id` threaded on the queue row) or `undefined` when the queue
 * is empty. The control plane guarantees a job is returned to AT MOST ONE caller
 * (the atomic CAS the endpoint wraps); a worker never double-executes.
 */
export interface JobClaimClient<TPayload = unknown> {
  claimJob(options: ClaimJobOptions): Promise<JobEnvelope<TPayload> | undefined>;
}

/**
 * The in-process / dev claim client: delegates straight to {@link
 * JobQueue.claim} (the unchanged DB-CAS). Used by the single-process
 * `TANREN_RUN_WORKER=1` path, which shares the API's pool.
 */
export class DirectJobClaimClient<TPayload = unknown> implements JobClaimClient<TPayload> {
  constructor(private readonly jobQueue: JobQueue<TPayload>) {}

  async claimJob(options: ClaimJobOptions): Promise<JobEnvelope<TPayload> | undefined> {
    const claimOptions: { runId?: string; leaseMs?: number } = {};
    if (options.runId !== undefined) {
      claimOptions.runId = options.runId;
    }
    if (options.leaseMs !== undefined) {
      claimOptions.leaseMs = options.leaseMs;
    }
    return this.jobQueue.claim(options.taskKind, claimOptions);
  }
}

/** Thrown when the control plane returns a non-2xx status for a claim. */
export class JobClaimTransportError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`control-plane claim endpoint returned ${status}: ${body.slice(0, 200)}`);
    this.name = "JobClaimTransportError";
  }
}

/** The wire shape `/internal/claim-job` returns. */
export interface ClaimJobResponse<TPayload = unknown> {
  job: JobEnvelope<TPayload> | null;
}

/**
 * The cross-process claim client: POSTs the claim request to the control-plane
 * `/internal/claim-job` endpoint over the mTLS {@link MtlsFetch} channel. The
 * data plane no longer touches `job_queue` to claim — it asks the control plane,
 * which runs the SAME atomic CAS and returns the claimed envelope. A 401 (the
 * caller is not a trusted mTLS peer) or any non-2xx surfaces as {@link
 * JobClaimTransportError}, which the worker treats as an infra fault (back off,
 * never double-execute).
 */
export class HttpJobClaimClient<TPayload = unknown> implements JobClaimClient<TPayload> {
  constructor(
    private readonly baseUrl: string,
    private readonly mtlsFetch: MtlsFetch,
  ) {}

  async claimJob(options: ClaimJobOptions): Promise<JobEnvelope<TPayload> | undefined> {
    const response = await this.mtlsFetch(`${this.baseUrl.replace(/\/$/u, "")}/internal/claim-job`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options),
    });
    if (!response.ok) {
      throw new JobClaimTransportError(response.status, await response.text().catch(() => ""));
    }
    const parsed = (await response.json()) as ClaimJobResponse<TPayload>;
    return parsed.job ?? undefined;
  }
}
