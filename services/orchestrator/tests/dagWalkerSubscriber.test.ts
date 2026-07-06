// Unit tests for the DagWalker subscriber (autonomy-engine.md §1a, §1.5): the
// long-lived listener that drives the per-project DagWalker on startup and on
// every run.*-terminal / merge.completed notification. They prove — over a fake
// pool + fake PgNotifyListener + a recording walker (no Postgres) — that:
//   - the EVENT-DRIVEN TRIGGER fires the walker (a terminal run's `tanren_run`
//     NOTIFY walks that run's project),
//   - a NON-terminal run notification does NOT trigger a walk (the walker reacts
//     to terminal/merge events, not every event),
//   - startup walks every project that has a DAG,
//   - per-project walks are coalesced (a storm collapses to in-flight + one
//     re-walk; no concurrent double-walk of one project).

import { DAG_CHANGE_CHANNEL, RUN_ACTIVITY_CHANNEL } from "@tanren/db";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { DagWalker, WalkResult } from "../src/engine/contracts/dagWalker.js";
import type { ChangePercolationCoordinator, PercolationPassResult } from "../src/engine/dag/percolation.js";
import { DagWalkerSubscriber } from "../src/engine/dag/subscriber.js";

// A fake PgNotifyListener mirroring the liveAwait test's: records subscriptions
// and lets a test fire a payload to the registered handler.
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
 *   - SELECT DISTINCT project_id FROM specs (startup project discovery)
 *   - SELECT project_id, status FROM runs WHERE run_id = $1 (trigger resolution)
 * `runs` maps a runId → { projectId, status } via the supplied table.
 */
function fakePool(args: {
  projectsWithDag: string[];
  runs: Record<string, { projectId: string; status: string }>;
}): pg.Pool {
  const client = {
    // eslint-disable-next-line @typescript-eslint/require-await
    query: async (sql: string, params: unknown[] = []) => {
      const text = sql.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(text)) return { rows: [], rowCount: 0 };
      if (/DISTINCT project_id FROM specs/u.test(sql)) {
        return {
          rows: args.projectsWithDag.map((project_id) => ({ project_id })),
          rowCount: args.projectsWithDag.length,
        };
      }
      if (/FROM runs WHERE run_id/u.test(sql)) {
        const runId = params[0] as string;
        const run = args.runs[runId];
        if (run === undefined) return { rows: [], rowCount: 0 };
        return { rows: [{ project_id: run.projectId, status: run.status }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = { query: client.query, connect: async () => client };
  return pool as unknown as pg.Pool;
}

/** A recording walker: counts walks per project, returns a drained result. */
class RecordingWalker implements DagWalker {
  readonly walks: string[] = [];
  // Optional per-walk hook so a test can observe/await concurrency.
  constructor(private readonly onWalk?: (projectId: string) => Promise<void>) {}
  async walk(projectId: string): Promise<WalkResult> {
    this.walks.push(projectId);
    if (this.onWalk !== undefined) await this.onWalk(projectId);
    return { projectId, status: "drained", enqueuedSpecIds: [], enqueuedRunIds: [] };
  }
}

/** A recording percolation coordinator: counts passes per project. */
class RecordingPercolation implements ChangePercolationCoordinator {
  readonly passes: string[] = [];
  constructor(private readonly fail = false) {}
  async percolate(projectId: string): Promise<PercolationPassResult> {
    this.passes.push(projectId);
    if (this.fail) throw new Error("percolation pass blew up");
    return {
      projectId,
      absorbed: [],
      deferred: [],
      replanned: [],
      reexecuting: [],
      inFlight: [],
      held: [],
      unchanged: [],
      skipped: [],
    };
  }
}

// Let the fire-and-forget notify handler + background subscribe microtasks settle.
const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });
const flush = async (): Promise<void> => {
  await tick();
  await tick();
};

describe("DagWalkerSubscriber", () => {
  it("walks every project with a DAG on startup", async () => {
    const pool = fakePool({ projectsWithDag: ["project_a", "project_b"], runs: {} });
    const listener = new FakeNotifyListener();
    const walker = new RecordingWalker();
    const sub = new DagWalkerSubscriber({ pool, notifyListener: listener as never, walker });

    await sub.start();
    // The initial drive is fire-and-forget.
    await flush();

    expect(new Set(walker.walks)).toEqual(new Set(["project_a", "project_b"]));
    sub.stop();
  });

  it("a TERMINAL run notification fires the walker for that run's project", async () => {
    const pool = fakePool({
      projectsWithDag: [],
      runs: { run_done: { projectId: "project_x", status: "completed" } },
    });
    const listener = new FakeNotifyListener();
    const walker = new RecordingWalker();
    const sub = new DagWalkerSubscriber({ pool, notifyListener: listener as never, walker });
    await sub.start();
    // Let the background subscribe register.
    await flush();
    // Nothing to do on startup (no DAG).
    expect(walker.walks).toEqual([]);

    listener.fire(RUN_ACTIVITY_CHANNEL, "run_done");
    await flush();

    expect(walker.walks).toEqual(["project_x"]);
    sub.stop();
  });

  it("a NON-terminal run notification does NOT fire the walker", async () => {
    const pool = fakePool({
      projectsWithDag: [],
      runs: { run_running: { projectId: "project_x", status: "running" } },
    });
    const listener = new FakeNotifyListener();
    const walker = new RecordingWalker();
    const sub = new DagWalkerSubscriber({ pool, notifyListener: listener as never, walker });
    await sub.start();
    await flush();

    listener.fire(RUN_ACTIVITY_CHANNEL, "run_running");
    await flush();

    // Mid-flight events do not re-trigger.
    expect(walker.walks).toEqual([]);
    sub.stop();
  });

  it("a DAG-change (spec-creation) notification walks the carried project", async () => {
    // The core fix: a freshly-derived/created project has pending specs but ZERO
    // runs, so only the dag-change channel can wake its first walk. The payload IS
    // the project id, so the walk runs directly with no run resolution.
    const pool = fakePool({ projectsWithDag: [], runs: {} });
    const listener = new FakeNotifyListener();
    const walker = new RecordingWalker();
    const sub = new DagWalkerSubscriber({ pool, notifyListener: listener as never, walker });
    await sub.start();
    await flush();
    // Nothing on startup (no DAG yet).
    expect(walker.walks).toEqual([]);

    listener.fire(DAG_CHANGE_CHANNEL, "project_new");
    await flush();

    expect(walker.walks).toEqual(["project_new"]);
    sub.stop();
  });

  it("an empty dag-change payload is ignored (no walk)", async () => {
    const pool = fakePool({ projectsWithDag: [], runs: {} });
    const listener = new FakeNotifyListener();
    const walker = new RecordingWalker();
    const sub = new DagWalkerSubscriber({ pool, notifyListener: listener as never, walker });
    await sub.start();
    await flush();

    listener.fire(DAG_CHANGE_CHANNEL, "");
    await flush();

    expect(walker.walks).toEqual([]);
    sub.stop();
  });

  it("coalesces a burst of dag-change notifications into a single re-walk", async () => {
    // A derive inserts many specs for one project, firing a burst of dag-change
    // NOTIFYs. They must collapse through the per-project guard to in-flight + one
    // re-walk — never an unbounded walk-per-spec storm (no busy loop).
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstWalk = true;
    const walker = new RecordingWalker(async () => {
      if (firstWalk) {
        firstWalk = false;
        await gate;
      }
    });
    const pool = fakePool({ projectsWithDag: [], runs: {} });
    const listener = new FakeNotifyListener();
    const sub = new DagWalkerSubscriber({ pool, notifyListener: listener as never, walker });
    await sub.start();
    await flush();

    listener.fire(DAG_CHANGE_CHANNEL, "project_new");
    // walk 1 starts + parks
    await flush();
    listener.fire(DAG_CHANGE_CHANNEL, "project_new");
    listener.fire(DAG_CHANGE_CHANNEL, "project_new");
    listener.fire(DAG_CHANGE_CHANNEL, "project_new");
    await flush();

    release();
    await flush();

    // Exactly two walks: the original + ONE coalesced re-walk (not four).
    expect(walker.walks).toEqual(["project_new", "project_new"]);
    sub.stop();
  });

  it("ignores an unknown run id (not yet visible)", async () => {
    const pool = fakePool({ projectsWithDag: [], runs: {} });
    const listener = new FakeNotifyListener();
    const walker = new RecordingWalker();
    const sub = new DagWalkerSubscriber({ pool, notifyListener: listener as never, walker });
    await sub.start();
    await flush();

    listener.fire(RUN_ACTIVITY_CHANNEL, "run_missing");
    await flush();

    expect(walker.walks).toEqual([]);
    sub.stop();
  });

  it("coalesces concurrent triggers for one project into a single re-walk", async () => {
    // The walk blocks on a gate the test releases, so two triggers arrive while
    // the first walk is in flight. Coalescing must collapse them into exactly one
    // follow-up walk (in-flight + one re-walk), never three concurrent walks.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstWalk = true;
    const walker = new RecordingWalker(async () => {
      if (firstWalk) {
        firstWalk = false;
        // Hold the first walk open.
        await gate;
      }
    });
    const pool = fakePool({
      projectsWithDag: [],
      runs: { run_done: { projectId: "project_x", status: "completed" } },
    });
    const listener = new FakeNotifyListener();
    const sub = new DagWalkerSubscriber({ pool, notifyListener: listener as never, walker });
    await sub.start();
    await flush();

    // Three terminal notifications for the same project while walk 1 is parked.
    listener.fire(RUN_ACTIVITY_CHANNEL, "run_done");
    // The first walk starts + parks on the gate.
    await flush();
    listener.fire(RUN_ACTIVITY_CHANNEL, "run_done");
    listener.fire(RUN_ACTIVITY_CHANNEL, "run_done");
    await flush();

    // Let the first walk finish; the coalesced re-walk runs once.
    release();
    await flush();

    // Exactly two walks: the original + ONE coalesced re-walk (not three).
    expect(walker.walks).toEqual(["project_x", "project_x"]);
    sub.stop();
  });

  it("runs the change-percolation pass alongside the walk on a terminal notification (P2c-2)", async () => {
    const pool = fakePool({
      projectsWithDag: [],
      runs: { run_done: { projectId: "project_x", status: "completed" } },
    });
    const listener = new FakeNotifyListener();
    const walker = new RecordingWalker();
    const percolation = new RecordingPercolation();
    const sub = new DagWalkerSubscriber({ pool, notifyListener: listener as never, walker, percolation });
    await sub.start();
    await flush();

    listener.fire(RUN_ACTIVITY_CHANNEL, "run_done");
    await flush();

    // The walk AND the percolation pass both ran for the run's project.
    expect(walker.walks).toEqual(["project_x"]);
    expect(percolation.passes).toEqual(["project_x"]);
    sub.stop();
  });

  it("a percolation failure is non-fatal to the walk loop (logged, swallowed)", async () => {
    const pool = fakePool({
      projectsWithDag: [],
      runs: { run_done: { projectId: "project_x", status: "completed" } },
    });
    const listener = new FakeNotifyListener();
    const walker = new RecordingWalker();
    const percolation = new RecordingPercolation(true);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sub = new DagWalkerSubscriber({ pool, notifyListener: listener as never, walker, percolation });
    await sub.start();
    await flush();

    expect(() => listener.fire(RUN_ACTIVITY_CHANNEL, "run_done")).not.toThrow();
    await flush();

    // The walk still ran; the percolation error was logged, not thrown.
    expect(walker.walks).toEqual(["project_x"]);
    expect(percolation.passes).toEqual(["project_x"]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    sub.stop();
  });

  it("stop() unsubscribes from the bus", async () => {
    const pool = fakePool({ projectsWithDag: [], runs: {} });
    const listener = new FakeNotifyListener();
    const sub = new DagWalkerSubscriber({ pool, notifyListener: listener as never, walker: new RecordingWalker() });
    await sub.start();
    // Let the background subscribe register before stopping.
    await flush();
    sub.stop();
    // Two channels are subscribed (run-activity + dag-change); stop tears both down.
    expect(listener.unsubscribeCount).toBe(2);
  });

  it("does not throw into the notify pump when trigger resolution fails", async () => {
    // A pool whose runs read throws: the handler must swallow + log, never crash.
    const throwingClient = {
      query: async (sql: string) => {
        if (/^(BEGIN|COMMIT|ROLLBACK)/u.test(sql.trim())) return { rows: [], rowCount: 0 };
        if (/FROM runs WHERE run_id/u.test(sql)) throw new Error("db down");
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    const throwingPool = {
      query: throwingClient.query,
      connect: async () => throwingClient,
    } as unknown as pg.Pool;
    const listener = new FakeNotifyListener();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sub = new DagWalkerSubscriber({
      pool: throwingPool,
      notifyListener: listener as never,
      walker: new RecordingWalker(),
    });
    await sub.start();
    await flush();

    expect(() => listener.fire(RUN_ACTIVITY_CHANNEL, "run_x")).not.toThrow();
    await flush();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    sub.stop();
  });
});
