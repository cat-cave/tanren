import { describe, expect, it, vi } from "vitest";
import {
  applyCostsFrame,
  applySnapshotFrame,
  applyStatus,
  applyTask,
  COST_DRAIN_IDLE_MS,
  createCostDrainCloser,
  getRunStreamPhase,
  isFinalStreamState,
  markStreamUnavailableUnlessFinal,
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
  const costSources = {
    innerHTML: "",
    append: () => {},
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
  return {
    root: root as unknown as HTMLElement,
    flag,
    statusChip,
    header,
    costPerToken,
  };
}

function emptyTotals() {
  return {
    perTokenUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    bySource: new Map(),
  };
}

const sampleCost = {
  billingMode: "per_token" as const,
  model: "m",
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  totalTokens: 15,
  costUsd: "0.0010",
};

const lateCost = {
  ...sampleCost,
  inputTokens: 3,
  outputTokens: 1,
  totalTokens: 4,
  costUsd: "0.0002",
};

/** Controllable timer scheduler for drain deadline tests. */
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
      const id = handle as unknown as number;
      const t = timers.find((x) => x.id === id);
      if (t !== undefined) t.canceled = true;
    },
    live: () => timers.filter((t) => !t.canceled),
    fire: (id: number) => {
      const t = timers.find((x) => x.id === id);
      if (t === undefined || t.canceled) return;
      t.canceled = true; // one-shot, like setTimeout after fire
      t.fn();
    },
  };
}

describe("run stream terminal state machine", () => {
  it("marks the live flag stale or unavailable, then clears it on a valid frame", () => {
    const { root, flag } = rootWithFlag();
    setStreamState(root, "stale", "Malformed frame");
    expect(flag.textContent).toBe("⚠ stream stale");
    setStreamState(root, "unavailable", "Disconnected");
    expect(flag.textContent).toBe("⚠ stream unavailable");
    setStreamState(root, "live");
    expect(flag.textContent).toBe("↻ live");
  });

  it("locks status/header after terminal — later non-terminal status cannot demote", () => {
    const { root, statusChip, header, flag } = rootWithFlag();
    expect(applyStatus(root, "completed", null)).toBe(true);
    expect(isFinalStreamState(root)).toBe(true);
    expect(getRunStreamPhase(root)).toBe("draining");
    expect(flag.textContent).toBe("● final");
    expect(header.textContent).toBe("completed");
    expect(applyStatus(root, "running", null)).toBe(false);
    expect(header.textContent).toBe("completed");
    expect(String(statusChip.textContent)).not.toContain("running");
  });

  it("forbids task/trajectory mutation after terminal", () => {
    const { root } = rootWithFlag();
    applyStatus(root, "completed", null);
    expect(
      applyTask(root, {
        taskId: "t1",
        status: "running",
        outcome: null,
        startedAt: null,
        endedAt: null,
      }),
    ).toBe(false);
  });

  it("terminal snapshot establishes totals; later full snapshot leaves totals and deadline unchanged", () => {
    const { root, costPerToken, header } = rootWithFlag();
    const totals = emptyTotals();
    const sched = makeScheduler();
    const drain = createCostDrainCloser({
      idleMs: COST_DRAIN_IDLE_MS,
      schedule: sched.schedule,
      cancel: sched.cancel,
    });
    const close = vi.fn();
    const hooks = {
      noteCostActivity: () => drain.noteCostActivity(),
      enterDrain: (c: () => void) => drain.enterDrain(c),
      close,
    };

    const first = applySnapshotFrame(
      root,
      totals,
      { costs: [sampleCost], run: { status: "completed", outcome: null } },
      hooks,
    );
    expect(first.applied).toBe(true);
    expect(first.costsReset).toBe(true);
    expect(totals.inputTokens).toBe(10);
    expect(costPerToken.textContent).toBe("$0.0010");
    expect(getRunStreamPhase(root)).toBe("draining");
    expect(header.textContent).toBe("completed");
    expect(drain.generation()).toBe(1);
    expect(sched.live()).toHaveLength(1);

    // Reconnect/full snapshot during drain: ignore every field (incl. costs).
    const again = applySnapshotFrame(
      root,
      totals,
      {
        costs: [sampleCost, sampleCost],
        run: { status: "running", outcome: null },
      },
      hooks,
    );
    expect(again.applied).toBe(false);
    expect(again.costsReset).toBe(false);
    expect(again.costsDelta).toBe(0);
    expect(again.statusApplied).toBe(false);
    // Totals and drain deadline must not change (was wrongly 20 on 12d16510).
    expect(totals.inputTokens).toBe(10);
    expect(header.textContent).toBe("completed");
    expect(drain.generation()).toBe(1);
    expect(sched.live()).toHaveLength(1);
  });

  it("post-terminal costs delta adds exactly once and re-arms the idle deadline", () => {
    const { root, flag } = rootWithFlag();
    const totals = emptyTotals();
    const sched = makeScheduler();
    const drain = createCostDrainCloser({
      idleMs: COST_DRAIN_IDLE_MS,
      schedule: sched.schedule,
      cancel: sched.cancel,
    });
    drain.enterDrain(vi.fn());
    setRunStreamPhase(root, "draining");
    setStreamState(root, "final");
    const genAfterEnter = drain.generation();
    expect(genAfterEnter).toBe(1);

    expect(applyCostsFrame(root, totals, [lateCost], { noteCostActivity: () => drain.noteCostActivity() })).toBe(true);
    expect(totals.inputTokens).toBe(3);
    expect(totals.totalTokens).toBe(4);
    expect(flag.textContent).toBe("● final");
    expect(drain.generation()).toBe(genAfterEnter + 1);
    expect(sched.live()).toHaveLength(1);
    // Prior idle was canceled when re-armed.
    expect(sched.timers.filter((t) => t.canceled)).toHaveLength(1);
  });

  it("repeated stream errors do not add timers or extend the close deadline", () => {
    const sched = makeScheduler();
    const drain = createCostDrainCloser({
      idleMs: COST_DRAIN_IDLE_MS,
      schedule: sched.schedule,
      cancel: sched.cancel,
    });
    const close = vi.fn();
    drain.enterDrain(close);
    const gen0 = drain.generation();
    expect(sched.live()).toHaveLength(1);

    drain.onStreamError();
    drain.onStreamError();
    drain.onStreamError();
    // enterDrain while already draining is also a no-op for the deadline.
    drain.enterDrain(close);
    drain.enterDrain(close);

    expect(drain.generation()).toBe(gen0);
    expect(sched.live()).toHaveLength(1);
    expect(sched.timers).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("stale canceled timer callbacks cannot close after later real cost activity", () => {
    const sched = makeScheduler();
    const drain = createCostDrainCloser({
      idleMs: COST_DRAIN_IDLE_MS,
      schedule: sched.schedule,
      cancel: sched.cancel,
    });
    const close = vi.fn();
    drain.enterDrain(close);
    const firstId = sched.timers[0]!.id;

    // Real cost re-arms → cancels first timer, fences its generation.
    drain.noteCostActivity();
    expect(sched.timers.find((t) => t.id === firstId)?.canceled).toBe(true);
    const secondId = sched.live()[0]!.id;
    expect(secondId).not.toBe(firstId);

    // Fire the stale first callback — must not close.
    sched.fire(firstId);
    expect(close).not.toHaveBeenCalled();
    expect(drain.isClosed()).toBe(false);
    expect(drain.isDraining()).toBe(true);

    // Live deadline still closes once.
    sched.fire(secondId);
    expect(close).toHaveBeenCalledTimes(1);
    expect(drain.isClosed()).toBe(true);
  });

  it("closed/disposed phase rejects snapshots and costs; closes at most once", () => {
    const { root } = rootWithFlag();
    const totals = emptyTotals();
    const sched = makeScheduler();
    const drain = createCostDrainCloser({
      idleMs: COST_DRAIN_IDLE_MS,
      schedule: sched.schedule,
      cancel: sched.cancel,
    });
    const close = vi.fn();
    drain.enterDrain(close);
    const idleId = sched.live()[0]!.id;
    sched.fire(idleId);
    expect(close).toHaveBeenCalledTimes(1);
    expect(drain.isClosed()).toBe(true);
    expect(drain.isDraining()).toBe(false);

    // dispose is terminal — no reactivation.
    drain.dispose();
    drain.enterDrain(close);
    drain.noteCostActivity();
    drain.onStreamError();
    expect(drain.isClosed()).toBe(true);
    expect(drain.isDraining()).toBe(false);
    expect(sched.live()).toHaveLength(0);
    expect(close).toHaveBeenCalledTimes(1);

    setRunStreamPhase(root, "closed");
    const snap = applySnapshotFrame(
      root,
      totals,
      { costs: [sampleCost], run: { status: "completed", outcome: null } },
      {
        noteCostActivity: () => drain.noteCostActivity(),
        enterDrain: (c) => drain.enterDrain(c),
        close,
      },
    );
    expect(snap.applied).toBe(false);
    expect(applyCostsFrame(root, totals, [sampleCost], { noteCostActivity: () => drain.noteCostActivity() })).toBe(
      false,
    );
    expect(totals.inputTokens).toBe(0);
  });

  it("preserves final when markStreamUnavailableUnlessFinal is called", () => {
    const { root, flag } = rootWithFlag();
    flag.textContent = "● final";
    setRunStreamPhase(root, "draining");
    markStreamUnavailableUnlessFinal(root, "Disconnected");
    expect(flag.textContent).toBe("● final");
  });

  it("does not close on first post-terminal error; closes after idle quiet", () => {
    const sched = makeScheduler();
    const drain = createCostDrainCloser({
      idleMs: COST_DRAIN_IDLE_MS,
      schedule: sched.schedule,
      cancel: sched.cancel,
    });
    const close = vi.fn();
    drain.enterDrain(close);
    expect(drain.isDraining()).toBe(true);
    expect(close).not.toHaveBeenCalled();

    drain.onStreamError();
    expect(close).not.toHaveBeenCalled();
    expect(sched.live()).toHaveLength(1);

    sched.fire(sched.live()[0]!.id);
    expect(close).toHaveBeenCalledTimes(1);
    expect(drain.isClosed()).toBe(true);
  });
});
