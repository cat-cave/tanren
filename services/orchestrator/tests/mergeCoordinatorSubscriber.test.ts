// Unit tests for the MergeCoordinatorSubscriber NOTIFY-storm debounce (Bug B — the
// no-CI hot-loop fix), over a fake pool + fake PgNotifyListener + a recording
// coordinator (no Postgres). The live no-CI repo hit a hot loop: a batch stuck
// `pending` was re-integrated on EVERY unrelated `tanren_run` NOTIFY (~2/sec). The
// fix: a coordinate pass that returns a PENDING hold (holdReason `all_blocked` WITH
// `retryAfterMs`) opens a per-project NOTIFY-suppression window — the armed
// `retryAfterMs` timer is the authoritative re-check, NOT the storm. These prove:
//   - a storm of N NOTIFYs in < the debounce window triggers AT MOST ~1 coordinate;
//   - the suppression applies ONLY to the pending-hold state — once the window
//     lapses (clock advances), a NOTIFY re-checks promptly (no real-completion regress);
//   - a NON-pending pass (a clean merge/empty hold) does NOT suppress the next NOTIFY.

import { RUN_ACTIVITY_CHANNEL } from "@tanren/db";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { CoordinateResult, MergeCoordinator } from "../src/engine/contracts/mergeCoordinator.js";
import { MergeCoordinatorSubscriber } from "../src/engine/merge/subscriber.js";

/** Records subscriptions + fires a payload to the registered handler (mirrors the walker test). */
class FakeNotifyListener {
  private handlers = new Map<string, Set<(payload: string) => void>>();
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
function fakePool(projectId: string): pg.Pool {
  const client = {
    // eslint-disable-next-line @typescript-eslint/require-await
    query: async (sql: string, params: unknown[] = []) => {
      const text = sql.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(text)) return { rows: [], rowCount: 0 };
      if (/DISTINCT project_id FROM merge_queue/u.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT project_id FROM runs WHERE run_id/u.test(sql)) {
        if (params[0] === undefined) return { rows: [], rowCount: 0 };
        return { rows: [{ project_id: projectId }], rowCount: 1 };
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

const PROJECT = "project_q";

describe("MergeCoordinatorSubscriber — pending-hold NOTIFY debounce (Bug B)", () => {
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
    sub.stop();
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
    sub.stop();
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
    sub.stop();
  });
});
