// AUDIT FINDING H3 sweep — the writer-seam doctrine fixture. Implements the
// full `RunStateWriter` contract over in-memory state so unit tests that drive
// workflow stages no longer rely on a writer-undefined fallback arm (the fix
// the audit findings D2/D3/H3 named). One fixture, drop-in everywhere:
//
//   const writer = new InMemoryRunStateWriter();
//   await runWriterStage({ ..., writer });
//   expect(writer.atomic).toContainEqual({ task: ..., event: ... });
//
// Records what the seam saw — `appends` for `.append()`, `atomic` for each
// `.updateTaskWithEvent({ task, event, priorEvents? })` call (with prior
// events captured ATOMICALLY alongside the terminal pair, so a tx-count
// assertion proves the priorEvents-bundled write was one transaction). Also
// records the simpler lifecycle ops (`insertTask`, `updateTask`, etc.) the
// stages drive through the writer's non-atomic methods so existing test
// assertions (`task-row status moved`) keep holding.
//
// Methods the per-stage tests don't exercise (recordCost, reconcileCost,
// finalizeRun, the autonomy-loop ops) THROW LOUDLY with a clear name — if a
// test reaches them it's a wiring bug, not a degraded silent path.

import {
  resumePausedRunPairSchema,
  runPairSchema,
  specPairSchema,
  terminalPairSchema,
} from "../../src/engine/worker/runStateLifecycleSql.js";
import type { AppendEventInput, EventStore } from "../../src/engine/eventStore.js";
import type { RecordedCost, RecordCostInput, ReconcileCostInput } from "../../src/engine/costs/recorder.js";
import type {
  AppendSpecSteeringInput,
  ClearRunPercolationPendingInput,
  CreateQueuedRunInput,
  CreateSpecRemoteInput,
  FinalizeLandInput,
  FinalizeRunInput,
  FinalizeRunResult,
  FinalizeRunWithEventInput,
  FinalizeRunWithEventOutcome,
  InsertTaskInput,
  MergeRunVerifiedAncestorShaInput,
  ResumePausedRunAtomicInput,
  ResumePausedRunAtomicOutcome,
  RunStateWriter,
  SetRunAuthRefInput,
  SetRunPercolationReexecIdInput,
  SetRunPrUrlInput,
  SetRunSpeculativeBaseInput,
  SetRunStatusInput,
  SetSpecMetadataInput,
  SetSpecStatusInput,
  UpdateSpecWithEventInput,
  UpdateSpecWithEventOutcome,
  UpdateTaskInput,
  UpdateTaskWithEventInput,
  UpdateTaskWithEventOutcome,
} from "../../src/engine/contracts/runStateWriter.js";
import type { SpecContract, SpecRunContract } from "../../src/engine/workflow/projectSpec.js";

/**
 * Records ONE `writer.updateTaskWithEvent` call. The `priorEvents` slot is
 * the audit-D2 writer-seam extension — when present, those events landed in
 * the SAME transaction as the row + terminal event (the atomicity contract
 * the conformance suite pins against a real Postgres).
 */
export interface AtomicTerminalRecord {
  task: UpdateTaskWithEventInput["task"];
  event: UpdateTaskWithEventInput["event"];
  priorEvents: ReadonlyArray<AppendEventInput>;
}

/** A row-state mutation a test asserts on (mirrors the SQL `applyUpdateTask` shape). */
export interface TaskRow {
  taskId: string;
  status: string;
  outcome: string | null;
  failureKind: string | null;
}

/**
 * In-memory writer fixture. Records every observable write. Tests that need
 * to forward events to their own recorder (e.g. the per-stage harnesses with
 * a `h.appendEvent` recorder) can pass a `forwardAppend` callback — the
 * fixture invokes it after recording, mirroring what the prior
 * `appendEventFallback` did, but without the writer-undefined fallback arm.
 */
export class InMemoryRunStateWriter implements RunStateWriter {
  readonly appends: AppendEventInput[] = [];
  readonly atomic: AtomicTerminalRecord[] = [];
  readonly inserts: InsertTaskInput[] = [];
  readonly updates: UpdateTaskInput[] = [];
  readonly tasks = new Map<string, TaskRow>();

  /**
   * Count atomic transactions the writer committed (audit D2 atomicity proof
   * fixture): each `updateTaskWithEvent` call is ONE transaction regardless
   * of `priorEvents.length`. A test that bundles N pre-terminal events
   * asserts the count incremented by 1 (not N+1) to prove the bundle
   * committed together.
   */
  get atomicTxCount(): number {
    return this.atomic.length;
  }

  /**
   * Cross-cutting events list — every event the writer saw, in order, with
   * the pre-terminal `priorEvents` flattened into the terminal pair's slot
   * so a test can assert the WHOLE timeline (matching what a real Pg
   * `events` table would carry post-commit).
   */
  get allEvents(): ReadonlyArray<AppendEventInput> {
    const events: AppendEventInput[] = [];
    for (const a of this.appends) {
      events.push(a);
    }
    for (const t of this.atomic) {
      for (const p of t.priorEvents) {
        events.push(p);
      }
      events.push(t.event);
    }
    return events;
  }

  constructor(
    private readonly options: {
      /** Optional event-recorder forwarder (mirrors the prior `appendEventFallback` shape). */
      forwardAppend?: EventStore["append"];
      /**
       * Optional `insertTask` forwarder so a test harness that previously
       * recorded task INSERTs off the pool's SQL stub (audit H3 sweep
       * shifted the path through the writer) can still record them in its
       * existing structures without rewriting every assertion.
       */
      forwardInsertTask?: (input: InsertTaskInput) => Promise<void> | void;
      /**
       * Optional `updateTask` / atomic-terminal forwarder so the same
       * harnesses can reflect the writer's row-state mutation into their
       * existing `pool.tasks` arrays (the audit H3 sweep shifted the path
       * through the writer; this is the test-side mirror of that path).
       */
      forwardUpdateTask?: (input: UpdateTaskInput) => Promise<void> | void;
      /**
       * Optional `setRunAuthRef` forwarder so a test harness that asserts on
       * `runs.auth_ref` stamps off the pool's SQL stub still sees them.
       */
      forwardSetRunAuthRef?: (input: SetRunAuthRefInput) => Promise<void> | void;
    } = {},
  ) {}

  async append(input: AppendEventInput): Promise<void> {
    this.appends.push(input);
    if (this.options.forwardAppend !== undefined) {
      await this.options.forwardAppend(input);
    }
  }

  async insertTask(input: InsertTaskInput): Promise<void> {
    this.inserts.push(input);
    this.tasks.set(input.taskId, {
      taskId: input.taskId,
      status: input.status,
      outcome: null,
      failureKind: null,
    });
    if (this.options.forwardInsertTask !== undefined) {
      await this.options.forwardInsertTask(input);
    }
  }

  async updateTask(input: UpdateTaskInput): Promise<void> {
    this.updates.push(input);
    this.applyTransitionToRow(input);
    if (this.options.forwardUpdateTask !== undefined) {
      await this.options.forwardUpdateTask(input);
    }
  }

  async updateTaskWithEvent(input: UpdateTaskWithEventInput): Promise<UpdateTaskWithEventOutcome> {
    // Round-3 audit finding H-R3.3: the InMemory fixture is conformance-equivalent
    // to the production `DirectRunStateWriter`. Run the SAME `terminalPairSchema`
    // parse the direct writer runs at this seam so a contract drift (terminal
    // event in priorEvents, missing idempotencyKey, mismatched pair, malformed
    // shape) fails LOUD in tests rather than silently passing while production
    // would crash. The schema enforces:
    //   - H-R3.1: priorEvents.eventType MUST NOT be a terminal task/run type.
    //   - H-R3.2: priorEvents[*].idempotencyKey REQUIRED; runId REQUIRED.
    //   - terminal task transition + matching terminal event pair (task #39).
    terminalPairSchema.parse(input);
    // Round-3 audit finding H-R3.2 idempotency: a retried atomic write with the
    // SAME (runId, idempotencyKey) tuple on a prior event MUST NOT double-emit
    // (mirrors the production `events_prior_idempotency_unique` partial index
    // + `ON CONFLICT DO NOTHING`). Dedupe entries we've already seen so the
    // fixture's `allEvents`/`atomic[*].priorEvents` shapes match what a real PG
    // commit would store after the retry.
    const allPriors: ReadonlyArray<AppendEventInput & { idempotencyKey: string; runId: string }> =
      input.priorEvents ?? [];
    const dedupedPriors: AppendEventInput[] = [];
    for (const p of allPriors) {
      const key = `${p.runId}::${p.idempotencyKey}`;
      if (this.priorIdempotencyKeys.has(key)) {
        continue;
      }
      this.priorIdempotencyKeys.add(key);
      dedupedPriors.push(p);
    }
    // Mirror the SQL applier's transaction semantics so a forwarded-append
    // throw rolls back the whole bundle (row + terminal event + priorEvents).
    // The forwarded appends run FIRST so a throw aborts before the row + the
    // atomic record are committed — analogous to the applier's `ROLLBACK` on
    // an event INSERT throw inside the transaction.
    if (this.options.forwardAppend !== undefined) {
      for (const p of dedupedPriors) {
        await this.options.forwardAppend(p);
      }
      await this.options.forwardAppend(input.event);
    }
    this.atomic.push({ task: input.task, event: input.event, priorEvents: dedupedPriors });
    this.applyTransitionToRow(input.task);
    if (this.options.forwardUpdateTask !== undefined) {
      await this.options.forwardUpdateTask(input.task);
    }
    return { alreadyTerminal: false };
  }

  /**
   * Round-3 H-R3.2 fixture-side dedupe ledger: tracks the (runId, idempotencyKey)
   * tuples the fixture has seen across `updateTaskWithEvent` calls so a retry
   * of the SAME bundle's priors does not double-emit (mirrors the production
   * partial unique index `events_prior_idempotency_unique`).
   */
  private readonly priorIdempotencyKeys = new Set<string>();

  // --- methods workflow stages drive but unit tests usually don't assert on. ---
  // The defaults are RECORD-OR-NOOP-and-succeed so a test wiring this fixture
  // through `RunExecutorDeps.runStateWriter` (the writer-required boot path)
  // doesn't trip a "not wired" throw on a run finalize the test doesn't care
  // about. Tests that DO care about a specific surface override the
  // corresponding method on the instance.

  readonly recordedCosts: RecordCostInput[] = [];
  async recordCost(input: RecordCostInput): Promise<RecordedCost> {
    this.recordedCosts.push(input);
    // A minimal stand-in row — most tests don't read the returned shape.
    return {
      id: `cost_${this.recordedCosts.length}`,
      costUsd: "0",
      totalTokens: input.tokens.totalTokens,
    } as unknown as RecordedCost;
  }

  async reconcileCost(_input: ReconcileCostInput): Promise<{ updated: number }> {
    return { updated: 0 };
  }

  readonly runFinalizes: FinalizeRunInput[] = [];
  async finalizeRun(input: FinalizeRunInput): Promise<FinalizeRunResult> {
    this.runFinalizes.push(input);
    // The in-memory writer doesn't track run rows; report "updated" so the
    // workflow's follow-on event append runs (the canonical finalize-then-event
    // shape). Tests that need to assert UPDATE-was-no-op can override.
    return { updated: true, specId: "", projectId: "" };
  }

  async setRunStatus(_input: SetRunStatusInput): Promise<void> {}

  async setRunPrUrl(_input: SetRunPrUrlInput): Promise<void> {}

  async setRunAuthRef(input: SetRunAuthRefInput): Promise<void> {
    if (this.options.forwardSetRunAuthRef !== undefined) {
      await this.options.forwardSetRunAuthRef(input);
    }
  }

  readonly finalizeLands: FinalizeLandInput[] = [];
  async finalizeLand(input: FinalizeLandInput): Promise<{ auditId: string }> {
    this.finalizeLands.push(input);
    return { auditId: input.runId };
  }

  async setSpecStatus(_input: SetSpecStatusInput): Promise<void> {}

  async setSpecMetadata(_input: SetSpecMetadataInput): Promise<void> {}

  async appendSpecSteering(_input: AppendSpecSteeringInput): Promise<void> {}

  async setRunSpeculativeBase(_input: SetRunSpeculativeBaseInput): Promise<void> {}

  async setRunPercolationReexecId(_input: SetRunPercolationReexecIdInput): Promise<void> {}

  async clearRunPercolationPending(_input: ClearRunPercolationPendingInput): Promise<void> {}

  async mergeRunVerifiedAncestorSha(_input: MergeRunVerifiedAncestorShaInput): Promise<void> {}

  async supersedeQueuedPlannerTask(_input: { runId: string; orgId?: string }): Promise<void> {}

  readonly runFinalizeWithEvents: FinalizeRunWithEventInput[] = [];
  async finalizeRunWithEvent(input: FinalizeRunWithEventInput): Promise<FinalizeRunWithEventOutcome> {
    // Round-3 H-R3.3 (run-level mirror): parse-validate against the production
    // `runPairSchema` so a misuse fails LOUD in tests instead of slipping past.
    runPairSchema.parse(input);
    this.runFinalizeWithEvents.push(input);
    if (this.options.forwardAppend !== undefined) {
      await this.options.forwardAppend(input.event);
    }
    return { updated: true, alreadyTerminal: false, specId: "", projectId: "" };
  }

  async updateSpecWithEvent(input: UpdateSpecWithEventInput): Promise<UpdateSpecWithEventOutcome> {
    // Round-3 H-R3.3 (spec-level mirror): parse-validate against `specPairSchema`.
    specPairSchema.parse(input);
    if (this.options.forwardAppend !== undefined) {
      await this.options.forwardAppend(input.event);
    }
    return { flipped: true, alreadyTerminal: false };
  }

  async resumePausedRunAtomic(input: ResumePausedRunAtomicInput): Promise<ResumePausedRunAtomicOutcome> {
    // Round-3 H-R3.3 (resume-pause atomic mirror): parse-validate against
    // `resumePausedRunPairSchema` (the seam's four-write pairing constraint).
    resumePausedRunPairSchema.parse(input);
    if (this.options.forwardAppend !== undefined) {
      await this.options.forwardAppend(input.resumedEvent);
      await this.options.forwardAppend(input.redrivenEvent);
    }
    return { runFinalized: true, runEventAlreadyTerminal: false, specFlipped: true };
  }

  async createQueuedRun(_input: CreateQueuedRunInput): Promise<SpecRunContract> {
    throw new Error("InMemoryRunStateWriter.createQueuedRun is not wired");
  }

  async createSpec(_input: CreateSpecRemoteInput): Promise<SpecContract> {
    throw new Error("InMemoryRunStateWriter.createSpec is not wired");
  }

  // --- helpers ---

  private applyTransitionToRow(task: UpdateTaskInput): void {
    const existing: TaskRow = this.tasks.get(task.taskId) ?? {
      taskId: task.taskId,
      status: "running",
      outcome: null,
      failureKind: null,
    };
    const next: TaskRow = { ...existing };
    if (task.transition === "running" || task.transition === "started") {
      next.status = "running";
      next.outcome = null;
      next.failureKind = null;
    } else if (task.transition === "running_pending" || task.transition === "running_pending_clear_failure") {
      next.status = "running";
      next.outcome = "pending";
    } else if (task.transition === "done") {
      next.status = "done";
      next.outcome = task.outcome ?? "ok";
    } else if (
      task.transition === "failed" ||
      task.transition === "failed_with_kind" ||
      task.transition === "failed_with_kind_if_running"
    ) {
      // The guarded `failed_with_kind_if_running` variant only flips a row
      // that is still `running` — mirror that here so a test asserting "row
      // stays terminal after a guarded fail" matches the SQL applier.
      if (task.transition === "failed_with_kind_if_running" && next.status !== "running") {
        return;
      }
      next.status = "failed";
      next.outcome = "failed";
      next.failureKind = task.failureKind ?? next.failureKind;
    } else if (task.transition === "cancelled") {
      next.status = "cancelled";
      next.outcome = "cancelled";
    }
    this.tasks.set(task.taskId, next);
  }
}
