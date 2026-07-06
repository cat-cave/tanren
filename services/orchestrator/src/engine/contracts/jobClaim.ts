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
// TRANSPORT to that CAS differs. See ROADMAP.md
//.

import { z } from "zod";
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

/**
 * Thrown when the control-plane claim endpoint reply cannot be trusted — either
 * a non-2xx status (HTTP-level fault) or a 2xx body whose shape drifted from the
 * wire schema (SCHEMA drift, audit C2 §8). Both are infra faults the worker
 * MUST NOT paper over: silently coercing the reply to `{ job: undefined }` would
 * flip a wrong-shape control-plane bug into a false "no work" and idle every
 * worker — jobs would sit unclaimed with no visible failure. The worker treats
 * this error as back-off-and-retry infra evidence, never as an empty queue.
 */
export class JobClaimTransportError extends Error {
  /** `http_error` — non-2xx from the endpoint. `schema_drift` — 2xx with a body whose shape did not match the wire schema. */
  readonly kind: "http_error" | "schema_drift";
  /** HTTP status for the `http_error` kind; `undefined` for schema drift. */
  readonly status: number | undefined;
  /** Truncated response text for the `http_error` kind; `undefined` for schema drift. */
  readonly body: string | undefined;
  /** Zod issues from the failed body parse for the `schema_drift` kind. */
  readonly issues: readonly z.core.$ZodIssue[] | undefined;
  /** Redacted (keys + value TYPES, not values) preview of the offending payload for `schema_drift`. */
  readonly payloadPreview: string | undefined;

  private constructor(
    message: string,
    fields: {
      kind: "http_error" | "schema_drift";
      status?: number;
      body?: string;
      issues?: readonly z.core.$ZodIssue[];
      payloadPreview?: string;
    },
  ) {
    super(message);
    this.name = "JobClaimTransportError";
    this.kind = fields.kind;
    this.status = fields.status;
    this.body = fields.body;
    this.issues = fields.issues;
    this.payloadPreview = fields.payloadPreview;
  }

  /** Build the HTTP-status variant (non-2xx reply). */
  static httpError(status: number, body: string): JobClaimTransportError {
    return new JobClaimTransportError(`control-plane claim endpoint returned ${status}: ${body.slice(0, 200)}`, {
      kind: "http_error",
      status,
      body,
    });
  }

  /** Build the schema-drift variant (2xx reply whose body failed the wire schema). */
  static schemaDrift(issues: readonly z.core.$ZodIssue[], rawPayload: unknown): JobClaimTransportError {
    const preview = redactedPayloadPreview(rawPayload);
    const summary = issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    return new JobClaimTransportError(
      `control-plane claim endpoint returned a body that did not match the wire schema: ${summary} — payload preview: ${preview}`,
      { kind: "schema_drift", issues, payloadPreview: preview },
    );
  }

  /**
   * Build the schema-drift variant for a body whose bytes were not valid JSON
   * (i.e. `response.json()` threw). Classified under `schema_drift` because it
   * is the same class of fault at the same boundary — the endpoint replied 2xx
   * but the reply is unparseable — and callers should treat it identically.
   */
  static invalidJson(cause: unknown): JobClaimTransportError {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    return new JobClaimTransportError(
      `control-plane claim endpoint returned a 2xx body that failed JSON parse: ${causeMessage}`,
      { kind: "schema_drift", issues: [], payloadPreview: "<unparseable>" },
    );
  }
}

/**
 * The wire shape `/internal/claim-job` returns. The envelope's `payload` stays
 * `unknown` at the transport boundary — the queue is polymorphic across task
 * kinds, and the wire schema validates the ENVELOPE (id/taskKind/attempts/…),
 * not the payload shape (which the task handler validates when it consumes it).
 */
const jobEnvelopeWireSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  taskKind: z.string().min(1),
  payload: z.unknown(),
  attempts: z.number().int().nonnegative(),
  orgId: z.string().min(1).optional(),
});

/**
 * The reply schema for `POST /internal/claim-job`: an envelope OR `null`
 * (empty queue). Parsing THIS at the boundary is what turns a malformed control-
 * plane reply (audit C2 §8) into a loud {@link JobClaimTransportError} instead
 * of a silent "no work" that idles the worker.
 */
const claimJobResponseSchema = z.object({
  job: jobEnvelopeWireSchema.nullable(),
});

/**
 * Redact a value for inclusion in an error message: show the shape (top-level
 * keys + value TYPES) but NEVER the values. A claimed job's `payload` can carry
 * tenant-scoped run details; a redacted preview keeps the error diagnosable
 * without leaking that content into logs.
 */
function redactedPayloadPreview(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value !== "object") return `<${typeof value}>`;
  if (Array.isArray(value)) return `<array[${value.length}]>`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).slice(0, 20);
  const parts = keys.map((key) => {
    const inner = record[key];
    const type = inner === null ? "null" : Array.isArray(inner) ? "array" : typeof inner;
    return `${JSON.stringify(key)}:<${type}>`;
  });
  return `{${parts.join(",")}}`;
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
      throw JobClaimTransportError.httpError(response.status, await response.text().catch(() => ""));
    }
    // Audit C2 §8: parse-on-receive at the HTTP boundary. A malformed body was
    // previously an unchecked `as ClaimJobResponse<TPayload>` cast that let
    // `parsed.job` be `undefined` on schema drift, presenting to the worker as a
    // silent "no work". Failing loud here surfaces the wire-shape fault as an
    // infra error the worker can back off + retry — never a silent idle.
    let rawBody: unknown;
    try {
      rawBody = await response.json();
    } catch (cause) {
      throw JobClaimTransportError.invalidJson(cause);
    }
    const parseResult = claimJobResponseSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw JobClaimTransportError.schemaDrift(parseResult.error.issues, rawBody);
    }
    // Payload is opaque at the wire boundary: the wire schema validates the
    // ENVELOPE shape (id/taskKind/attempts/…); per-task-kind payload validation
    // belongs to the task handler that consumes it. The queue is polymorphic
    // across task kinds, so a single wire schema cannot bind `payload` further.
    const job = parseResult.data.job;
    if (job === null) return undefined;
    const envelope: JobEnvelope<TPayload> = {
      id: job.id,
      taskKind: job.taskKind,
      attempts: job.attempts,
      payload: job.payload as TPayload,
    };
    if (job.runId !== undefined) envelope.runId = job.runId;
    if (job.taskId !== undefined) envelope.taskId = job.taskId;
    if (job.orgId !== undefined) envelope.orgId = job.orgId;
    return envelope;
  }
}
