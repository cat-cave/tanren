import { describe, expect, it, vi } from "vitest";
import {
  applyCost,
  applyCostsFrame,
  applySnapshotFrame,
  applyStatus,
  applyTask,
  COST_DRAIN_IDLE_MS,
  createCostDrainCloser,
  emptyTotals,
  getRunStreamPhase,
  isFinalStreamState,
  markStreamUnavailableUnlessFinal,
  parseCostRecord,
  setRunStreamPhase,
  setStreamState,
} from "../src/client/runStream.js";

function rootWithFlag() {
  const store: Record<string, string> = {};
  const flag = {
    textContent: "",
    title: "",
    removeAttribute(name: string) {
      if (name === "title") this.title = "";
    },
  };
  const statusChip = {
    classList: { remove: () => {}, add: () => {} },
    querySelector: () => null as null,
    textContent: "",
    append: (..._nodes: unknown[]) => {},
  };
  const header = { textContent: "" };
  const costPerToken = { textContent: "" };
  const costTokens = { textContent: "" };
  const costSources = { innerHTML: "", append: () => {} };
  const moment = {
    querySelector: (sel: string) => {
      if (sel === ".dot") return { className: "", textContent: "" };
      if (sel === ".ph") return { className: "", textContent: "task" };
      return null;
    },
    classList: { toggle: () => {} },
  };
  const root = {
    dataset: store as DOMStringMap,
    querySelector: (selector: string) => {
      if (selector === '[data-rd="live-flag"]') return flag;
      if (selector === '[data-rd="run-status"]') return statusChip;
      if (selector === '[data-rd="header-status"]') return header;
      if (selector === '[data-rd="cost-per-token"]') return costPerToken;
      if (selector === '[data-rd="cost-tokens"]') return costTokens;
      if (selector === '[data-rd="cost-sources"]') return costSources;
      if (selector.startsWith("[data-rd-moment=")) return moment;
      return null;
    },
  };
  return { root: root as unknown as HTMLElement, flag, statusChip, header, costPerToken };
}

function cost(
  id: string | number,
  overrides: Partial<{ inputTokens: number; totalTokens: number; costUsd: string }> = {},
) {
  return {
    id,
    billingMode: "per_token" as const,
    model: "m",
    inputTokens: overrides.inputTokens ?? 10,
    outputTokens: 5,
    cachedInputTokens: 0,
    totalTokens: overrides.totalTokens ?? 15,
    costUsd: overrides.costUsd ?? "0.0010",
  };
}

function makeScheduler() {
  const timers: Array<{ id: number; fn: () => void; ms: number; canceled: boolean }> = [];
  let nextId = 1;
  return {
    timers,
    schedule: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ id, fn, ms, canceled: false });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (handle: ReturnType<typeof setTimeout>) => {
      const t = timers.find((x) => x.id === (handle as unknown as number));
      if (t !== undefined) t.canceled = true;
    },
    live: () => timers.filter((t) => !t.canceled),
    fire: (id: number) => {
      const t = timers.find((x) => x.id === id);
      if (t === undefined || t.canceled) return;
      t.canceled = true;
      t.fn();
    },
  };
}

describe("cost parse fail-closed", () => {
  it("rejects missing/empty/non-scalar ids and broken token fields", () => {
    expect(parseCostRecord({ billingMode: "per_token", model: "m", inputTokens: 1 })).toBeUndefined();
    expect(
      parseCostRecord({
        id: "",
        billingMode: "per_token",
        model: "m",
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 0,
        costUsd: null,
      }),
    ).toBeUndefined();
    expect(
      parseCostRecord({
        id: {},
        billingMode: "per_token",
        model: "m",
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 0,
        costUsd: null,
      }),
    ).toBeUndefined();
    expect(
      parseCostRecord({
        id: 1,
        billingMode: "nope",
        model: "m",
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 0,
        costUsd: null,
      }),
    ).toBeUndefined();
    expect(parseCostRecord(cost(7))?.id).toBe("7");
  });

  it("dedupes by stable id", () => {
    const totals = emptyTotals();
    expect(applyCost(totals, parseCostRecord(cost(1))!)).toBe(true);
    expect(applyCost(totals, parseCostRecord(cost(1, { inputTokens: 99 }))!)).toBe(false);
    expect(totals.inputTokens).toBe(10);
    expect(totals.seenIds.has("1")).toBe(true);
  });
});

describe("run stream terminal state machine", () => {
  it("locks status/header after terminal", () => {
    const { root, header, flag } = rootWithFlag();
    expect(applyStatus(root, "completed", null)).toBe(true);
    expect(isFinalStreamState(root)).toBe(true);
    expect(getRunStreamPhase(root)).toBe("draining");
    expect(flag.textContent).toBe("● final");
    expect(applyStatus(root, "running", null)).toBe(false);
    expect(header.textContent).toBe("completed");
  });

  it("forbids task mutation after terminal", () => {
    const { root } = rootWithFlag();
    applyStatus(root, "completed", null);
    expect(applyTask(root, { taskId: "t1", status: "running", outcome: null, startedAt: null, endedAt: null })).toBe(
      false,
    );
  });

  it("live snapshot resets; identical reconnect snapshot applies only unseen costs and does not demote", () => {
    const { root, header, costPerToken } = rootWithFlag();
    const totals = emptyTotals();
    const sched = makeScheduler();
    const drain = createCostDrainCloser({ idleMs: COST_DRAIN_IDLE_MS, schedule: sched.schedule, cancel: sched.cancel });
    const hooks = {
      noteCostActivity: () => drain.noteCostActivity(),
      enterDrain: (c: () => void) => drain.enterDrain(c),
      close: vi.fn(),
    };

    const first = applySnapshotFrame(
      root,
      totals,
      { costs: [cost(1)], run: { status: "completed", outcome: null } },
      hooks,
    );
    expect(first.costsReset).toBe(true);
    expect(totals.inputTokens).toBe(10);
    expect(costPerToken.textContent).toBe("$0.0010");
    expect(getRunStreamPhase(root)).toBe("draining");
    expect(header.textContent).toBe("completed");
    const gen0 = drain.generation();

    // Identical reconnect snapshot: no new ids → no-op, no re-arm, no demotion.
    const again = applySnapshotFrame(
      root,
      totals,
      { costs: [cost(1), cost(1)], run: { status: "running", outcome: null } },
      hooks,
    );
    expect(again.applied).toBe(false);
    expect(again.costsDelta).toBe(0);
    expect(again.statusApplied).toBe(false);
    expect(totals.inputTokens).toBe(10);
    expect(header.textContent).toBe("completed");
    expect(drain.generation()).toBe(gen0);

    // Unseen late cost in reconnect snapshot is incorporated exactly once and re-arms.
    const late = applySnapshotFrame(
      root,
      totals,
      {
        costs: [cost(1), cost(2, { inputTokens: 3, totalTokens: 4, costUsd: "0.0002" })],
        run: { status: "running", outcome: null },
      },
      hooks,
    );
    expect(late.costsDelta).toBe(1);
    expect(totals.inputTokens).toBe(13);
    expect(header.textContent).toBe("completed");
    expect(drain.generation()).toBe(gen0 + 1);

    // Same reconnect again → no double-count, no re-arm.
    const third = applySnapshotFrame(
      root,
      totals,
      {
        costs: [cost(1), cost(2, { inputTokens: 3, totalTokens: 4, costUsd: "0.0002" })],
        run: { status: "completed", outcome: null },
      },
      hooks,
    );
    expect(third.costsDelta).toBe(0);
    expect(totals.inputTokens).toBe(13);
    expect(drain.generation()).toBe(gen0 + 1);
  });

  it("event:costs deltas incorporate once; repeats do not re-arm", () => {
    const { root } = rootWithFlag();
    const totals = emptyTotals();
    const sched = makeScheduler();
    const drain = createCostDrainCloser({ idleMs: COST_DRAIN_IDLE_MS, schedule: sched.schedule, cancel: sched.cancel });
    setRunStreamPhase(root, "draining");
    setStreamState(root, "final");
    drain.enterDrain(vi.fn());
    const gen0 = drain.generation();

    const r1 = applyCostsFrame(root, totals, [cost(9, { inputTokens: 3, totalTokens: 4, costUsd: "0.0002" })], {
      noteCostActivity: () => drain.noteCostActivity(),
    });
    expect(r1.costsDelta).toBe(1);
    expect(totals.inputTokens).toBe(3);
    expect(drain.generation()).toBe(gen0 + 1);

    const r2 = applyCostsFrame(root, totals, [cost(9, { inputTokens: 3, totalTokens: 4, costUsd: "0.0002" })], {
      noteCostActivity: () => drain.noteCostActivity(),
    });
    expect(r2.costsDelta).toBe(0);
    expect(totals.inputTokens).toBe(3);
    expect(drain.generation()).toBe(gen0 + 1);
  });

  it("malformed cost rows are skipped and do not re-arm", () => {
    const { root } = rootWithFlag();
    const totals = emptyTotals();
    const drain = createCostDrainCloser();
    setRunStreamPhase(root, "draining");
    drain.enterDrain(vi.fn());
    const gen0 = drain.generation();
    const r = applyCostsFrame(root, totals, [{ noId: true }, cost(3)], {
      noteCostActivity: () => drain.noteCostActivity(),
    });
    expect(r.costsDelta).toBe(1);
    expect(totals.seenIds.has("3")).toBe(true);
    expect(drain.generation()).toBe(gen0 + 1);
  });

  it("repeated errors do not extend the close deadline", () => {
    const sched = makeScheduler();
    const drain = createCostDrainCloser({ idleMs: COST_DRAIN_IDLE_MS, schedule: sched.schedule, cancel: sched.cancel });
    let closed = false;
    drain.enterDrain(() => {
      closed = true;
    });
    const gen0 = drain.generation();
    drain.onStreamError();
    drain.onStreamError();
    drain.enterDrain(() => {
      closed = true;
    });
    expect(drain.generation()).toBe(gen0);
    expect(sched.live()).toHaveLength(1);
    expect(closed).toBe(false);
    expect(drain.isDraining()).toBe(true);
    expect(drain.isClosed()).toBe(false);
  });

  it("stale canceled timer cannot close after a newer real-cost arm", () => {
    const sched = makeScheduler();
    const drain = createCostDrainCloser({ idleMs: COST_DRAIN_IDLE_MS, schedule: sched.schedule, cancel: sched.cancel });
    let closeCount = 0;
    drain.enterDrain(() => {
      closeCount += 1;
    });
    const firstId = sched.timers[0]!.id;
    drain.noteCostActivity();
    const secondId = sched.live()[0]!.id;
    sched.fire(firstId);
    expect(closeCount).toBe(0);
    expect(drain.isClosed()).toBe(false);
    expect(drain.isDraining()).toBe(true);
    sched.fire(secondId);
    expect(closeCount).toBe(1);
    expect(drain.isClosed()).toBe(true);
    expect(drain.isDraining()).toBe(false);
  });

  it("closed ignores snapshots and costs; dispose is terminal", () => {
    const { root } = rootWithFlag();
    const totals = emptyTotals();
    const drain = createCostDrainCloser();
    const close = vi.fn();
    drain.enterDrain(close);
    drain.dispose();
    drain.enterDrain(close);
    drain.noteCostActivity();
    expect(drain.isClosed()).toBe(true);
    expect(drain.isDraining()).toBe(false);
    setRunStreamPhase(root, "closed");
    expect(
      applySnapshotFrame(root, totals, { costs: [cost(1)], run: { status: "completed", outcome: null } }).applied,
    ).toBe(false);
    expect(applyCostsFrame(root, totals, [cost(1)]).applied).toBe(false);
    expect(totals.inputTokens).toBe(0);
  });

  it("markStreamUnavailableUnlessFinal preserves final", () => {
    const { root, flag } = rootWithFlag();
    flag.textContent = "● final";
    setRunStreamPhase(root, "draining");
    markStreamUnavailableUnlessFinal(root, "Disconnected");
    expect(flag.textContent).toBe("● final");
  });
});
