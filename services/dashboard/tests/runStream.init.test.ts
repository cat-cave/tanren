import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskTimelineEntry } from "../src/api/http.gen.js";
import { initRunStream } from "../src/client/runStream.js";

const EMPTY_TASK_WATERMARK = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

class FakeEventSource {
  static latest: FakeEventSource | undefined;
  readonly listeners = new Map<string, Array<(event: Event) => void>>();
  closeCalls = 0;

  constructor(
    readonly url: string,
    readonly options?: EventSourceInit,
  ) {
    FakeEventSource.latest = this;
  }

  addEventListener(name: string, listener: EventListenerOrEventListenerObject): void {
    const callback = typeof listener === "function" ? listener : (event: Event) => listener.handleEvent(event);
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(callback);
    this.listeners.set(name, listeners);
  }

  close(): void {
    this.closeCalls += 1;
  }

  fire(name: string, data: unknown = undefined): void {
    const event = data === undefined ? new Event(name) : ({ data: JSON.stringify(data) } as MessageEvent<string>);
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

class FakeElement {
  className = "";
  dataset: Record<string, string> = {};
  style = { background: "", color: "", cssText: "" };
  textContent = "";
  innerHTML = "";
  tabIndex = 0;
  readonly attributes = new Map<string, string>();
  children: Array<FakeElement | string> = [];

  constructor(readonly tagName = "div") {}

  append(...nodes: Array<FakeElement | string>): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: Array<FakeElement | string>): void {
    this.children = [...nodes];
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  querySelector(selector: string): FakeElement | null {
    if (selector !== '[data-rd="spine"]') return null;
    return this.children.find((child) => child instanceof FakeElement && child.dataset["rd"] === "spine") ?? null;
  }
}

function task(overrides: Partial<TaskTimelineEntry> = {}): TaskTimelineEntry {
  return {
    taskId: "task_plan",
    runId: "run_x",
    kind: "plan",
    parentTaskId: null,
    title: "plan the run",
    status: "running",
    outcome: null,
    failureKind: null,
    attempt: 0,
    cli: "codex",
    model: "gpt-x",
    startedAt: "2026-05-01T00:00:00.000Z",
    endedAt: null,
    ...overrides,
  };
}

function harness(options: { status?: string; outcome?: string } = {}) {
  const status = options.status ?? "running";
  const terminal = ["completed", "failed", "cancelled", "halted"].includes(status);
  const flag = {
    textContent: terminal ? "● final · verifying totals" : "↻ live",
    title: "",
    removeAttribute(name: string) {
      if (name === "title") this.title = "";
    },
  };
  const spine = new FakeElement();
  spine.dataset["rd"] = "spine";
  const trajectoryBody = new FakeElement();
  trajectoryBody.append(spine);
  const root = {
    dataset: {
      streamUrl: "/runs/run_x/stream",
      runId: "run_x",
      projectId: "project_x",
      runStatus: status,
      runOutcome: options.outcome ?? "",
    },
    querySelector(selector: string) {
      if (selector === '[data-rd="live-flag"]') return flag;
      if (selector === '[data-rd="trajectory"] .rd-panel-body') return trajectoryBody;
      return null;
    },
    addEventListener() {},
  };
  vi.stubGlobal("document", { querySelector: () => root, createElement: (tag: string) => new FakeElement(tag) });
  vi.stubGlobal("EventSource", FakeEventSource);
  initRunStream();
  const source = FakeEventSource.latest;
  if (source === undefined) throw new Error("EventSource was not created");
  return { source, flag, trajectoryBody, spine };
}

function snapshot() {
  return {
    runId: "run_x",
    projectId: "project_x",
    run: {
      runId: "run_x",
      specId: "spec_x",
      projectId: "project_x",
      branch: "main",
      trigger: "test",
      status: "running",
      outcome: null,
      startedAt: "2026-05-01T00:00:00.000Z",
      endedAt: null,
      prUrl: null,
    },
    tasks: [],
    recentEvents: [],
    costs: [],
    eventCursor: "0",
    costCursor: "0",
    taskWatermark: EMPTY_TASK_WATERMARK,
  };
}

afterEach(() => {
  FakeEventSource.latest = undefined;
  vi.unstubAllGlobals();
});

describe("run stream island drain receipt", () => {
  it("keeps server-rendered terminal truth through immediate transport and malformed-frame failures", () => {
    const disconnected = harness({ status: "completed", outcome: "ok" });
    disconnected.source.fire("error");
    expect(disconnected.flag.textContent).toBe("● final · totals unverified");
    expect(disconnected.flag.title).toContain("lost the run event stream");

    const malformed = harness({ status: "failed", outcome: "failed" });
    malformed.source.fire("snapshot", { runId: "run_x", projectId: "project_x" });
    expect(malformed.flag.textContent).toBe("● final · totals unverified");
    expect(malformed.flag.title).toBe("malformed snapshot frame");
  });

  it("replaces the complete task projection from snapshots and task frames, including new tasks", () => {
    const { source, trajectoryBody, spine } = harness();
    const initial = task();
    source.fire("snapshot", {
      ...snapshot(),
      tasks: [initial],
      taskWatermark: "1".repeat(64),
    });
    let rows = trajectoryBody.children.filter(
      (child): child is FakeElement => child instanceof FakeElement && child !== spine,
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.dataset["taskProjection"]!)).toEqual(initial);

    const updated = task({ status: "done", outcome: "passed", endedAt: "2026-05-01T00:00:05.000Z" });
    const created = task({
      taskId: "task_write",
      kind: "write",
      parentTaskId: "task_plan",
      title: "build the change",
      status: "queued",
      startedAt: null,
      model: null,
    });
    source.fire("task", {
      runId: "run_x",
      projectId: "project_x",
      tasks: [updated, created],
      taskWatermark: "2".repeat(64),
    });
    rows = trajectoryBody.children.filter(
      (child): child is FakeElement => child instanceof FakeElement && child !== spine,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.dataset["rdMoment"])).toEqual(["task_plan", "task_write"]);
    expect(JSON.parse(rows[1]!.dataset["taskProjection"]!)).toEqual(created);

    const reconnected = task({ taskId: "task_audit", kind: "audit", title: "audit the result" });
    source.fire("snapshot", {
      ...snapshot(),
      tasks: [reconnected],
      taskWatermark: "3".repeat(64),
    });
    rows = trajectoryBody.children.filter(
      (child): child is FakeElement => child instanceof FakeElement && child !== spine,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dataset["rdMoment"]).toBe("task_audit");
    expect(rows.some((row) => row.dataset["rdMoment"] === "task_write")).toBe(false);
  });

  it("keeps terminal truth sticky and closes exactly once only for the matching receipt", () => {
    const { source, flag } = harness();
    source.fire("snapshot", snapshot());
    source.fire("status", {
      runId: "run_x",
      projectId: "project_x",
      status: "completed",
      outcome: "ok",
    });
    expect(flag.textContent).toBe("● final · verifying totals");

    source.fire("error");
    expect(flag.textContent).toBe("● final · totals unverified");
    source.fire("costs", {
      runId: "run_x",
      projectId: "project_x",
      costCursor: "900719925474099398765",
      costs: [
        {
          id: "900719925474099398765",
          runId: "run_x",
          taskId: "task_x",
          projectId: "project_x",
          cli: "codex",
          provider: "openai",
          model: "gpt-x",
          inputTokens: 1,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 1,
          reasoningOutputTokens: 0,
          totalTokens: 2,
          costUsd: "0.001",
          billingMode: "per_token",
          costBasis: "provider_response",
          recordedAt: "2026-05-01T00:00:01.000Z",
        },
      ],
    });
    expect(flag.textContent).toBe("● final · totals unverified");

    // A late reconnect/grace frame cannot demote terminal truth.
    source.fire("status", { runId: "run_x", projectId: "project_x", status: "running", outcome: null });
    expect(flag.textContent).toBe("● final · totals unverified");
    expect(source.closeCalls).toBe(0);

    source.fire("drained", {
      runId: "run_x",
      projectId: "project_x",
      status: "completed",
      outcome: "ok",
      eventCursor: "1",
      costCursor: "900719925474099398765",
      taskWatermark: EMPTY_TASK_WATERMARK,
    });
    expect(source.closeCalls).toBe(0);

    const receipt = {
      runId: "run_x",
      projectId: "project_x",
      status: "completed",
      outcome: "ok",
      eventCursor: "0",
      costCursor: "900719925474099398765",
      taskWatermark: EMPTY_TASK_WATERMARK,
    };
    source.fire("drained", receipt);
    source.fire("drained", receipt);
    source.fire("error");
    expect(source.closeCalls).toBe(1);
    expect(flag.textContent).toBe("● final · totals verified");
  });
});
