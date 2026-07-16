// DagWalker subscriber LIVENESS tests (audit §3.13a/d/e): the periodic re-walk
// backstop, the budget-paused chain stop, and the drain-on-throw coalesce guard —
// the run-killer liveness cluster. Split from dagWalkerSubscriber.test.ts to keep
// that file under the 500-line architecture cap.
import { RUN_ACTIVITY_CHANNEL } from "@tanren/db";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { DagWalker, WalkResult } from "../src/engine/contracts/dagWalker.js";
import type { ChangePercolationCoordinator, PercolationPassResult } from "../src/engine/dag/percolation.js";
import { DagWalkerSubscriber } from "../src/engine/dag/subscriber.js";

class FakeNotifyListener {
  private handlers = new Map<string, Set<(payload: string) => void>>();
  private connErrObs = new Set<() => void>();
  // eslint-disable-next-line @typescript-eslint/require-await
  async subscribe(channel: string, handler: (payload: string) => void): Promise<() => void> {
    let set = this.handlers.get(channel);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
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

function fakePool(args: {
  projectsWithDag: string[];
  runs: Record<string, { projectId: string; status: string }>;
}): pg.Pool {
  const client = {
    // eslint-disable-next-line @typescript-eslint/require-await
    query: async (sql: string, params: unknown[] = []) => {
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(sql.trim())) return { rows: [], rowCount: 0 };
      if (/DISTINCT project_id FROM specs/u.test(sql)) {
        return {
          rows: args.projectsWithDag.map((project_id) => ({ project_id })),
          rowCount: args.projectsWithDag.length,
        };
      }
      if (/FROM runs WHERE run_id/u.test(sql)) {
        const run = args.runs[params[0] as string];
        return run === undefined
          ? { rows: [], rowCount: 0 }
          : { rows: [{ project_id: run.projectId, status: run.status }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return { query: client.query, connect: async () => client } as unknown as pg.Pool;
}

class RecordingWalker implements DagWalker {
  readonly walks: string[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async walk(projectId: string): Promise<WalkResult> {
    this.walks.push(projectId);
    return { projectId, status: "drained", enqueuedSpecIds: [], enqueuedRunIds: [] };
  }
}

class RecordingPercolation implements ChangePercolationCoordinator {
  readonly passes: string[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async percolate(projectId: string): Promise<PercolationPassResult> {
    this.passes.push(projectId);
    return {
      projectId,
      absorbed: [],
      deferred: [],
      replanned: [],
      parked: [],
      reexecuting: [],
      inFlight: [],
      held: [],
      unchanged: [],
      skipped: [],
    };
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

describe("DagWalkerSubscriber liveness", () => {
  it("a PERIODIC backstop tick re-walks every project after a lost NOTIFY (audit §3.13a)", async () => {
    // A NOTIFY lost in the listener's reconnect gap would de-animate the DAG until a
    // worker reboot. The periodic backstop re-walks every walkable project on a cadence so
    // a lost wake self-heals. An injected setInterval seam captures the tick handler.
    let tickHandler: (() => void) | undefined;
    let cleared = false;
    const walker = new RecordingWalker();
    const sub = new DagWalkerSubscriber({
      pool: fakePool({ projectsWithDag: ["project_a", "project_b"], runs: {} }),
      notifyListener: new FakeNotifyListener() as never,
      walker,
      reWalkIntervalMs: 1000,
      setIntervalFn: (handler) => {
        tickHandler = handler;
        return Symbol("timer");
      },
      clearIntervalFn: () => {
        cleared = true;
      },
    });
    await sub.start();
    await flush();
    expect(walker.walks.length).toBe(2);

    // Simulate a lost NOTIFY: nothing fires on the bus. The periodic tick re-animates.
    expect(tickHandler).toBeDefined();
    tickHandler?.();
    await flush();

    // Both projects re-walked by the backstop (startup 2 + tick 2 = 4).
    expect(walker.walks.length).toBe(4);
    await sub.stop();
    expect(cleared).toBe(true);
  });

  it("SKIPS change-percolation when a walk pauses on budget (audit §3.13e — no spend past the ceiling)", async () => {
    // A budget-paused walk enqueued nothing; percolation allocates runners + spends, so it
    // must NOT run — else the chain keeps burning money past the ceiling the walk honored.
    const pausedWalker: DagWalker = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async walk(projectId: string): Promise<WalkResult> {
        return { projectId, status: "budget_paused", enqueuedSpecIds: [], enqueuedRunIds: [] };
      },
    };
    const percolation = new RecordingPercolation();
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const listener = new FakeNotifyListener();
    const sub = new DagWalkerSubscriber({
      pool: fakePool({ projectsWithDag: [], runs: { run_done: { projectId: "project_x", status: "completed" } } }),
      notifyListener: listener as never,
      walker: pausedWalker,
      percolation,
    });
    await sub.start();
    await flush();

    listener.fire(RUN_ACTIVITY_CHANNEL, "run_done");
    await flush();

    expect(percolation.passes).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    await sub.stop();
  });

  it("a walk THROW does not strand a queued re-walk (audit §3.13d — coalesce flag always drains)", async () => {
    // A trigger arrives mid-walk (sets reWalkPending); the first walk then THROWS. The
    // drain guard must still loop once more to honor the queued re-walk, never abandon it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let call = 0;
    const flakyWalker: DagWalker = {
      async walk(projectId: string): Promise<WalkResult> {
        call += 1;
        if (call === 1) {
          await gate;
          throw new Error("walk 1 blew up");
        }
        return { projectId, status: "drained", enqueuedSpecIds: [], enqueuedRunIds: [] };
      },
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const listener = new FakeNotifyListener();
    const sub = new DagWalkerSubscriber({
      pool: fakePool({ projectsWithDag: [], runs: { run_done: { projectId: "project_x", status: "completed" } } }),
      notifyListener: listener as never,
      walker: flakyWalker,
    });
    await sub.start();
    await flush();

    listener.fire(RUN_ACTIVITY_CHANNEL, "run_done");
    // walk 1 starts + parks on the gate
    await flush();
    // queued re-walk arrives while walk 1 is in flight
    listener.fire(RUN_ACTIVITY_CHANNEL, "run_done");
    await flush();
    // release → walk 1 throws
    release();
    await flush();
    await flush();

    // The queued re-walk drained despite walk 1 throwing: exactly 2 calls.
    expect(call).toBe(2);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    await sub.stop();
  });
});
