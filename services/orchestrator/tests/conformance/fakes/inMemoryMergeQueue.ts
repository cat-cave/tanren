// In-memory MergeQueueModel + MergeRunner fakes for the MergeCoordinator
// conformance + unit tests (TEST FIXTURE — tests/ only, never production). The
// queue model holds entries in a Map and supports the full enqueue / loadSnapshot /
// atomic claim / settle / crash-recovery surface; the runner returns scripted
// outcomes + records each drive. Together they let the production batch coordinator
// run against a controllable queue with no DB or VCS.

import { randomUUID } from "node:crypto";
import type {
  DequeueReason,
  MergeDriveOutcome,
  MergeQueueEntry,
  MergeQueueModel,
  MergeQueueSnapshot,
  MergeRunner,
  SupersededEntry,
} from "../../../src/engine/contracts/mergeCoordinator.js";
import type { MergeQueueEventEmitter, MergeSettleTransaction } from "../../../src/engine/merge/coordinator.js";
import type { SpecEscalator } from "../../../src/engine/merge/coordinatorEscalate.js";
import { MERGE_CLAIM_LEASE_MS } from "../../../src/engine/merge/mergeClaimLease.js";
import type { SpecPriority } from "../../../src/engine/state/spec.js";

interface QueueRow {
  queueId: string;
  runId: string;
  specId: string;
  prUrl: string;
  prNumber: number;
  dependsOn: string[];
  priority: SpecPriority;
  orderKey: number;
  status: "queued" | "merging" | "merged" | "dequeued";
  /** The reason recorded when status → dequeued (mirrors the pg `dequeue_reason`). */
  dequeueReason?: DequeueReason;
  /** When the entry was claimed (status → merging) — the lease anchor (ms epoch). */
  claimedAt?: number;
}

/**
 * The merge-claim lease the fake models: a
 * `merging` claim newer than this survives `recoverStaleClaims`; an older one is
 * reclaimed. Shared with pg so fake recovery semantics cannot drift.
 */
const FAKE_CLAIM_LEASE_MS = MERGE_CLAIM_LEASE_MS;

/** An in-memory native-queue model — the same observable contract as the pg impl. */
export class InMemoryMergeQueueModel implements MergeQueueModel {
  private readonly rows = new Map<string, QueueRow>();
  private readonly mergedSpecs = new Set<string>();
  private order = 0;
  /** Injectable clock so a test can advance time past the lease deterministically. */
  now: () => number = () => Date.now();

  /** Test helper: seed a queued entry directly (an already-enqueued ready run). */
  seed(input: { runId: string; specId: string; dependsOn: string[]; priority: SpecPriority }): void {
    const queueId = `mq_${randomUUID()}`;
    this.order += 1;
    this.rows.set(queueId, {
      queueId,
      runId: input.runId,
      specId: input.specId,
      prUrl: `https://github.test/pr/${input.runId}`,
      prNumber: this.order,
      dependsOn: input.dependsOn,
      priority: input.priority,
      orderKey: this.order,
      status: "queued",
    });
  }

  /** Test helper: seed a legacy stranded native-queue dequeue that production recovery should revive. */
  seedLegacyDequeued(input: {
    runId: string;
    specId: string;
    reason: Extract<DequeueReason, "blocked" | "conflict">;
    dependsOn?: string[];
    priority?: SpecPriority;
  }): void {
    const queueId = `mq_${randomUUID()}`;
    this.order += 1;
    this.rows.set(queueId, {
      queueId,
      runId: input.runId,
      specId: input.specId,
      prUrl: `https://github.test/pr/${input.runId}`,
      prNumber: this.order,
      dependsOn: input.dependsOn ?? [],
      priority: input.priority ?? "tbd",
      orderKey: this.order,
      status: "dequeued",
      dequeueReason: input.reason,
    });
  }

  /** Test helper: mark a spec genuinely merged (a satisfied ancestor). */
  markSpecMerged(specId: string): void {
    this.mergedSpecs.add(specId);
  }

  /** Test helper: undo a false merged ancestor after merge-truth reconciliation. */
  unmarkSpecMerged(specId: string): void {
    this.mergedSpecs.delete(specId);
  }

  /** Test helper: the status of a run's entry (the observable settle effect). */
  statusOf(runId: string): QueueRow["status"] | undefined {
    for (const row of this.rows.values()) {
      if (row.runId === runId) return row.status;
    }
    return undefined;
  }

  /** Test helper: the recorded dequeue reason for a run's entry. */
  dequeueReasonOf(runId: string): DequeueReason | undefined {
    for (const row of this.rows.values()) {
      if (row.runId === runId) return row.dequeueReason;
    }
    return undefined;
  }

  /** Test helper: exact queue identity/status for the in-memory atomic settler. */
  entryForQueueId(projectId: string, queueId: string): (MergeQueueEntry & { status: QueueRow["status"] }) | undefined {
    const row = this.rows.get(queueId);
    if (row === undefined) return undefined;
    return {
      orgId: "org_test",
      projectId,
      queueId: row.queueId,
      runId: row.runId,
      specId: row.specId,
      prUrl: row.prUrl,
      prNumber: row.prNumber,
      dependsOn: row.dependsOn,
      priority: row.priority,
      orderKey: row.orderKey,
      status: row.status,
    };
  }

  async enqueue(input: {
    projectId: string;
    runId: string;
    specId: string;
    prUrl: string;
    prNumber: number;
  }): Promise<{ queueId: string; created: boolean }> {
    for (const row of this.rows.values()) {
      if (row.runId === input.runId && (row.status === "queued" || row.status === "merging")) {
        return { queueId: row.queueId, created: false };
      }
    }
    const queueId = `mq_${randomUUID()}`;
    this.order += 1;
    this.rows.set(queueId, {
      queueId,
      runId: input.runId,
      specId: input.specId,
      prUrl: input.prUrl,
      prNumber: input.prNumber,
      dependsOn: [],
      priority: "tbd",
      orderKey: this.order,
      status: "queued",
    });
    return { queueId, created: true };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async loadSnapshot(projectId: string): Promise<MergeQueueSnapshot> {
    const entries: MergeQueueEntry[] = [];
    let mergingInFlight = false;
    let serializedRetryAfterMs: number | undefined;
    const now = this.now();
    for (const row of this.rows.values()) {
      if (row.status === "merging") {
        mergingInFlight = true;
        const remaining =
          row.claimedAt === undefined ? FAKE_CLAIM_LEASE_MS : Math.max(0, FAKE_CLAIM_LEASE_MS - (now - row.claimedAt));
        serializedRetryAfterMs =
          serializedRetryAfterMs === undefined ? remaining : Math.min(serializedRetryAfterMs, remaining);
      }
      if (row.status !== "queued") continue;
      entries.push({
        orgId: "org_test",
        projectId,
        queueId: row.queueId,
        runId: row.runId,
        specId: row.specId,
        prUrl: row.prUrl,
        prNumber: row.prNumber,
        dependsOn: row.dependsOn,
        priority: row.priority,
        orderKey: row.orderKey,
      });
    }
    return {
      projectId,
      entries,
      mergedSpecIds: new Set(this.mergedSpecs),
      mergingInFlight,
      ...(mergingInFlight && serializedRetryAfterMs !== undefined && { serializedRetryAfterMs }),
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async claim(queueId: string): Promise<boolean> {
    const row = this.rows.get(queueId);
    if (row === undefined || row.status !== "queued") return false;
    row.status = "merging";
    row.claimedAt = this.now();
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async markMerged(queueId: string): Promise<void> {
    const row = this.rows.get(queueId);
    if (row !== undefined) {
      row.status = "merged";
      // A merged entry's spec becomes a satisfied ancestor (the merge-stage effect).
      this.mergedSpecs.add(row.specId);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async markDequeued(queueId: string, reason: DequeueReason): Promise<void> {
    const row = this.rows.get(queueId);
    if (row !== undefined) {
      row.status = "dequeued";
      row.dequeueReason = reason;
    }
  }

  // ATOMICITY (audit RC-4 #3): the in-memory queue has no real client; the
  // both-or-neither semantics are modeled by FakeMergeSettleTransaction (which only
  // commits the staged mutations if `work` resolves), so the client is ignored here.
  async markDequeuedOnClient(_client: unknown, queueId: string, reason: DequeueReason): Promise<void> {
    await this.markDequeued(queueId, reason);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async supersedePriorRunEntry(runId: string): Promise<SupersededEntry | undefined> {
    // Retire the run's ACTIVE (queued/merging) entry — at most one, mirroring the
    // partial unique index. Idempotent: no active entry ⇒ undefined.
    for (const row of this.rows.values()) {
      if (row.runId === runId && (row.status === "queued" || row.status === "merging")) {
        row.status = "dequeued";
        row.dequeueReason = "superseded";
        return { queueId: row.queueId, runId, specId: row.specId, prUrl: row.prUrl, prNumber: row.prNumber };
      }
    }
    return undefined;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async releaseClaim(queueId: string): Promise<void> {
    const row = this.rows.get(queueId);
    // Only return a still-`merging` claim to `queued` (the transient-hold path); never
    // resurrect a settled entry.
    if (row !== undefined && row.status === "merging") {
      row.status = "queued";
      row.claimedAt = undefined;
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async recoverStaleClaims(_projectId: string): Promise<number> {
    let recovered = 0;
    const cutoff = this.now() - FAKE_CLAIM_LEASE_MS;
    for (const row of this.rows.values()) {
      // Only reclaim STALE claims: a fresh `merging` claim (claimed within the
      // lease) survives so a concurrent coordinate pass never double-drives it.
      if (row.status === "merging" && (row.claimedAt === undefined || row.claimedAt < cutoff)) {
        row.status = "queued";
        row.claimedAt = undefined;
        recovered += 1;
      }
    }
    return recovered;
  }

  private hasActiveSameRun(target: QueueRow): boolean {
    for (const row of this.rows.values()) {
      if (row === target) continue;
      if (row.runId === target.runId && (row.status === "queued" || row.status === "merging")) return true;
    }
    return false;
  }
}

/** A scripted, recording merge runner — returns the scripted outcome per run id. */
export class ScriptedMergeRunner implements MergeRunner {
  readonly drives: { runId: string }[] = [];
  private readonly scripted = new Map<string, MergeDriveOutcome>();

  script(runId: string, outcome: MergeDriveOutcome): void {
    this.scripted.set(runId, outcome);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async driveMerge(input: { runId: string; projectId: string }): Promise<MergeDriveOutcome> {
    this.drives.push({ runId: input.runId });
    return this.scripted.get(input.runId) ?? { kind: "merged", mergeSha: `sha_${input.runId}` };
  }
}

/** A recording queue-event emitter — captures every emitted queue event. */
export class RecordingMergeQueueEventEmitter implements MergeQueueEventEmitter {
  readonly events: {
    type: "merge.queue.advanced" | "merge.dequeued" | "merge.queue.infra_blocked";
    specId: string;
    reason?: DequeueReason;
    queueDepth?: number;
    kind?: "ceiling" | "ambiguous" | "missing_required_credential";
    attempts?: number;
  }[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async emitAdvanced(input: { entry: MergeQueueEntry; queueDepth: number }): Promise<void> {
    this.events.push({ type: "merge.queue.advanced", specId: input.entry.specId, queueDepth: input.queueDepth });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async emitDequeued(input: { entry: MergeQueueEntry; reason: DequeueReason }): Promise<void> {
    this.events.push({ type: "merge.dequeued", specId: input.entry.specId, reason: input.reason });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async emitInfraBlocked(input: {
    entry: MergeQueueEntry;
    kind: "ceiling" | "ambiguous" | "missing_required_credential";
    attempts: number;
  }): Promise<void> {
    this.events.push({
      type: "merge.queue.infra_blocked",
      specId: input.entry.specId,
      kind: input.kind,
      attempts: input.attempts,
    });
  }
}

/**
 * A recording SpecEscalator fake (TEST FIXTURE) — captures each non-bricking §2c
 * escalation (the spec parked at `needs_attention`) so the conformance suite can assert
 * the spec was escalated + the loud event would fire, without a DB. Stands in for
 * `PgSpecEscalator`'s guarded spec-status flip + `dag.spec.needs_attention` emission.
 */
export class RecordingSpecEscalator implements SpecEscalator {
  readonly escalations: { specId: string; message: string }[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async escalate(input: { projectId: string; entry: MergeQueueEntry; message: string }) {
    this.escalations.push({ specId: input.entry.specId, message: input.message });
    return { kind: "parked" as const, newlyParked: true, alreadyDequeued: false };
  }
}

/**
 * ATOMICITY SEAM (audit RC-4 #3) — in-memory both-or-neither settle transaction (TEST
 * FIXTURE). Models the pg `runWithOrgScope` BEGIN/COMMIT/ROLLBACK: the event append +
 * the queue dequeue are STAGED into buffers and applied to the real emitter/queue ONLY
 * if `work` resolves. If `work` (or the queue UPDATE) throws, NOTHING is applied — so a
 * failing dequeue UPDATE leaves the event un-emitted (both-or-neither), exactly as a
 * real transaction rollback would. The wrapped `queue` may be configured to throw on
 * the staged `markDequeued` to exercise the rollback.
 */
export class FakeMergeSettleTransaction implements MergeSettleTransaction {
  constructor(
    private readonly realEvents: RecordingMergeQueueEventEmitter,
    private readonly realQueue: InMemoryMergeQueueModel,
    /** When set, the staged queue UPDATE throws this — simulating the row write failing mid-transaction. */
    private readonly queueUpdateError?: Error,
  ) {}

  async run(
    projectId: string,
    work: (ctx: { events: MergeQueueEventEmitter; queue: MergeQueueModel }) => Promise<void>,
  ): Promise<void> {
    // Staged effects — flushed to the real emitter/queue only on a clean commit.
    const stagedEvents: Array<() => Promise<void>> = [];
    const stagedQueue: Array<() => Promise<void>> = [];
    const queueUpdateError = this.queueUpdateError;
    const realEvents = this.realEvents;
    const realQueue = this.realQueue;

    const events: MergeQueueEventEmitter = {
      async emitAdvanced(input) {
        stagedEvents.push(() => realEvents.emitAdvanced(input));
      },
      async emitDequeued(input) {
        stagedEvents.push(() => realEvents.emitDequeued(input));
      },
      async emitInfraBlocked(input) {
        stagedEvents.push(() => realEvents.emitInfraBlocked(input));
      },
    };
    const queue: MergeQueueModel = {
      ...realQueue,
      enqueue: (input) => realQueue.enqueue(input),
      loadSnapshot: (pid) => realQueue.loadSnapshot(pid),
      claim: (queueId) => realQueue.claim(queueId),
      markMerged: (queueId) => realQueue.markMerged(queueId),
      releaseClaim: (queueId) => realQueue.releaseClaim(queueId),
      // The staged dequeue UPDATE: if configured to fail, throw HERE (inside `work`) so
      // the whole unit rolls back — neither the event nor the row mutation is applied.
      // eslint-disable-next-line @typescript-eslint/require-await
      async markDequeued(queueId, reason) {
        if (queueUpdateError !== undefined) throw queueUpdateError;
        stagedQueue.push(() => realQueue.markDequeued(queueId, reason));
      },
      markDequeuedOnClient: (_client, queueId, reason) => queue.markDequeued(queueId, reason),
      supersedePriorRunEntry: (runId) => realQueue.supersedePriorRunEntry(runId),
      recoverStaleClaims: (pid) => realQueue.recoverStaleClaims(pid),
    };

    // Run the unit. A throw (e.g. the failing queue UPDATE) propagates WITHOUT flushing
    // any staged effect — the rollback. Both-or-neither.
    await work({ events, queue });
    // Clean commit: flush events first (event-first ordering), then the queue mutation.
    for (const apply of stagedEvents) await apply();
    for (const apply of stagedQueue) await apply();
  }
}
