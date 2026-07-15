import { describe, expect, it } from "vitest";
import {
  applyCost,
  applyCostsFrame,
  applySnapshotFrame,
  applyStatus,
  applyTask,
  COST_DRAIN_IDLE_MS,
  CostFrameParseError,
  createCostDrainCloser,
  emptyTotals,
  getRunStreamPhase,
  isFinalStreamState,
  isFiniteDecimalString,
  markStreamUnavailableUnlessFinal,
  parseCostRecord,
  parseCostRecords,
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
  const doc = {
    createElement: (tag: string) => {
      const el: Record<string, unknown> = {
        className: "",
        style: {},
        textContent: "",
        append: () => {},
        tagName: tag.toUpperCase(),
      };
      return el;
    },
  };
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
    ownerDocument: doc as unknown as Document,
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
  overrides: Partial<{ inputTokens: number; totalTokens: number; costUsd: string | null }> = {},
) {
  return {
    id,
    billingMode: "per_token" as const,
    model: "m",
    inputTokens: overrides.inputTokens ?? 10,
    outputTokens: 5,
    cachedInputTokens: 0,
    totalTokens: overrides.totalTokens ?? 15,
    costUsd: overrides.costUsd === undefined ? "0.0010" : overrides.costUsd,
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

describe("cost parse atomic fail-closed", () => {
  it("rejects missing own id/costUsd, empty id/model, fractions, bad costUsd", () => {
    expect(() => parseCostRecord({ billingMode: "per_token", model: "m", costUsd: null })).toThrow(CostFrameParseError);
    expect(() => parseCostRecord({ id: 1, billingMode: "per_token", model: "m" })).toThrow(CostFrameParseError);
    expect(() => parseCostRecord(cost("  "))).toThrow(CostFrameParseError);
    expect(() => parseCostRecord({ ...cost(1), model: "  " })).toThrow(CostFrameParseError);
    expect(() => parseCostRecord({ ...cost(1), inputTokens: 1.5 })).toThrow(CostFrameParseError);
    expect(() => parseCostRecord({ ...cost(1), costUsd: "not-a-number" })).toThrow(CostFrameParseError);
    expect(() => parseCostRecord({ ...cost(1), costUsd: "Infinity" })).toThrow(CostFrameParseError);
    expect(() => parseCostRecord({ ...cost(1), id: {} })).toThrow(CostFrameParseError);
    expect(parseCostRecord(cost(7)).id).toBe("7");
    expect(parseCostRecord(cost(1, { costUsd: null })).costUsd).toBeNull();
  });

  it("rejects parseFloat-prefix junk, hex, and non-finite costUsd/ids", () => {
    // parseFloat("1.25junk") === 1.25 — full-string boundary must still reject.
    expect(isFiniteDecimalString("1.25junk")).toBe(false);
    expect(() => parseCostRecord(cost(1, { costUsd: "1.25junk" }))).toThrow(CostFrameParseError);
    expect(isFiniteDecimalString("0x10")).toBe(false);
    expect(() => parseCostRecord(cost(1, { costUsd: "0x10" }))).toThrow(CostFrameParseError);
    expect(() => parseCostRecord(cost(1, { costUsd: "NaN" }))).toThrow(CostFrameParseError);
    expect(() => parseCostRecord(cost(1, { costUsd: "-Infinity" }))).toThrow(CostFrameParseError);
    expect(() => parseCostRecord(cost(Number.NaN))).toThrow(CostFrameParseError);
    expect(() => parseCostRecord(cost(Number.POSITIVE_INFINITY))).toThrow(CostFrameParseError);
    expect(() => parseCostRecord(cost("NaN"))).toThrow(CostFrameParseError);
    expect(() => parseCostRecord(cost("Infinity"))).toThrow(CostFrameParseError);
    expect(() => parseCostRecord(cost("-Infinity"))).toThrow(CostFrameParseError);
  });

  it("accepts representative DB numeric costUsd strings", () => {
    expect(parseCostRecord(cost(1, { costUsd: "0.0010" })).costUsd).toBe("0.0010");
    expect(parseCostRecord(cost(1, { costUsd: "0" })).costUsd).toBe("0");
    expect(parseCostRecord(cost(1, { costUsd: "12.50" })).costUsd).toBe("12.50");
    expect(parseCostRecord(cost(1, { costUsd: "-0.01" })).costUsd).toBe("-0.01");
    expect(parseCostRecord(cost(1, { costUsd: "1e-4" })).costUsd).toBe("1e-4");
    expect(parseCostRecord(cost(1, { costUsd: "1.5E+2" })).costUsd).toBe("1.5E+2");
    expect(parseCostRecord(cost(42)).id).toBe("42");
    expect(parseCostRecord(cost("cost_abc-9")).id).toBe("cost_abc-9");
  });

  it("parseCostRecords is atomic: non-array or mixed valid+invalid throws", () => {
    expect(() => parseCostRecords("nope")).toThrow(CostFrameParseError);
    expect(() => parseCostRecords(null)).toThrow(CostFrameParseError);
    expect(() => parseCostRecords([cost(1), { noId: true }])).toThrow(/costs\[1\]/u);
    expect(() => parseCostRecords([cost(1), cost(2, { costUsd: "1.25junk" })])).toThrow(/costs\[1\]/u);
    expect(parseCostRecords([])).toEqual([]);
    expect(parseCostRecords([cost(1)]).map((c) => c.id)).toEqual(["1"]);
  });

  it("mixed junk costUsd frame does not mutate totals or re-arm drain", () => {
    const { root } = rootWithFlag();
    const totals = emptyTotals();
    const scheduler = makeScheduler();
    const drain = createCostDrainCloser({
      idleMs: COST_DRAIN_IDLE_MS,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    });
    applySnapshotFrame(
      root,
      totals,
      { costs: [cost(1)], run: { status: "completed", outcome: null } },
      {
        noteCostActivity: () => drain.noteCostActivity(),
        enterDrain: (c) => drain.enterDrain(c),
        close: () => {},
      },
    );
    const gen0 = drain.generation();
    const seen = [...totals.seenIds];
    expect(() =>
      applyCostsFrame(root, totals, [cost(2, { costUsd: "1.25junk" })], {
        noteCostActivity: () => drain.noteCostActivity(),
      }),
    ).toThrow(CostFrameParseError);
    expect(totals.inputTokens).toBe(10);
    expect([...totals.seenIds]).toEqual(seen);
    expect(drain.generation()).toBe(gen0);
    expect(scheduler.live()).toHaveLength(1);
  });

  it("dedupes by stable id", () => {
    const totals = emptyTotals();
    expect(applyCost(totals, parseCostRecord(cost(1)))).toBe(true);
    expect(applyCost(totals, parseCostRecord(cost(1, { inputTokens: 99 })))).toBe(false);
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

  it("live snapshot resets; reconnect applies only unseen costs and does not demote", () => {
    const { root, header, costPerToken } = rootWithFlag();
    const totals = emptyTotals();
    const scheduler = makeScheduler();
    const drain = createCostDrainCloser({
      idleMs: COST_DRAIN_IDLE_MS,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    });
    let closed = false;
    const hooks = {
      noteCostActivity: () => drain.noteCostActivity(),
      enterDrain: (c: () => void) => drain.enterDrain(c),
      close: () => {
        closed = true;
      },
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
    const gen0 = drain.generation();

    const again = applySnapshotFrame(
      root,
      totals,
      { costs: [cost(1), cost(1)], run: { status: "running", outcome: null } },
      hooks,
    );
    expect(again.applied).toBe(false);
    expect(again.costsDelta).toBe(0);
    expect(totals.inputTokens).toBe(10);
    expect(header.textContent).toBe("completed");
    expect(drain.generation()).toBe(gen0);

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
    expect(drain.generation()).toBe(gen0 + 1);
    expect(closed).toBe(false);
  });

  it("mixed valid+invalid costs frame leaves totals/seen/deadline unchanged", () => {
    const { root, header } = rootWithFlag();
    const totals = emptyTotals();
    const scheduler = makeScheduler();
    const drain = createCostDrainCloser({
      idleMs: COST_DRAIN_IDLE_MS,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    });
    const hooks = {
      noteCostActivity: () => drain.noteCostActivity(),
      enterDrain: (c: () => void) => drain.enterDrain(c),
      close: () => {},
    };

    applySnapshotFrame(root, totals, { costs: [cost(1)], run: { status: "completed", outcome: null } }, hooks);
    expect(totals.inputTokens).toBe(10);
    expect(totals.seenIds.size).toBe(1);
    const gen0 = drain.generation();
    const seenSnap = [...totals.seenIds];

    // Live-phase would reset only after parse — invalid frame must not wipe totals.
    setRunStreamPhase(root, "live");
    expect(() =>
      applySnapshotFrame(
        root,
        totals,
        { costs: [cost(99), { noId: true }], run: { status: "running", outcome: null } },
        hooks,
      ),
    ).toThrow(CostFrameParseError);
    expect(totals.inputTokens).toBe(10);
    expect([...totals.seenIds]).toEqual(seenSnap);
    expect(header.textContent).toBe("completed");
    expect(drain.generation()).toBe(gen0);

    // Draining reconnect with mixed frame: same atomic reject.
    setRunStreamPhase(root, "draining");
    expect(() =>
      applyCostsFrame(root, totals, [cost(2), { id: 3, billingMode: "per_token", model: "m", inputTokens: 1.5 }], {
        noteCostActivity: () => drain.noteCostActivity(),
      }),
    ).toThrow(CostFrameParseError);
    expect(totals.inputTokens).toBe(10);
    expect([...totals.seenIds]).toEqual(seenSnap);
    expect(drain.generation()).toBe(gen0);
    expect(scheduler.live()).toHaveLength(1);
  });

  it("event:costs deltas incorporate once; repeats do not re-arm", () => {
    const { root } = rootWithFlag();
    const totals = emptyTotals();
    const scheduler = makeScheduler();
    const drain = createCostDrainCloser({
      idleMs: COST_DRAIN_IDLE_MS,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    });
    setRunStreamPhase(root, "draining");
    setStreamState(root, "final");
    drain.enterDrain(() => {});
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

  it("repeated errors do not extend the close deadline", () => {
    const scheduler = makeScheduler();
    const drain = createCostDrainCloser({
      idleMs: COST_DRAIN_IDLE_MS,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    });
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
    expect(scheduler.live()).toHaveLength(1);
    expect(closed).toBe(false);
    expect(drain.isDraining()).toBe(true);
  });

  it("stale canceled timer cannot close after a newer real-cost arm", () => {
    const scheduler = makeScheduler();
    const drain = createCostDrainCloser({
      idleMs: COST_DRAIN_IDLE_MS,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    });
    let closeCount = 0;
    drain.enterDrain(() => {
      closeCount += 1;
    });
    const firstId = scheduler.timers[0]!.id;
    drain.noteCostActivity();
    const secondId = scheduler.live()[0]!.id;
    scheduler.fire(firstId);
    expect(closeCount).toBe(0);
    expect(drain.isClosed()).toBe(false);
    scheduler.fire(secondId);
    expect(closeCount).toBe(1);
    expect(drain.isClosed()).toBe(true);
  });

  it("closed ignores snapshots and costs; dispose is terminal", () => {
    const { root } = rootWithFlag();
    const totals = emptyTotals();
    const drain = createCostDrainCloser();
    drain.enterDrain(() => {});
    drain.dispose();
    drain.enterDrain(() => {});
    drain.noteCostActivity();
    expect(drain.isClosed()).toBe(true);
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
