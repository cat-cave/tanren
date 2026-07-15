import { afterEach, describe, expect, it } from "vitest";
import { initRunStream } from "../src/client/runStream.js";

const RUN = "run_1";
const PROJECT = "project_1";
const TASK = "task_1";
const WATERMARK = "b".repeat(64);
type Listener = (event: { data?: string }) => void;

class ReconnectingEventSource {
  static instances: ReconnectingEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly url: string;
  readyState = ReconnectingEventSource.OPEN;
  closeCalls = 0;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    ReconnectingEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener as Listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data: unknown): void {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    for (const listener of this.listeners.get(type) ?? []) listener({ data: payload });
  }

  disconnect(): void {
    this.readyState = ReconnectingEventSource.CONNECTING;
    this.emit("error", "network outage");
  }

  reconnect(): void {
    this.readyState = ReconnectingEventSource.OPEN;
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = ReconnectingEventSource.CLOSED;
  }
}

function task() {
  return {
    taskId: TASK,
    runId: RUN,
    kind: "write",
    parentTaskId: null,
    title: "write",
    status: "done",
    outcome: "passed",
    failureKind: null,
    attempt: 0,
    cli: "codex",
    model: "gpt-5",
    startedAt: "2026-07-14T00:00:00.000Z",
    endedAt: "2026-07-14T00:00:01.000Z",
  };
}

function cost(id: string, usd: string) {
  return {
    id,
    runId: RUN,
    taskId: TASK,
    projectId: PROJECT,
    cli: "codex",
    provider: "openai",
    model: "gpt-5",
    inputTokens: 10,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 5,
    reasoningOutputTokens: 0,
    totalTokens: 15,
    costUsd: usd,
    billingMode: "per_token",
    costBasis: "provider_response",
    recordedAt: `2026-07-14T00:00:0${id}.000Z`,
  };
}

function snapshot(status: "running" | "completed", outcome: null | "ok", costs = [cost("1", "0.0010")]) {
  return {
    runId: RUN,
    projectId: PROJECT,
    run: {
      runId: RUN,
      specId: "spec_1",
      projectId: PROJECT,
      branch: "tanren/spec",
      trigger: "dashboard",
      status,
      outcome,
      startedAt: "2026-07-14T00:00:00.000Z",
      endedAt: status === "completed" ? "2026-07-14T00:00:02.000Z" : null,
      prUrl: null,
    },
    tasks: [task()],
    recentEvents: [],
    costs,
    eventCursor: "0",
    costCursor: costs.at(-1)?.id ?? "0",
    taskWatermark: WATERMARK,
  };
}

function makeDom() {
  const elements = new Map<string, Record<string, unknown>>();
  for (const key of [
    "live-flag",
    "run-status",
    "header-status",
    "cost-per-token",
    "cost-per-token-tokens",
    "cost-subscription-tokens",
    "cost-tokens",
    "cost-token-foot",
    "cost-per-token-bar",
    "cost-input-bar",
    "cost-output-bar",
    "cost-sources",
    "cost-models",
  ]) {
    elements.set(key, {
      textContent: key === "live-flag" ? "↻ live" : "",
      title: "",
      style: {},
      classList: { remove() {}, add() {} },
      querySelector() {
        return null;
      },
      append() {},
      removeAttribute() {},
      replaceChildren() {},
    });
  }
  const document = {
    createElement() {
      return { className: "", textContent: "", style: {}, append() {} };
    },
    querySelector() {
      return root;
    },
  };
  const root = {
    dataset: {
      streamUrl: "/runs/run_1/stream?orgId=org_1&projectId=project_1",
      runId: RUN,
      projectId: PROJECT,
      runStatus: "running",
      runOutcome: "",
      streamIntegrity: "verifying",
    },
    ownerDocument: document,
    querySelector(selector: string) {
      const match = /\[data-rd="([^"]+)"\]/u.exec(selector);
      return match === null ? null : (elements.get(match[1] as string) ?? null);
    },
    addEventListener() {},
  };
  return { document: document as unknown as Document, elements };
}

afterEach(() => {
  ReconnectingEventSource.instances = [];
});

describe("initRunStream exact reconnect lifecycle", () => {
  it("waits through a delayed post-terminal reconnect and closes exactly once on a matching drain", () => {
    const { document, elements } = makeDom();
    initRunStream({ document, EventSourceCtor: ReconnectingEventSource as unknown as typeof EventSource });
    const source = ReconnectingEventSource.instances[0];
    expect(source).toBeDefined();
    source!.emit("snapshot", snapshot("running", null));
    source!.emit("status", { runId: RUN, projectId: PROJECT, status: "completed", outcome: "ok" });
    expect(elements.get("live-flag")?.["textContent"]).toBe("● final · verifying totals");

    source!.disconnect();
    expect(source!.readyState).toBe(ReconnectingEventSource.CONNECTING);
    expect(source!.closeCalls).toBe(0);
    // A logical delay far beyond the deleted 2.5s heuristic changes nothing.
    const elapsedOutageMs = 30_000;
    expect(elapsedOutageMs).toBeGreaterThan(2_500);
    expect(source!.closeCalls).toBe(0);

    source!.reconnect();
    source!.emit("snapshot", snapshot("completed", "ok"));
    source!.emit("costs", { runId: RUN, projectId: PROJECT, costs: [cost("2", "0.0020")], costCursor: "2" });
    source!.emit("drained", {
      runId: RUN,
      projectId: PROJECT,
      status: "completed",
      outcome: "ok",
      eventCursor: "0",
      costCursor: "2",
      taskWatermark: WATERMARK,
    });
    expect(elements.get("cost-per-token")?.["textContent"]).toBe("$0.0030");
    expect(elements.get("live-flag")?.["textContent"]).toBe("● final · totals verified");
    expect(source!.closeCalls).toBe(1);
    source!.emit("drained", {
      runId: RUN,
      projectId: PROJECT,
      status: "completed",
      outcome: "ok",
      eventCursor: "0",
      costCursor: "2",
      taskWatermark: WATERMARK,
    });
    source!.emit("error", "late error");
    expect(source!.closeCalls).toBe(1);
  });

  it("keeps malformed drained and post-terminal cost frames observable and eligible for reconnection", () => {
    const { document, elements } = makeDom();
    initRunStream({ document, EventSourceCtor: ReconnectingEventSource as unknown as typeof EventSource });
    const source = ReconnectingEventSource.instances[0]!;
    source.emit("snapshot", snapshot("completed", "ok"));
    source.emit("costs", { runId: RUN, projectId: PROJECT, costs: [{ bad: true }], costCursor: "2" });
    expect(elements.get("live-flag")?.["textContent"]).toBe("● final · totals unverified");
    source.emit("drained", {
      runId: "other",
      projectId: PROJECT,
      status: "completed",
      outcome: "ok",
      eventCursor: "0",
      costCursor: "1",
      taskWatermark: WATERMARK,
    });
    expect(source.closeCalls).toBe(0);
    source.disconnect();
    expect(source.readyState).toBe(ReconnectingEventSource.CONNECTING);
  });
});
