// apex v87 regression: the merge-coordinator coordinate-pass dequeue settle MUST
// NOT open `PgEventStore` on the worker's de-privileged dataplane pool.
//
// Live failure (project_4c88331e… / cat-cave/linky87): after #852 landed
// `github.pr.created` + `merge.scheduled` via RunStateWriter, the next
// coordinate pass still failed every ~15s with
//   merge-coordinator "coordinate pass failed"
//   detail: "permission denied for table events"
// because `buildBatchMergeCoordinator` ALWAYS wired `PgMergeSettleTransaction`,
// which co-transacts `merge.dequeued` through `new PgEventStore(client)` on the
// worker pool. `tanren_dataplane` has REVOKE INSERT on `events` (baseline 0000),
// so every bisect/gate-rework/needs_attention dequeue threw 42501 — even though
// `merge.batch.*` events already rode the control-plane writer.
//
// Fix: only wire the local settle when the writer is `DirectRunStateWriter`
// (`canCoTransactMergeSettle`). With `HttpRunStateWriter`, omit `tx` so
// `markDequeuedAfterEvent` uses sequential event-first through the writer-backed
// `PgMergeQueueEventEmitter`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { allowRuntimePoolAsSystemForTests, resetSystemPool, setSystemPool } from "@tanren/db";
import { canCoTransactMergeSettle } from "../src/engine/merge/batchCoordinatorBuild.js";
import { markDequeuedAfterEvent } from "../src/engine/merge/coordinator.js";
import { PgMergeQueueEventEmitter } from "../src/engine/merge/coordinatorEvents.js";
import { PgMergeQueueModel, PgMergeSettleTransaction } from "../src/engine/merge/coordinatorPg.js";
import type { MergeQueueEntry, MergeQueueModel } from "../src/engine/contracts/mergeCoordinator.js";
import type { AppendEventInput } from "../src/engine/eventStore.js";
import type { RunStateWriter } from "../src/engine/contracts/runStateWriter.js";
import { DirectRunStateWriter } from "../src/engine/worker/directRunStateWriter.js";

const PROJECT = "project_v87";
const ORG = "org_v87";

const ENTRY: MergeQueueEntry = {
  orgId: ORG,
  projectId: PROJECT,
  queueId: "mq_v87",
  runId: "run_v87",
  specId: "spec_v87",
  prUrl: "https://github.com/cat-cave/linky87/pull/1",
  prNumber: 1,
  dependsOn: [],
  priority: "tbd",
  orderKey: 1,
};

/**
 * Pool that DENIES every `events` INSERT with the live dataplane SQLSTATE —
 * so a regression that reopens `PgEventStore` on the worker pool fails loud.
 * SELECT/org-scope plumbing still works (the real dataplane can READ events).
 */
class DenyingEventsPool {
  readonly queries: string[] = [];
  async query(sql: string, _params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    this.queries.push(sql);
    const text = sql.trim();
    if (
      text.startsWith("BEGIN") ||
      text.startsWith("SET LOCAL") ||
      text.startsWith("COMMIT") ||
      text.startsWith("ROLLBACK") ||
      text.startsWith("SELECT set_config")
    ) {
      return { rows: [], rowCount: 0 };
    }
    // Mirror `tanren_dataplane` REVOKE: any events write is 42501.
    if (/INSERT\s+INTO\s+events\b/iu.test(text) || (text.startsWith("INSERT INTO") && text.includes("event_type"))) {
      throw Object.assign(new Error("permission denied for table events"), { code: "42501" });
    }
    // Org resolve for the settle / emitter.
    if (/FROM\s+projects\b/iu.test(text) && /org_id/iu.test(text)) {
      return { rows: [{ org_id: ORG }], rowCount: 1 };
    }
    // Queue org resolve (settle path).
    if (/FROM\s+merge_queue\b/iu.test(text) && /org_id/iu.test(text)) {
      return { rows: [{ org_id: ORG }], rowCount: 1 };
    }
    // Queue UPDATE (still granted on dataplane) — accept and report 1 row.
    if (/UPDATE\s+merge_queue\b/iu.test(text)) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  async connect(): Promise<{
    query: DenyingEventsPool["query"];
    release: () => void;
  }> {
    return { query: this.query.bind(this), release: () => {} };
  }
  asPgPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

/** Control-plane stand-in: records appends, never touches the pool. */
class RecordingControlPlaneWriter {
  readonly appends: Array<{ eventType: string; orgId?: string }> = [];
  async append(input: AppendEventInput): Promise<void> {
    this.appends.push({ eventType: input.eventType, orgId: input.orgId });
  }
  asRunStateWriter(): RunStateWriter {
    return this as unknown as RunStateWriter;
  }
}

/** In-memory queue that only tracks markDequeued (no pool). */
class RecordingQueueModel {
  dequeued: Array<{ queueId: string; reason: string }> = [];
  async markDequeued(queueId: string, reason: string): Promise<void> {
    this.dequeued.push({ queueId, reason });
  }
  // Unused MergeQueueModel methods — settle only calls markDequeued.
  async enqueue(): Promise<{ queueId: string; created: boolean }> {
    throw new Error("unused");
  }
  async loadSnapshot() {
    throw new Error("unused");
  }
  async claim(): Promise<boolean> {
    throw new Error("unused");
  }
  async markMerged(): Promise<void> {
    throw new Error("unused");
  }
  async releaseClaim(): Promise<void> {
    throw new Error("unused");
  }
  async markDequeuedOnClient(): Promise<void> {
    throw new Error("unused");
  }
  async supersedePriorRunEntry(): Promise<undefined> {
    return undefined;
  }
  async recoverStaleClaims(): Promise<number> {
    return 0;
  }
  asModel(): MergeQueueModel {
    return this as unknown as MergeQueueModel;
  }
}

describe("apex v87 — coordinate-pass dequeue settle is plane-split safe", () => {
  beforeEach(() => {
    // System-scope org resolve needs the test opt-in (same as other merge-pg unit tests).
    allowRuntimePoolAsSystemForTests();
  });

  afterEach(() => {
    resetSystemPool();
  });

  it("canCoTransactMergeSettle is true only when localMergeSettleCoTx is set (Direct)", () => {
    const pool = new DenyingEventsPool().asPgPool();
    const direct = new DirectRunStateWriter(pool);
    expect(direct.localMergeSettleCoTx).toBe(true);
    expect(canCoTransactMergeSettle(direct)).toBe(true);
    expect(canCoTransactMergeSettle(new RecordingControlPlaneWriter().asRunStateWriter())).toBe(false);
  });

  it("PgMergeSettleTransaction throws 42501 on a dataplane-like pool (the live hole)", async () => {
    const pool = new DenyingEventsPool();
    setSystemPool(pool.asPgPool());
    const model = new PgMergeQueueModel(pool.asPgPool());
    const tx = new PgMergeSettleTransaction(pool.asPgPool(), model);

    await expect(
      tx.run(PROJECT, async (ctx) => {
        await ctx.events.emitDequeued({
          projectId: PROJECT,
          entry: ENTRY,
          reason: "superseded",
          message: "routed to writer rework",
        });
        await ctx.queue.markDequeued(ENTRY.queueId, "superseded");
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("permission denied for table events"),
      code: "42501",
    });
  });

  it("sequential event-first settle via writer succeeds when the pool denies events INSERT", async () => {
    const pool = new DenyingEventsPool();
    setSystemPool(pool.asPgPool());
    const writer = new RecordingControlPlaneWriter();
    const queue = new RecordingQueueModel();
    // Production remote path: PgMergeQueueEventEmitter routes through the writer
    // (HttpRunStateWriter in prod); no local PgEventStore, no tx.
    const events = new PgMergeQueueEventEmitter(pool.asPgPool(), writer.asRunStateWriter());

    await markDequeuedAfterEvent({
      queue: queue.asModel(),
      events,
      projectId: PROJECT,
      entry: ENTRY,
      reason: "superseded",
      message: "routed to writer rework after a failed integrated-tree gate",
      // no tx — the plane-split path
    });

    expect(writer.appends).toEqual([
      {
        eventType: "merge.dequeued",
        orgId: ORG,
      },
    ]);
    expect(queue.dequeued).toEqual([{ queueId: ENTRY.queueId, reason: "superseded" }]);
    // Pool never saw an events INSERT (the deny path was not hit).
    expect(pool.queries.some((q) => /INSERT\s+INTO\s+events\b/iu.test(q))).toBe(false);
  });

  it("with a remote (non-Direct) writer, settle must not use the local-pool co-tx", async () => {
    // Mirror buildBatchMergeCoordinator's decision: remote writer ⇒ no tx.
    const writer = new RecordingControlPlaneWriter().asRunStateWriter();
    expect(canCoTransactMergeSettle(writer)).toBe(false);

    const pool = new DenyingEventsPool();
    setSystemPool(pool.asPgPool());
    const events = new PgMergeQueueEventEmitter(pool.asPgPool(), writer);
    const queue = new RecordingQueueModel();

    // If a regression re-wired `tx: new PgMergeSettleTransaction(...)` for the
    // remote path, this call would still succeed here only because we omit tx —
    // the assembly guard is `canCoTransactMergeSettle`. Assert the decision + the
    // sequential path together so both stay green.
    await markDequeuedAfterEvent({
      queue: queue.asModel(),
      events,
      projectId: PROJECT,
      entry: ENTRY,
      reason: "conflict",
      message: "bisected as the offending PR",
      ...(canCoTransactMergeSettle(writer)
        ? { tx: new PgMergeSettleTransaction(pool.asPgPool(), new PgMergeQueueModel(pool.asPgPool())) }
        : {}),
    });

    expect(writer.appends.map((a) => a.eventType)).toEqual(["merge.dequeued"]);
    expect(queue.dequeued).toHaveLength(1);
  });
});
