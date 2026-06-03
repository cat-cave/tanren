// Plane-split P3: the REMOTE run-state writer. Routes each of the worker's
// tenant run-state writes — event-append, cost-record insert, run finalize — to
// the control plane's `/internal/*` write endpoints over the mTLS {@link
// MtlsFetch} channel (the SAME mutually-authenticated transport P2 built for the
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
  FinalizeRunInput,
  FinalizeRunResult,
  InsertTaskInput,
  MergeRunVerifiedAncestorShaInput,
  RecordCostInput,
  ReconcileCostInput,
  RunStateWriter,
  SetRunPercolationReexecIdInput,
  SetRunPrUrlInput,
  SetRunSpeculativeBaseInput,
  SetRunStatusInput,
  SetSpecMetadataInput,
  SetSpecStatusInput,
  UpdateTaskInput,
} from "../contracts/runStateWriter.js";
import type { RecordedCost } from "../costs/recorder.js";
import type { EventName } from "../events/index.js";
import type { AppendEventInput } from "../eventStore.js";
import type { SpecContract, SpecRunContract } from "../workflow/projectSpec.js";

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

  // --- Plane-split P3c: the run/spec/task lifecycle writes. ---
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

  // --- Autonomy loops: the run/spec CREATE writes (explicit-actor, multi-table). ---
  //
  // These carry the resolved `actor` (whose `orgId` the loop resolved
  // system-scoped) in the body — NO ambient per-job org lookup — so the server
  // runs the same `createQueuedRunFromSpec` / `createSpec` under that org scope.

  async createQueuedRun(input: CreateQueuedRunInput): Promise<SpecRunContract> {
    return this.post<SpecRunContract>("/internal/create-queued-run", input);
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

  private async post<T>(endpoint: string, body: unknown): Promise<T> {
    const response = await this.mtlsFetch(`${this.baseUrl.replace(/\/$/u, "")}${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new RunStateWriteTransportError(response.status, endpoint, await response.text().catch(() => ""));
    }
    const text = await response.text();
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }
}
