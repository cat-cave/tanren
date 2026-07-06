// Unit tests for the MergeCoordinatorSubscriber NOTIFY-storm debounce (Bug B — the
// no-CI hot-loop fix), over a fake pool + fake PgNotifyListener + a recording
// coordinator (no Postgres). The live no-CI repo hit a hot loop: a batch stuck
// `pending` was re-integrated on EVERY unrelated `tanren_run` NOTIFY (~2/sec).
// `merge_retry` backoff has the same risk: unrelated run activity can burn retry
// attempts before the backoff timer expires. The fix: a timed hold opens a
// per-project NOTIFY-suppression window — the armed `retryAfterMs` timer is the
// authoritative re-check, NOT the storm. These prove:
//   - a storm of N NOTIFYs in < the debounce window triggers AT MOST ~1 coordinate;
//   - the suppression applies ONLY to the pending-hold state — once the window
//     lapses (clock advances), a NOTIFY re-checks promptly (no real-completion regress);
//   - a NON-pending pass (a clean merge/empty hold) does NOT suppress the next NOTIFY.

import { NOTIFICATION_CHANNEL, RUN_ACTIVITY_CHANNEL } from "@tanren/db";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { CoordinateResult, MergeCoordinator } from "../src/engine/contracts/mergeCoordinator.js";
import { serializedRetryAfterMs } from "../src/engine/merge/mergeSerializedRetry.js";
import { MergeCoordinatorSubscriber } from "../src/engine/merge/subscriber.js";

/** Records subscriptions + fires a payload to the registered handler (mirrors the walker test). */
class FakeNotifyListener {
  private handlers = new Map<string, Set<(payload: string) => void>>();
  private connErrObs = new Set<() => void>();
  unsubscribeCount = 0;
  // eslint-disable-next-line @typescript-eslint/require-await
  async subscribe(channel: string, handler: (payload: string) => void): Promise<() => void> {
    let set = this.handlers.get(channel);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    return () => {
      this.unsubscribeCount += 1;
      set?.delete(handler);
    };
  }
  // The subscribeWithReconnect helper registers here so a live drop drives re-subscribe.
  onConnectionError(cb: () => void): () => void {
    this.connErrObs.add(cb);
    return () => this.connErrObs.delete(cb);
  }
  fire(channel: string, payload: string): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(payload);
  }
}

/**
 * A fake pool answering the two system-scoped reads the subscriber issues:
 *   - SELECT DISTINCT project_id FROM merge_queue (startup discovery) — empty here,
 *   - SELECT project_id FROM runs WHERE run_id = $1 (trigger resolution).
 * Every run resolves to the SAME project so the storm targets one project's queue.
 */
function fakePool(
  projectId: string,
  startupProjects: string[] = [],
  events = new Map<
    string,
    { project_id: string | null; org_id?: string | null; event_type: string; payload?: Record<string, unknown> }
  >(),
): pg.Pool {
  const client = {
    // eslint-disable-next-line @typescript-eslint/require-await
    query: async (sql: string, params: unknown[] = []) => {
      const text = sql.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(text)) return { rows: [], rowCount: 0 };
      if (/DISTINCT[\s\S]*project_id[\s\S]*FROM merge_queue/u.test(sql)) {
        return { rows: startupProjects.map((id) => ({ project_id: id })), rowCount: startupProjects.length };
      }
      if (/SELECT project_id FROM runs WHERE run_id/u.test(sql)) {
        if (params[0] === undefined) return { rows: [], rowCount: 0 };
        return { rows: [{ project_id: projectId }], rowCount: 1 };
      }
      if (/SELECT project_id, org_id, event_type, payload FROM events WHERE id/u.test(sql)) {
        const row = events.get(String(params[0]));
        return row === undefined
          ? { rows: [], rowCount: 0 }
          : { rows: [{ org_id: null, payload: {}, ...row }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = { query: client.query, connect: async () => client };
  return pool as unknown as pg.Pool;
}

/** A recording coordinator returning a scripted result; counts passes per project. */
class RecordingCoordinator implements MergeCoordinator {
  readonly passes: string[] = [];
  constructor(private readonly result: (projectId: string) => CoordinateResult) {}
  async coordinate(projectId: string): Promise<CoordinateResult> {
    this.passes.push(projectId);
    return this.result(projectId);
  }
}

const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });
const flush = async (): Promise<void> => {
  await tick();
  await tick();
};
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
};
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

const PROJECT = "project_q";

describe("MergeCoordinatorSubscriber — pending-hold NOTIFY debounce (Bug B)", () => {
  it("startup discovery coordinates projects with queued or recoverable dequeued work", async () => {
    const pool = fakePool(PROJECT, [PROJECT]);
    const listener = new FakeNotifyListener();
    const coordinator = new RecordingCoordinator(() => ({ projectId: PROJECT, holdReason: "empty", queueDepth: 0 }));
    const sub = new MergeCoordinatorSubscriber({
      pool,
      notifyListener: listener as never,
      coordinator,
    });
    await sub.start();
    await flush();

    expect(coordinator.passes).toEqual([PROJECT]);
    await sub.stop();
  });

  it("credential repair events wake the repaired project's merge queue", async () => {
    const pool = fakePool(
      PROJECT,
      [],
      new Map([
        ["41", { project_id: "project_codex", event_type: "credential.configured" }],
        ["42", { project_id: PROJECT, event_type: "credential.github.configured" }],
        [
          "43",
          { project_id: "project_app", event_type: "integration.provisioned", payload: { providerKind: "github" } },
        ],
      ]),
    );
    const listener = new FakeNotifyListener();
    const coordinator = new RecordingCoordinator(() => ({ projectId: PROJECT, holdReason: "empty", queueDepth: 0 }));
    const sub = new MergeCoordinatorSubscriber({
      pool,
      notifyListener: listener as never,
      coordinator,
    });
    await sub.start();
    await flush();

    listener.fire(NOTIFICATION_CHANNEL, "41");
    await flush();
    listener.fire(NOTIFICATION_CHANNEL, "42");
    await flush();
    listener.fire(NOTIFICATION_CHANNEL, "43");
    await flush();

    expect(coordinator.passes).toEqual(["project_codex", PROJECT, "project_app"]);
    await sub.stop();
  });

  it("suppresses a NOTIFY storm during a pending hold (at most one coordinate)", async () => {
    const pool = fakePool(PROJECT);
    const listener = new FakeNotifyListener();
    // Every pass holds PENDING with a backoff (the no-CI / pending-batch case).
    const coordinator = new RecordingCoordinator(() => ({
      projectId: PROJECT,
      holdReason: "all_blocked",
      retryAfterMs: 15_000,
      queueDepth: 1,
    }));
    let now = 1_000_000;
    const sub = new MergeCoordinatorSubscriber({
      pool,
      notifyListener: listener as never,
      coordinator,
      now: () => now,
    });
    await sub.start();
    await flush();

    // The FIRST NOTIFY drives one coordinate pass → a pending hold opens the
    // suppression window (default 5_000ms). Subsequent NOTIFYs within the window
    // are suppressed — the armed timer is the authoritative re-check.
    for (let i = 0; i < 10; i += 1) {
      listener.fire(RUN_ACTIVITY_CHANNEL, `run_${i}`);
      await flush();
      // 10 NOTIFYs over 1s — all inside the 5s suppression window.
      now += 100;
    }

    // At most ONE coordinate ran for the storm (not ten) — the hot loop is killed.
    expect(coordinator.passes).toEqual([PROJECT]);
    await sub.stop();
  });

  it("re-checks promptly once the debounce window lapses (no real-completion regress)", async () => {
    const pool = fakePool(PROJECT);
    const listener = new FakeNotifyListener();
    const coordinator = new RecordingCoordinator(() => ({
      projectId: PROJECT,
      holdReason: "all_blocked",
      retryAfterMs: 15_000,
      queueDepth: 1,
    }));
    let now = 1_000_000;
    const sub = new MergeCoordinatorSubscriber({
      pool,
      notifyListener: listener as never,
      coordinator,
      now: () => now,
    });
    await sub.start();
    await flush();

    // First NOTIFY → coordinate → opens the 5s suppression window.
    listener.fire(RUN_ACTIVITY_CHANNEL, "run_0");
    await flush();
    expect(coordinator.passes).toEqual([PROJECT]);

    // A NOTIFY inside the window is suppressed.
    now += 1_000;
    listener.fire(RUN_ACTIVITY_CHANNEL, "run_1");
    await flush();
    expect(coordinator.passes).toEqual([PROJECT]);

    // Advance PAST the window — a genuine CI-completion NOTIFY now re-checks promptly.
    now += 5_001;
    listener.fire(RUN_ACTIVITY_CHANNEL, "run_2");
    await flush();
    expect(coordinator.passes).toEqual([PROJECT, PROJECT]);
    await sub.stop();
  });

  it("a NON-pending pass does NOT suppress the next NOTIFY (debounce spans only a live hold)", async () => {
    const pool = fakePool(PROJECT);
    const listener = new FakeNotifyListener();
    // A clean pass: a merge advanced (no retryAfterMs) — no suppression window.
    const coordinator = new RecordingCoordinator(() => ({
      projectId: PROJECT,
      mergedSpecId: "spec_a",
      queueDepth: 0,
    }));
    let now = 1_000_000;
    const sub = new MergeCoordinatorSubscriber({
      pool,
      notifyListener: listener as never,
      coordinator,
      now: () => now,
    });
    await sub.start();
    await flush();

    listener.fire(RUN_ACTIVITY_CHANNEL, "run_0");
    await flush();
    now += 100;
    listener.fire(RUN_ACTIVITY_CHANNEL, "run_1");
    await flush();

    // Both NOTIFYs coordinated — a clean pass never throttles the next one.
    expect(coordinator.passes).toEqual([PROJECT, PROJECT]);
    await sub.stop();
  });

  it("suppresses unrelated NOTIFYs during merge_retry backoff; the retry timer re-drives", async () => {
    vi.useFakeTimers();
    let sub: MergeCoordinatorSubscriber | undefined;
    try {
      const pool = fakePool(PROJECT);
      const listener = new FakeNotifyListener();
      let calls = 0;
      const coordinator = new RecordingCoordinator(() => {
        calls += 1;
        return calls === 1
          ? {
              projectId: PROJECT,
              holdReason: "merge_retry",
              retryAfterMs: 5,
              queueDepth: 1,
            }
          : { projectId: PROJECT, mergedSpecId: "spec_retry", queueDepth: 1 };
      });
      let now = 1_000_000;
      sub = new MergeCoordinatorSubscriber({
        pool,
        notifyListener: listener as never,
        coordinator,
        now: () => now,
      });
      await sub.start();
      await flushMicrotasks();

      listener.fire(RUN_ACTIVITY_CHANNEL, "run_0");
      await flushMicrotasks();
      expect(coordinator.passes).toEqual([PROJECT]);

      now += 100;
      for (let i = 1; i <= 5; i += 1) {
        listener.fire(RUN_ACTIVITY_CHANNEL, `run_${i}`);
        await flushMicrotasks();
      }
      expect(coordinator.passes).toEqual([PROJECT]);

      // Advance the fake clock past the armed retry timer (retryAfterMs: 5) — the
      // re-drive timer is the authoritative re-check and fires deterministically.
      await vi.advanceTimersByTimeAsync(10);
      await flushMicrotasks();
      expect(coordinator.passes).toEqual([PROJECT, PROJECT]);
    } finally {
      await sub?.stop();
      vi.useRealTimers();
    }
  });

  it("honors merge_retry backoff when a NOTIFY arrives during the coordinate pass", async () => {
    vi.useFakeTimers();
    let sub: MergeCoordinatorSubscriber | undefined;
    try {
      const pool = fakePool(PROJECT);
      const listener = new FakeNotifyListener();
      const firstResult = deferred<CoordinateResult>();
      const passes: string[] = [];
      const coordinator: MergeCoordinator = {
        async coordinate(projectId: string): Promise<CoordinateResult> {
          passes.push(projectId);
          if (passes.length === 1) return firstResult.promise;
          return { projectId, mergedSpecId: "spec_retry", queueDepth: 1 };
        },
      };
      sub = new MergeCoordinatorSubscriber({
        pool,
        notifyListener: listener as never,
        coordinator,
      });
      await sub.start();
      await flushMicrotasks();

      listener.fire(RUN_ACTIVITY_CHANNEL, "run_0");
      await flushMicrotasks();
      expect(passes).toEqual([PROJECT]);

      listener.fire(RUN_ACTIVITY_CHANNEL, "run_1");
      await flushMicrotasks();
      expect(passes).toEqual([PROJECT]);

      firstResult.resolve({
        projectId: PROJECT,
        holdReason: "merge_retry",
        retryAfterMs: 20,
        queueDepth: 1,
      });
      await flushMicrotasks();
      expect(passes).toEqual([PROJECT]);

      // The armed retry timer (retryAfterMs: 20) is the authoritative re-check —
      // advance the fake clock past it to deterministically re-drive the pass.
      await vi.advanceTimersByTimeAsync(25);
      await flushMicrotasks();
      expect(passes).toEqual([PROJECT, PROJECT]);
    } finally {
      await sub?.stop();
      vi.useRealTimers();
    }
  });

  it("does not DROP a trigger that arrives mid-pass — it coalesces into exactly one re-pass", async () => {
    // Capture-and-clear race (Bug B follow-up): a NOTIFY arriving DURING the
    // coordinate await must be honored as a re-pass, never silently dropped. The
    // first pass is held open on a deferred; a NOTIFY fires while it is in flight;
    // when the first pass resolves CLEAN (no hold), the loop must re-run exactly
    // once for the captured trigger — and no more (no double-fire).
    const pool = fakePool(PROJECT);
    const listener = new FakeNotifyListener();
    const firstResult = deferred<CoordinateResult>();
    const passes: string[] = [];
    const coordinator: MergeCoordinator = {
      async coordinate(projectId: string): Promise<CoordinateResult> {
        passes.push(projectId);
        if (passes.length === 1) return firstResult.promise;
        return { projectId, mergedSpecId: "spec_clean", queueDepth: 1 };
      },
    };
    const sub = new MergeCoordinatorSubscriber({
      pool,
      notifyListener: listener as never,
      coordinator,
    });
    try {
      await sub.start();
      await flushMicrotasks();

      // First NOTIFY starts pass #1, which parks on the deferred.
      listener.fire(RUN_ACTIVITY_CHANNEL, "run_0");
      await flushMicrotasks();
      expect(passes).toEqual([PROJECT]);

      // A second NOTIFY arrives WHILE pass #1 is still in flight — sets rePending.
      listener.fire(RUN_ACTIVITY_CHANNEL, "run_1");
      await flushMicrotasks();
      expect(passes).toEqual([PROJECT]);

      // Pass #1 resolves CLEAN (no hold). The captured mid-pass trigger must drive
      // EXACTLY one re-pass — not zero (dropped), not two (double-fired).
      firstResult.resolve({ projectId: PROJECT, mergedSpecId: "spec_first", queueDepth: 1 });
      await flushMicrotasks();
      expect(passes).toEqual([PROJECT, PROJECT]);
    } finally {
      await sub.stop();
    }
  });

  it("re-drives a serialized startup hold after its retry timer", async () => {
    vi.useFakeTimers();
    let sub: MergeCoordinatorSubscriber | undefined;
    try {
      const pool = fakePool(PROJECT, [PROJECT]);
      const listener = new FakeNotifyListener();
      let calls = 0;
      const coordinator = new RecordingCoordinator(() => {
        calls += 1;
        return calls === 1
          ? {
              projectId: PROJECT,
              holdReason: "serialized",
              retryAfterMs: 5,
              queueDepth: 0,
            }
          : { projectId: PROJECT, mergedSpecId: "spec_resumed", queueDepth: 1 };
      });
      sub = new MergeCoordinatorSubscriber({
        pool,
        notifyListener: listener as never,
        coordinator,
      });
      await sub.start();
      await flushMicrotasks();

      expect(coordinator.passes).toEqual([PROJECT]);

      // Advance past the armed serialized re-drive timer (retryAfterMs: 5).
      await vi.advanceTimersByTimeAsync(10);
      await flushMicrotasks();
      expect(coordinator.passes).toEqual([PROJECT, PROJECT]);
    } finally {
      await sub?.stop();
      vi.useRealTimers();
    }
  });

  it("self-wakes after a coordinate exception so stale merge claims are recovered", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let sub: MergeCoordinatorSubscriber | undefined;
    try {
      const pool = fakePool(PROJECT, [PROJECT]);
      const listener = new FakeNotifyListener();
      let calls = 0;
      const coordinator = new RecordingCoordinator((projectId) => {
        calls += 1;
        if (calls === 1) {
          throw new Error("claim write failed after merge claim");
        }
        return { projectId, mergedSpecId: "spec_after_exception", queueDepth: 1 };
      });
      sub = new MergeCoordinatorSubscriber({
        pool,
        notifyListener: listener as never,
        coordinator,
      });
      await sub.start();
      await flushMicrotasks();

      expect(coordinator.passes).toEqual([PROJECT]);

      await vi.advanceTimersByTimeAsync(serializedRetryAfterMs({}) - 1);
      await flushMicrotasks();
      expect(coordinator.passes).toEqual([PROJECT]);

      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();
      expect(coordinator.passes).toEqual([PROJECT, PROJECT]);
    } finally {
      await sub?.stop();
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });
});
