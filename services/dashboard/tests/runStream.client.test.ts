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

describe("run stream terminal state machine", () => {
  it("marks the live flag stale or unavailable, then clears it on a valid frame", () => {
    const { root, flag } = rootWithFlag();
    setStreamState(root, "stale", "Malformed frame");
    expect(flag.textContent).toBe("⚠ stream stale");
    expect(flag.title).toBe("Malformed frame");

    setStreamState(root, "unavailable", "Disconnected");
    expect(flag.textContent).toBe("⚠ stream unavailable");
    expect(flag.title).toBe("Disconnected");

    setStreamState(root, "live");
    expect(flag.textContent).toBe("↻ live");
    expect(flag.title).toBe("");
  });

  it("locks status/header after terminal — later non-terminal status cannot demote", () => {
    const { root, statusChip, header, flag } = rootWithFlag();
    expect(applyStatus(root, "completed", null)).toBe(true);
    expect(isFinalStreamState(root)).toBe(true);
    expect(getRunStreamPhase(root)).toBe("draining");
    expect(flag.textContent).toBe("● final");
    expect(header.textContent).toBe("completed");

    // Demotion attempt must be a no-op.
    expect(applyStatus(root, "running", null)).toBe(false);
    expect(header.textContent).toBe("completed");
    expect(String(statusChip.textContent)).not.toContain("running");
    expect(isFinalStreamState(root)).toBe(true);
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

  it("forbids snapshot cost reset after terminal; still accepts cost-drain deltas", () => {
    const { root, costPerToken } = rootWithFlag();
    const totals = emptyTotals();
    const drain = {
      noteCostActivity: vi.fn(),
      enterDrain: vi.fn(),
      close: vi.fn(),
    };

    applySnapshotFrame(
      root,
      totals,
      { costs: [sampleCost], run: { status: "completed", outcome: null } },
      drain,
    );
    expect(totals.inputTokens).toBe(10);
    expect(costPerToken.textContent).toBe("$0.0010");
    expect(getRunStreamPhase(root)).toBe("draining");

    // Post-terminal snapshot must not zero totals.
    const again = applySnapshotFrame(
      root,
      totals,
      { costs: [sampleCost], run: { status: "running", outcome: null } },
      drain,
    );
    expect(again.costsReset).toBe(false);
    expect(again.statusApplied).toBe(false);
    expect(totals.inputTokens).toBe(20); // delta append, not reset to 10
    expect(drain.noteCostActivity).toHaveBeenCalled();
  });

  it("applies cost frames during drain without demoting final flag", () => {
    const { root, flag } = rootWithFlag();
    const totals = emptyTotals();
    applyStatus(root, "failed", "crashed");
    expect(flag.textContent).toBe("● final");

    const note = vi.fn();
    expect(applyCostsFrame(root, totals, [sampleCost], { noteCostActivity: note })).toBe(true);
    expect(totals.totalTokens).toBe(15);
    expect(flag.textContent).toBe("● final");
    expect(note).toHaveBeenCalled();
  });

  it("preserves final when markStreamUnavailableUnlessFinal is called", () => {
    const { root, flag } = rootWithFlag();
    flag.textContent = "● final";
    setRunStreamPhase(root, "draining");
    markStreamUnavailableUnlessFinal(root, "Disconnected");
    expect(flag.textContent).toBe("● final");
  });

  it("does not close on first post-terminal error; closes after idle grace", () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const drain = createCostDrainCloser({
      idleMs: COST_DRAIN_IDLE_MS,
      schedule: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: () => {},
    });
    const close = vi.fn();
    drain.enterDrain(close);
    expect(drain.isDraining()).toBe(true);
    expect(close).not.toHaveBeenCalled();

    // Simulated EventSource error mid-drain: re-arms, does not close now.
    drain.onStreamError();
    expect(close).not.toHaveBeenCalled();
    expect(timers.length).toBeGreaterThanOrEqual(2);

    // Cost activity re-arms again.
    drain.noteCostActivity();
    expect(close).not.toHaveBeenCalled();

    // Fire latest idle timer → close.
    const last = timers[timers.length - 1];
    expect(last?.ms).toBe(COST_DRAIN_IDLE_MS);
    last?.fn();
    expect(close).toHaveBeenCalledTimes(1);
    expect(drain.isClosed()).toBe(true);
  });
});
