// NEVER-STRAND subscriber composition + periodic-backstop tests, split from
// dagWalkerSubscriber.test.ts to keep each file under the 500-line cap. They prove —
// over a fake pool + fake PgNotifyListener + recording walker/percolation/reconciler
// (no Postgres) — that:
//   - the strand reconciler runs LAST in the walk chain (walk → percolate → reconcile)
//     on a terminal notification, so percolation owns any live-marker spec first;
//   - a reconciler failure is non-fatal (logged, swallowed) — the walk loop survives;
//   - the LOW-FREQUENCY PERIODIC backstop re-drives every project with NO new
//     notification (so a strand — which emits no `tanren_run` wake — self-heals), and
//     is cleared on stop();
//   - no backstop timer is armed when no reconciler is wired.

import { RUN_ACTIVITY_CHANNEL } from "@tanren/db";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { DagWalker, WalkResult } from "../src/engine/contracts/dagWalker.js";
import type { ChangePercolationCoordinator, PercolationPassResult } from "../src/engine/dag/percolation.js";
import type {
  SpecStrandReconcilePassResult,
  SpecStrandReconcilerContract,
} from "../src/engine/contracts/specStrandReconciler.js";
import { DagWalkerSubscriber } from "../src/engine/dag/subscriber.js";

class FakeNotifyListener {
  private handlers = new Map<string, Set<(payload: string) => void>>();
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
      const text = sql.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(text)) return { rows: [], rowCount: 0 };
      if (/DISTINCT project_id FROM specs/u.test(sql)) {
        return {
          rows: args.projectsWithDag.map((project_id) => ({ project_id })),
          rowCount: args.projectsWithDag.length,
        };
      }
      if (/FROM runs WHERE run_id/u.test(sql)) {
        const run = args.runs[params[0] as string];
        if (run === undefined) return { rows: [], rowCount: 0 };
        return { rows: [{ project_id: run.projectId, status: run.status }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return { query: client.query, connect: async () => client } as unknown as pg.Pool;
}

class RecordingWalker implements DagWalker {
  readonly walks: string[] = [];
  constructor(private readonly onWalk?: (projectId: string) => Promise<void>) {}
  async walk(projectId: string): Promise<WalkResult> {
    this.walks.push(projectId);
    if (this.onWalk !== undefined) await this.onWalk(projectId);
    return { projectId, status: "drained", enqueuedSpecIds: [], enqueuedRunIds: [] };
  }
}

class RecordingPercolation implements ChangePercolationCoordinator {
  readonly passes: string[] = [];
  async percolate(projectId: string): Promise<PercolationPassResult> {
    this.passes.push(projectId);
    return {
      projectId,
      absorbed: [],
      deferred: [],
      replanned: [],
      reexecuting: [],
      inFlight: [],
      held: [],
      unchanged: [],
    };
  }
}

class RecordingReconciler implements SpecStrandReconcilerContract {
  readonly passes: string[] = [];
  async reconcile(projectId: string): Promise<SpecStrandReconcilePassResult> {
    this.passes.push(projectId);
    return { projectId, reEnqueued: [], escalated: [] };
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

describe("DagWalkerSubscriber — NEVER-STRAND composition + periodic backstop", () => {
  it("runs the strand reconciler LAST in the chain (walk → percolate → reconcile) on a terminal notification", async () => {
    const order: string[] = [];
    const pool = fakePool({
      projectsWithDag: [],
      runs: { run_done: { projectId: "project_x", status: "done" } },
    });
    const listener = new FakeNotifyListener();
    const walker = new RecordingWalker(async () => {
      order.push("walk");
    });
    const percolation = new RecordingPercolation();
    const reconciler = new RecordingReconciler();
    const origPercolate = percolation.percolate.bind(percolation);
    percolation.percolate = async (p: string) => {
      order.push("percolate");
      return origPercolate(p);
    };
    const origReconcile = reconciler.reconcile.bind(reconciler);
    reconciler.reconcile = async (p: string) => {
      order.push("reconcile");
      return origReconcile(p);
    };
    const sub = new DagWalkerSubscriber({ pool, notifyListener: listener as never, walker, percolation, reconciler });
    await sub.start();
    await flush();

    listener.fire(RUN_ACTIVITY_CHANNEL, "run_done");
    await flush();

    expect(reconciler.passes).toEqual(["project_x"]);
    expect(order).toEqual(["walk", "percolate", "reconcile"]);
    sub.stop();
  });

  it("a reconciler failure is non-fatal to the walk loop (logged, swallowed)", async () => {
    const pool = fakePool({
      projectsWithDag: [],
      runs: { run_done: { projectId: "project_x", status: "done" } },
    });
    const listener = new FakeNotifyListener();
    const walker = new RecordingWalker();
    const reconciler = new RecordingReconciler();
    reconciler.reconcile = async () => {
      throw new Error("reconciler blew up");
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sub = new DagWalkerSubscriber({ pool, notifyListener: listener as never, walker, reconciler });
    await sub.start();
    await flush();

    expect(() => listener.fire(RUN_ACTIVITY_CHANNEL, "run_done")).not.toThrow();
    await flush();

    expect(walker.walks).toEqual(["project_x"]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    sub.stop();
  });

  it("the PERIODIC backstop re-walks (so a strand self-heals with no new notification), cleared on stop", async () => {
    vi.useFakeTimers();
    try {
      const pool = fakePool({ projectsWithDag: ["project_x"], runs: {} });
      const listener = new FakeNotifyListener();
      const walker = new RecordingWalker();
      const reconciler = new RecordingReconciler();
      const sub = new DagWalkerSubscriber({
        pool,
        notifyListener: listener as never,
        walker,
        reconciler,
        strandBackstopIntervalMs: 1_000,
      });
      await sub.start();
      await vi.advanceTimersByTimeAsync(0);
      const initialPasses = reconciler.passes.length;
      expect(initialPasses).toBeGreaterThan(0);

      // No notification at all — only the periodic backstop should re-drive.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reconciler.passes.length).toBeGreaterThan(initialPasses);

      sub.stop();
      const afterStop = reconciler.passes.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reconciler.passes.length).toBe(afterStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it("no periodic backstop is armed when no reconciler is wired", async () => {
    vi.useFakeTimers();
    try {
      const pool = fakePool({ projectsWithDag: ["project_x"], runs: {} });
      const listener = new FakeNotifyListener();
      const walker = new RecordingWalker();
      const sub = new DagWalkerSubscriber({
        pool,
        notifyListener: listener as never,
        walker,
        strandBackstopIntervalMs: 1_000,
      });
      await sub.start();
      await vi.advanceTimersByTimeAsync(0);
      const initial = walker.walks.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(walker.walks.length).toBe(initial);
      sub.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
