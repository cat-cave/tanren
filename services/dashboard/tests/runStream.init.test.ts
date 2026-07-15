// Wiring test for initRunStream: fake EventSource + controllable timers/DOM.
// Proves terminal drain, reconnect snapshot cost reconcile, atomic malformed
// frames, delta dedupe, error non-extension, stale-timer fencing, and
// exactly-once source.close (closeCalls === 1).

import { afterEach, describe, expect, it } from "vitest";
import { COST_DRAIN_IDLE_MS, initRunStream } from "../src/client/runStream.js";

type Listener = (event: { data?: string }) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  closeCalls = 0;
  private listeners = new Map<string, Listener[]>();

  constructor(url: string, _opts?: EventSourceInit) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: EventListenerOrEventListenerObject): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn as Listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closeCalls += 1;
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data: payload });
    }
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }
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

function cost(id: number | string, inputTokens = 10, costUsd: string | null = "0.0010") {
  return {
    id,
    billingMode: "per_token",
    model: "m",
    inputTokens,
    outputTokens: 1,
    cachedInputTokens: 0,
    totalTokens: inputTokens + 1,
    costUsd,
  };
}

function makeDom() {
  const store: Record<string, string> = { streamUrl: "/stream/r1" };
  const flag = { textContent: "↻ live", title: "", removeAttribute: () => {} };
  const statusChip = {
    classList: { remove: () => {}, add: () => {} },
    querySelector: () => null,
    textContent: "",
    append: (...parts: unknown[]) => {
      statusChip.textContent += parts.map(String).join("");
    },
  };
  const header = { textContent: "running" };
  const costPerToken = { textContent: "$0.0000" };
  const costTokens = { textContent: "0 / 0" };
  const costSources = {
    innerHTML: "",
    append: (..._n: unknown[]) => {},
  };
  const doc = {
    querySelector: (_sel: string): unknown => null,
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
  const root = {
    dataset: store,
    ownerDocument: doc as unknown as Document,
    querySelector: (sel: string) => {
      if (sel === '[data-rd="live-flag"]') return flag;
      if (sel === '[data-rd="run-status"]') return statusChip;
      if (sel === '[data-rd="header-status"]') return header;
      if (sel === '[data-rd="cost-per-token"]') return costPerToken;
      if (sel === '[data-rd="cost-tokens"]') return costTokens;
      if (sel === '[data-rd="cost-sources"]') return costSources;
      return null;
    },
    addEventListener: () => {},
  };
  doc.querySelector = (sel: string) => (sel === '[data-island="run-stream"]' ? root : null);
  return { doc: doc as unknown as Document, root, flag, header, statusChip, costPerToken };
}

afterEach(() => {
  FakeEventSource.reset();
});

describe("initRunStream wiring", () => {
  it("terminal drain + reconnect reconcile + atomic reject + closeCalls===1", () => {
    const { doc, flag, header, costPerToken } = makeDom();
    const sched = makeScheduler();

    // Isolated document seam only — no vi.stubGlobal("document").
    initRunStream({
      document: doc,
      EventSourceCtor: FakeEventSource as unknown as typeof EventSource,
      schedule: sched.schedule,
      cancel: sched.cancel,
      idleMs: COST_DRAIN_IDLE_MS,
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    const es = FakeEventSource.instances[0]!;

    es.emit("snapshot", {
      costs: [cost(1, 10, "0.0010")],
      run: { status: "running", outcome: null },
    });
    expect(costPerToken.textContent).toBe("$0.0010");
    expect(header.textContent).toBe("running");

    es.emit("status", { status: "completed", outcome: null });
    expect(flag.textContent).toBe("● final");
    expect(header.textContent).toBe("completed");
    expect(sched.live()).toHaveLength(1);
    const armAfterTerminal = sched.live()[0]!.id;

    // Identical reconnect: no demotion / double-count / re-arm.
    es.emit("snapshot", {
      costs: [cost(1, 10, "0.0010")],
      run: { status: "running", outcome: null },
    });
    expect(header.textContent).toBe("completed");
    expect(costPerToken.textContent).toBe("$0.0010");
    expect(sched.live().map((t) => t.id)).toEqual([armAfterTerminal]);

    // Mixed valid+invalid reconnect: mark stale, no mutation, no re-arm.
    es.emit("snapshot", {
      costs: [cost(1, 10, "0.0010"), { noId: true }],
      run: { status: "running", outcome: null },
    });
    expect(costPerToken.textContent).toBe("$0.0010");
    expect(header.textContent).toBe("completed");
    // Final flag stays sticky; stale must not demote terminal UI.
    expect(flag.textContent).toBe("● final");
    expect(sched.live().map((t) => t.id)).toEqual([armAfterTerminal]);

    // Unseen late cost on valid reconnect → re-arm.
    es.emit("snapshot", {
      costs: [cost(1, 10, "0.0010"), cost(2, 3, "0.0002")],
      run: { status: "running", outcome: null },
    });
    expect(costPerToken.textContent).toBe("$0.0012");
    expect(header.textContent).toBe("completed");
    expect(sched.timers.find((t) => t.id === armAfterTerminal)?.canceled).toBe(true);
    const armAfterReconnectCost = sched.live()[0]!.id;

    // event:costs delta once; repeat no re-arm.
    es.emit("costs", { costs: [cost(3, 1, "0.0001")] });
    expect(costPerToken.textContent).toBe("$0.0013");
    const armAfterDelta = sched.live()[0]!.id;
    expect(armAfterDelta).not.toBe(armAfterReconnectCost);
    es.emit("costs", { costs: [cost(3, 1, "0.0001")] });
    expect(costPerToken.textContent).toBe("$0.0013");
    expect(sched.live().map((t) => t.id)).toEqual([armAfterDelta]);

    // Malformed costs delta: stale, no mutation, no re-arm.
    es.emit("costs", { costs: [cost(4, 1, "not-a-number")] });
    expect(costPerToken.textContent).toBe("$0.0013");
    expect(sched.live().map((t) => t.id)).toEqual([armAfterDelta]);

    es.emit("error", {});
    es.emit("error", {});
    expect(es.closeCalls).toBe(0);
    expect(sched.live().map((t) => t.id)).toEqual([armAfterDelta]);

    sched.fire(armAfterReconnectCost);
    expect(es.closeCalls).toBe(0);

    sched.fire(armAfterDelta);
    expect(es.closeCalls).toBe(1);
    expect(es.closed).toBe(true);

    // Post-close events/errors must not close again or change accounting.
    es.emit("costs", { costs: [cost(5, 5, "0.0050")] });
    es.emit("snapshot", { costs: [cost(99)], run: { status: "running", outcome: null } });
    es.emit("error", {});
    es.emit("status", { status: "running", outcome: null });
    expect(costPerToken.textContent).toBe("$0.0013");
    expect(header.textContent).toBe("completed");
    expect(es.closeCalls).toBe(1);
  });
});
