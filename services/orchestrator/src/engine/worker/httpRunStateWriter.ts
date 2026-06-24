// The REMOTE run-state writer. Routes each of the worker's
// tenant run-state writes — event-append, cost-record insert, run finalize — to
// the control plane's `/internal/*` write endpoints over the mTLS {@link
// MtlsFetch} channel (the SAME mutually-authenticated transport used for the
// claim endpoint). The control plane then runs the EXACT SAME org-scoped write
// server-side, under ITS DB access — so the data plane needs no broad tenant
// write grants. Enabled by `TANREN_DATA_PLANE_REMOTE_WRITES=1`.
//
// WHAT GETS WRITTEN IS IDENTICAL to the direct path: the endpoints reuse the
// worker's own store logic, only server-side. Exactly-once is preserved — the
// finalize endpoint applies the same `fromStatuses` guard, so a retried finalize
// matches no row the second time (no duplicate finalize/event); event/cost
// inserts are the same single INSERT the direct path runs.

import { getJobOrgId } from "@tanren/db";
import type { MtlsFetch } from "../contracts/mtlsChannel.js";
import type {
  ClearRunPercolationPendingInput,
  CreateQueuedRunInput,
  CreateSpecRemoteInput,
  FinalizeLandInput,
  FinalizeRunInput,
  FinalizeRunResult,
  InsertTaskInput,
  MergeRunVerifiedAncestorShaInput,
  RecordCostInput,
  ReconcileCostInput,
  RunStateWriter,
  SetRunAuthRefInput,
  SetRunPercolationReexecIdInput,
  SetRunPrUrlInput,
  SetRunSpeculativeBaseInput,
  SetRunStatusInput,
  SetSpecMetadataInput,
  SetSpecStatusInput,
  UpdateTaskInput,
  UpdateTaskWithEventInput,
  UpdateTaskWithEventOutcome,
} from "../contracts/runStateWriter.js";
import type { RecordedCost } from "../costs/recorder.js";
import type { EventName } from "../events/index.js";
import type { AppendEventInput } from "../eventStore.js";
import type { SpecContract, SpecRunContract } from "../workflow/projectSpec.js";
import { SpecDependenciesBlockedError, SpecNotRunnableError } from "../workflow/projectSpecErrors.js";

/** Thrown when a control-plane write endpoint returns a non-2xx status. */
export class RunStateWriteTransportError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    body: string,
  ) {
    super(`control-plane write endpoint ${endpoint} returned ${status}: ${body.slice(0, 200)}`);
    this.name = "RunStateWriteTransportError";
  }
}

/**
 * The remote run-state writer. POSTs each write to the control plane over mTLS.
 * A 401 (untrusted peer) or any non-2xx surfaces as {@link
 * RunStateWriteTransportError}, which the worker treats as an infra fault — the
 * write did NOT land, so the worker never assumes a phantom success.
 */
export class HttpRunStateWriter implements RunStateWriter {
  constructor(
    private readonly baseUrl: string,
    private readonly mtlsFetch: MtlsFetch,
  ) {}

  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    // The server scopes the INSERT to the event's org (`runWithOrgScope`), so the
    // body carries it — the per-job org-id the caller set (`runWithJobOrgId`), the
    // same scope the in-process write used. A PROJECT-scoped event (the DagWalker's
    // dag.drained / dag.budget.paused / dag.concurrency.saturated) carries no
    // runId/specId; those keys are simply absent from `input`, so the server inserts
    // NULL run_id/spec_id — identical to the direct `PgEventStore.append`.
    await this.post<void>("/internal/append-event", { ...input, orgId: this.requireOrgId() });
  }

  async recordCost(input: RecordCostInput): Promise<RecordedCost> {
    return this.post<RecordedCost>("/internal/record-cost", { ...input, orgId: this.requireOrgId() });
  }

  async reconcileCost(input: ReconcileCostInput): Promise<{ updated: number }> {
    // reconcileCost carries the org explicitly (the worker resolves it from the
    // claimed job and threads it into the recorder's reconcile delegate), so no
    // ambient lookup is needed — mirroring finalizeRun.
    return this.post<{ updated: number }>("/internal/reconcile-cost", input);
  }

  async finalizeRun(input: FinalizeRunInput): Promise<FinalizeRunResult> {
    // finalizeRun carries the org explicitly (the worker resolves it from the
    // claimed job), so no ambient lookup is needed.
    return this.post<FinalizeRunResult>("/internal/finalize-run", input);
  }

  // --- the run/spec/task lifecycle writes. ---
  //
  // The run/spec ops carry an explicit org (the workflow has the run context);
  // the task ops resolve org from the ambient per-job scope (`requireOrgId`),
  // exactly like `append` — the server scopes every write with `runWithOrgScope`.

  async setRunStatus(input: SetRunStatusInput): Promise<void> {
    await this.post<void>("/internal/set-run-status", input);
  }

  async setRunPrUrl(input: SetRunPrUrlInput): Promise<void> {
    await this.post<void>("/internal/set-run-pr-url", input);
  }

  async setRunAuthRef(input: SetRunAuthRefInput): Promise<void> {
    // The subtask loop carries no explicit org, so resolve it from the ambient
    // per-job scope when omitted (like the `tasks` ops).
    await this.post<void>("/internal/set-run-auth-ref", { ...input, orgId: input.orgId ?? this.requireOrgId() });
  }

  async finalizeLand(input: FinalizeLandInput): Promise<{ auditId: string }> {
    // The §5 durable land transaction carries the org explicitly (the merge stage holds
    // the run context), so no ambient lookup is needed — mirroring finalizeRun.
    return this.post<{ auditId: string }>("/internal/finalize-land", input);
  }

  async setSpecStatus(input: SetSpecStatusInput): Promise<void> {
    await this.post<void>("/internal/set-spec-status", input);
  }

  async setSpecMetadata(input: SetSpecMetadataInput): Promise<void> {
    await this.post<void>("/internal/set-spec-metadata", input);
  }

  async setRunSpeculativeBase(input: SetRunSpeculativeBaseInput): Promise<void> {
    await this.post<void>("/internal/set-run-speculative-base", input);
  }

  async setRunPercolationReexecId(input: SetRunPercolationReexecIdInput): Promise<void> {
    await this.post<void>("/internal/set-run-percolation-reexec-id", input);
  }

  async clearRunPercolationPending(input: ClearRunPercolationPendingInput): Promise<void> {
    await this.post<void>("/internal/clear-run-percolation-pending", input);
  }

  async mergeRunVerifiedAncestorSha(input: MergeRunVerifiedAncestorShaInput): Promise<void> {
    await this.post<void>("/internal/merge-run-verified-ancestor-sha", input);
  }

  async supersedeQueuedPlannerTask(input: { runId: string; orgId?: string }): Promise<void> {
    await this.post<void>("/internal/supersede-queued-planner-task", {
      runId: input.runId,
      orgId: input.orgId ?? this.requireOrgId(),
    });
  }

  async insertTask(input: InsertTaskInput): Promise<void> {
    await this.post<void>("/internal/insert-task", { ...input, orgId: input.orgId ?? this.requireOrgId() });
  }

  async updateTask(input: UpdateTaskInput): Promise<void> {
    await this.post<void>("/internal/update-task", { ...input, orgId: input.orgId ?? this.requireOrgId() });
  }

  async updateTaskWithEvent(input: UpdateTaskWithEventInput): Promise<UpdateTaskWithEventOutcome> {
    // The atomic terminal-row + terminal-event seam (task #39). Resolve the
    // task's org explicitly (the row UPDATE + event INSERT run on ONE
    // org-scoped transaction server-side); a missing org throws loud rather
    // than posting an unscoped write the server would deny under enforced RLS.
    //
    // Task #40 Class B — RPC phantom-write idempotency. The route returns 204
    // (no body) on a FRESH apply and `200 { alreadyTerminal: true }` when the
    // server-side `ON CONFLICT DO NOTHING` deduped the event INSERT because
    // the ORIGINAL apply already committed and only its HTTP response was
    // DROPPED en route. The 200 path is NOT a partial / failed write — the
    // ORIGINAL row + event are durable; the wrapping helpers
    // (`markTaskDoneWithEvent` etc.) treat `alreadyTerminal: true` as a
    // SILENT success so the finalize-guard's recovery call doesn't surface as
    // a fresh error after the original work already landed.
    const orgId = input.task.orgId ?? this.requireOrgId();
    return this.postWithStatus<UpdateTaskWithEventOutcome>(
      "/internal/update-task-with-event",
      { task: { ...input.task, orgId }, event: input.event },
      (status, body) => {
        if (status === 200) {
          return body as UpdateTaskWithEventOutcome;
        }
        // 204 (or any other 2xx) means this call wrote the pair fresh.
        return { alreadyTerminal: false };
      },
    );
  }

  // --- Autonomy loops: the run/spec CREATE writes (explicit-actor, multi-table). ---
  //
  // These carry the resolved `actor` (whose `orgId` the loop resolved
  // system-scoped) in the body — NO ambient per-job org lookup — so the server
  // runs the same `createQueuedRunFromSpec` / `createSpec` under that org scope.

  async createQueuedRun(input: CreateQueuedRunInput): Promise<SpecRunContract> {
    // The endpoint returns a TYPED 409 for either of the two BENIGN per-spec
    // enqueue conditions; reconstruct the real typed error so it crosses the wire
    // INTACT and the walker's benign-skip tolerance applies identically to the
    // in-process path:
    //   - `{ error: "spec_not_runnable", specId, status }` — the EXPECTED
    //     concurrent-tick race (a spec already past `open`, the open→in_flight
    //     idempotency boundary) → SpecNotRunnableError.
    //   - `{ error: "spec_dependencies_blocked", specId, blockedBy }` — the spec's
    //     dependencies are not yet `merged` at enqueue time (the planner saw them
    //     merged via the lifecycle projection, but the `specs.status='merged'` write
    //     was not yet visible to this tx) → SpecDependenciesBlockedError.
    // Any OTHER non-2xx (and any 409 whose body matches NEITHER shape) stays a
    // RunStateWriteTransportError (a genuine infra fault still surfaces loudly).
    return this.post<SpecRunContract>("/internal/create-queued-run", input, reconstructBenignEnqueueError);
  }

  async createSpec(input: CreateSpecRemoteInput): Promise<SpecContract> {
    return this.post<SpecContract>("/internal/create-spec", input);
  }

  /**
   * The run's org for an event/cost write — the ambient per-job org-id the worker
   * set with `runWithJobOrgId` around the workflow. A remote write outside that
   * scope (no per-job org) is a wiring bug: throw loudly rather than post an
   * unscoped write the server would deny under enforced RLS.
   */
  private requireOrgId(): string {
    const orgId = getJobOrgId();
    if (orgId === undefined) {
      throw new Error("HttpRunStateWriter: no per-job org-id in scope — a remote write must run under runWithJobOrgId");
    }
    return orgId;
  }

  private async post<T>(
    endpoint: string,
    body: unknown,
    // An optional per-call mapper for a non-2xx response: it reconstructs an
    // endpoint-specific TYPED error (e.g. the create-queued-run 409
    // `spec_not_runnable`) so the typed error crosses the wire intact. Returning
    // `undefined` falls back to the default RunStateWriteTransportError — so a
    // genuine fault on ANY endpoint (and any status this mapper does not claim)
    // still surfaces loudly. Other callers pass no mapper and keep the default.
    mapError?: (status: number, responseBody: string) => Error | undefined,
  ): Promise<T> {
    const response = await this.mtlsFetch(`${this.baseUrl.replace(/\/$/u, "")}${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      const mapped = mapError?.(response.status, responseBody);
      throw mapped ?? new RunStateWriteTransportError(response.status, endpoint, responseBody);
    }
    const text = await response.text();
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }

  /**
   * Status-aware POST (task #40 Class B): identical to {@link post} on the
   * non-2xx error path (a genuine infra fault still surfaces as
   * RunStateWriteTransportError), but on success hands the caller BOTH the
   * status code AND the parsed body so the route's 200-vs-204 distinction
   * (`alreadyTerminal: true` vs the fresh write) can be surfaced typed at the
   * seam. The `mapSuccess` callback owns the success-side mapping — the same
   * shape `post` uses for `mapError` on the failure side.
   */
  private async postWithStatus<T>(
    endpoint: string,
    body: unknown,
    mapSuccess: (status: number, parsedBody: unknown) => T,
  ): Promise<T> {
    const response = await this.mtlsFetch(`${this.baseUrl.replace(/\/$/u, "")}${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      throw new RunStateWriteTransportError(response.status, endpoint, responseBody);
    }
    const text = await response.text();
    const parsed: unknown = text === "" ? undefined : JSON.parse(text);
    return mapSuccess(response.status, parsed);
  }
}

/**
 * The createQueuedRun error mapper: reconstruct one of the two TYPED benign
 * per-spec enqueue errors from a typed 409 body, so it crosses the wire intact and
 * the walker's benign-skip tolerance applies identically to the control-plane path.
 * A non-409, or a 409 whose body matches NEITHER typed shape, returns `undefined` —
 * so {@link HttpRunStateWriter.post} falls back to the generic
 * RunStateWriteTransportError and a genuine fault still surfaces loudly.
 */
function reconstructBenignEnqueueError(status: number, body: string): Error | undefined {
  if (status !== 409) {
    return undefined;
  }
  const notRunnable = parseSpecNotRunnable(body);
  if (notRunnable !== undefined) {
    return new SpecNotRunnableError(notRunnable.specId, notRunnable.status);
  }
  const blocked = parseSpecDependenciesBlocked(body);
  return blocked === undefined ? undefined : new SpecDependenciesBlockedError(blocked.specId, blocked.blockedBy);
}

/**
 * Parse a `{ error: "spec_not_runnable", specId, status }` 409 body into its
 * specId/status. Returns `undefined` for any other shape (so the caller falls
 * back to the generic transport error — a genuine fault is never masked).
 */
function parseSpecNotRunnable(body: string): { specId: string; status: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const specId = record["specId"];
  const status = record["status"];
  if (record["error"] !== "spec_not_runnable" || typeof specId !== "string" || typeof status !== "string") {
    return undefined;
  }
  return { specId, status };
}

/**
 * Parse a `{ error: "spec_dependencies_blocked", specId, blockedBy }` 409 body
 * into its specId/blockedBy. Returns `undefined` for any other shape (so the
 * caller falls back to the generic transport error — a genuine fault is never
 * masked). `blockedBy` must be an array of strings.
 */
function parseSpecDependenciesBlocked(body: string): { specId: string; blockedBy: string[] } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const specId = record["specId"];
  const blockedBy = record["blockedBy"];
  if (
    record["error"] !== "spec_dependencies_blocked" ||
    typeof specId !== "string" ||
    !Array.isArray(blockedBy) ||
    !blockedBy.every((id) => typeof id === "string")
  ) {
    return undefined;
  }
  return { specId, blockedBy };
}
