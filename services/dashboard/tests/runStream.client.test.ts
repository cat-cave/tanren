import { describe, expect, it } from "vitest";
import {
  acceptCosts,
  acceptDrained,
  acceptEvents,
  acceptHeartbeat,
  acceptSnapshot,
  acceptStatus,
  acceptTask,
  CostFrameParseError,
  createRunStreamMachine,
  parseCostRecord,
  parseCostRecords,
  prepareCostReset,
  renderStreamIntegrity,
} from "../src/client/runStream.js";

const RUN = "run_1";
const PROJECT = "project_1";
const TASK = "task_1";
const WATERMARK = "a".repeat(64);

function task(overrides: Record<string, unknown> = {}) {
  return {
    taskId: TASK,
    runId: RUN,
    kind: "write",
    parentTaskId: null,
    title: "write",
    status: "running",
    outcome: null,
    failureKind: null,
    attempt: 0,
    cli: "codex",
    model: "gpt-5",
    startedAt: "2026-07-14T00:00:00.000Z",
    endedAt: null,
    ...overrides,
  };
}

function cost(id = "1", overrides: Record<string, unknown> = {}) {
  return {
    id,
    runId: RUN,
    taskId: TASK,
    projectId: PROJECT,
    cli: "codex",
    provider: "openai",
    model: "gpt-5",
    inputTokens: 10,
    cachedInputTokens: 2,
    cacheCreationTokens: 0,
    outputTokens: 5,
    reasoningOutputTokens: 0,
    totalTokens: 15,
    costUsd: "0.0010",
    billingMode: "per_token",
    costBasis: "provider_response",
    recordedAt: "2026-07-14T00:00:01.000Z",
    ...overrides,
  };
}

function event(id = "1", overrides: Record<string, unknown> = {}) {
  return {
    id,
    ts: "2026-07-14T00:00:01.000Z",
    runId: RUN,
    taskId: TASK,
    specId: "spec_1",
    projectId: PROJECT,
    eventType: "writer.completed",
    payload: {},
    redactedPaths: [],
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN,
    projectId: PROJECT,
    run: {
      runId: RUN,
      specId: "spec_1",
      projectId: PROJECT,
      branch: "tanren/spec",
      trigger: "dashboard",
      status: "running",
      outcome: null,
      startedAt: "2026-07-14T00:00:00.000Z",
      endedAt: null,
      prUrl: null,
    },
    tasks: [task()],
    recentEvents: [event()],
    costs: [cost()],
    eventCursor: "1",
    costCursor: "1",
    taskWatermark: WATERMARK,
    ...overrides,
  };
}

function makeDom(status = "running", outcome = "") {
  const elements = new Map<string, Record<string, unknown>>();
  const element = (key: string, text = "") => {
    const value: Record<string, unknown> = {
      textContent: text,
      title: "",
      style: {},
      children: [] as unknown[],
      querySelector() {
        return null;
      },
      append(...children: unknown[]) {
        value["textContent"] = `${String(value["textContent"] ?? "")}${children.map(String).join("")}`;
      },
      removeAttribute(name: string) {
        if (name === "title") value["title"] = "";
      },
      replaceChildren(...children: unknown[]) {
        value["children"] = children;
      },
    };
    elements.set(key, value);
    return value;
  };
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
  ])
    element(key, key === "live-flag" ? (status === "running" ? "↻ live" : "● final · verifying totals") : "initial");
  const statusChip = elements.get("run-status")!;
  statusChip["classList"] = { remove() {}, add() {} };
  const moment = {
    classList: { toggle() {} },
    querySelector(selector: string) {
      if (selector === ".dot") return { className: "dot live", textContent: "↻" };
      if (selector === ".ph") return { className: "ph live" };
      return null;
    },
  };
  const document = {
    createElement() {
      return { className: "", textContent: "", style: {}, append() {} };
    },
  };
  const root = {
    dataset: {
      runId: RUN,
      projectId: PROJECT,
      runStatus: status,
      runOutcome: outcome,
      streamIntegrity: "verifying",
    },
    ownerDocument: document,
    querySelector(selector: string) {
      const dataMatch = /\[data-rd="([^"]+)"\]/u.exec(selector);
      if (dataMatch !== null) return elements.get(dataMatch[1] as string) ?? null;
      if (selector === `[data-rd-moment="${TASK}"]`) return moment;
      return null;
    },
  };
  return { root: root as unknown as HTMLElement, elements };
}

describe("strict snapshot and identity boundary", () => {
  it.each([{}, { costs: null }, { costs: undefined }, { run: null }])(
    "rejects incomplete snapshot %# without mutation",
    (raw) => {
      const { root, elements } = makeDom();
      const machine = createRunStreamMachine(root);
      expect(() => acceptSnapshot(machine, raw)).toThrow(Error);
      expect(machine.baselineReceived).toBe(false);
      expect(machine.totals.seenIds.size).toBe(0);
      expect(elements.get("cost-per-token")?.["textContent"]).toBe("initial");
    },
  );

  it("validates a mixed frame before changing status, cursors, DOM, or accounting", () => {
    const { root, elements } = makeDom();
    const machine = createRunStreamMachine(root);
    acceptSnapshot(machine, snapshot());
    const before = {
      status: machine.status,
      cursor: machine.costCursor,
      tokens: machine.totals.totalTokens,
      costText: elements.get("cost-per-token")?.["textContent"],
    };
    const malformed = snapshot({
      run: { ...(snapshot().run as object), status: "completed", outcome: "ok" },
      costs: [cost("1"), { ...cost("2"), totalTokens: Number.MAX_SAFE_INTEGER + 1 }],
      costCursor: "2",
    });
    expect(() => acceptSnapshot(machine, malformed)).toThrow(Error);
    expect({
      status: machine.status,
      cursor: machine.costCursor,
      tokens: machine.totals.totalTokens,
      costText: elements.get("cost-per-token")?.["textContent"],
    }).toEqual(before);
  });

  it.each([
    { runId: "other" },
    { projectId: "other" },
    { run: { ...(snapshot().run as object), runId: "other" } },
    { tasks: [task({ runId: "other" })] },
    { recentEvents: [event("1", { projectId: "other" })] },
    { costs: [cost("1", { taskId: "unknown" })] },
    { run: { ...(snapshot().run as object), status: "done" } },
    { run: { ...(snapshot().run as object), outcome: "success" } },
  ])("rejects wrong identity or vocabulary %#", (override) => {
    const machine = createRunStreamMachine(makeDom().root);
    expect(() => acceptSnapshot(machine, snapshot(override))).toThrow(Error);
    expect(machine.baselineReceived).toBe(false);
  });

  it("forbids every delta and drained receipt before a baseline", () => {
    const machine = createRunStreamMachine(makeDom().root);
    const calls = [
      () => acceptStatus(machine, { runId: RUN, projectId: PROJECT, status: "running", outcome: null }),
      () => acceptTask(machine, { runId: RUN, projectId: PROJECT, task: task(), taskWatermark: WATERMARK }),
      () => acceptEvents(machine, { runId: RUN, projectId: PROJECT, events: [], eventCursor: "0" }),
      () => acceptCosts(machine, { runId: RUN, projectId: PROJECT, costs: [], costCursor: "0" }),
      () => acceptHeartbeat(machine, { runId: RUN, projectId: PROJECT, ts: "2026-07-14T00:00:00.000Z" }),
      () =>
        acceptDrained(machine, {
          runId: RUN,
          projectId: PROJECT,
          status: "completed",
          outcome: "ok",
          eventCursor: "0",
          costCursor: "0",
          taskWatermark: WATERMARK,
        }),
    ];
    for (const call of calls) expect(call).toThrow(/baseline/u);
  });
});

describe("exact transactional accounting", () => {
  it("rejects unsafe ids/tokens, sub-micro values, and decimal overflow", () => {
    expect(() => parseCostRecord(cost(Number.MAX_SAFE_INTEGER as unknown as string))).toThrow(CostFrameParseError);
    expect(() => parseCostRecord(cost("01"))).toThrow(CostFrameParseError);
    expect(() => parseCostRecord(cost("1", { inputTokens: Number.MAX_SAFE_INTEGER + 1 }))).toThrow(CostFrameParseError);
    expect(() => parseCostRecord(cost("1", { costUsd: "0.0000001" }))).toThrow(CostFrameParseError);
    expect(() => parseCostRecord(cost("1", { costUsd: "9007199255" }))).toThrow(/range/u);
  });

  it("sums exact decimals and rejects aggregate token overflow atomically", () => {
    const exact = parseCostRecords([cost("1", { costUsd: "0.1" }), cost("2", { costUsd: "0.2" })]);
    expect(exact.map((row) => row.microUsd)).toEqual([100_000n, 200_000n]);
    expect(exact.reduce((sum, row) => sum + row.microUsd, 0n)).toBe(300_000n);
    const machine = createRunStreamMachine(makeDom().root);
    const rows = parseCostRecords([
      cost("1", { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, totalTokens: Number.MAX_SAFE_INTEGER }),
      cost("2", { inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
    ]);
    expect(() => prepareCostReset(machine.totals, rows)).toThrow(/aggregate/u);
    expect(machine.totals.seenIds.size).toBe(0);
  });

  it("treats exact replay as a no-op and rejects a conflicting id collision", () => {
    const machine = createRunStreamMachine(makeDom().root);
    acceptSnapshot(machine, snapshot());
    acceptCosts(machine, { runId: RUN, projectId: PROJECT, costs: [cost("1")], costCursor: "1" });
    expect(machine.totals.totalTokens).toBe(15);
    expect(() =>
      acceptCosts(machine, {
        runId: RUN,
        projectId: PROJECT,
        costs: [cost("1", { inputTokens: 99 })],
        costCursor: "2",
      }),
    ).toThrow(/collided/u);
    expect(machine.totals.totalTokens).toBe(15);
    expect(machine.costCursor).toBe("1");
  });
});

describe("terminal truth and protocol-derived drain", () => {
  it("accepts terminal → late cost → matching drained and updates every derivative", () => {
    const { root, elements } = makeDom();
    const machine = createRunStreamMachine(root);
    acceptSnapshot(machine, snapshot());
    acceptStatus(machine, { runId: RUN, projectId: PROJECT, status: "completed", outcome: "ok" });
    acceptCosts(machine, {
      runId: RUN,
      projectId: PROJECT,
      costs: [cost("2", { costUsd: "0.0020" })],
      costCursor: "2",
    });
    expect(machine.totals.perTokenMicros).toBe(3_000n);
    expect(elements.get("cost-per-token")?.["textContent"]).toBe("$0.0030");
    expect(elements.get("cost-token-foot")?.["textContent"]).toBe("cached 4 · total 30");
    expect(elements.get("cost-models")?.["children"]).toHaveLength(1);
    acceptDrained(machine, {
      runId: RUN,
      projectId: PROJECT,
      status: "completed",
      outcome: "ok",
      eventCursor: "1",
      costCursor: "2",
      taskWatermark: WATERMARK,
    });
    expect(root.dataset["streamIntegrity"]).toBe("verified");
    expect(elements.get("live-flag")?.["textContent"]).toBe("● final · totals verified");
  });

  it("keeps malformed late data and bad drain receipts visibly unverified", () => {
    const { root, elements } = makeDom();
    const machine = createRunStreamMachine(root);
    acceptSnapshot(machine, snapshot());
    acceptStatus(machine, { runId: RUN, projectId: PROJECT, status: "completed", outcome: "ok" });
    expect(() => acceptCosts(machine, { runId: RUN, projectId: PROJECT, costs: null, costCursor: "1" })).toThrow(Error);
    renderStreamIntegrity(machine, "stale", "bad late cost");
    expect(elements.get("live-flag")?.["textContent"]).toBe("● final · totals unverified");
    expect(() =>
      acceptDrained(machine, {
        runId: "other",
        projectId: PROJECT,
        status: "completed",
        outcome: "ok",
        eventCursor: "1",
        costCursor: "1",
        taskWatermark: WATERMARK,
      }),
    ).toThrow(/identity/u);
    expect(machine.terminal).toBe(true);
  });

  it("initializes finality from SSR and rejects a reconnect demotion", () => {
    const { root, elements } = makeDom("completed", "ok");
    const machine = createRunStreamMachine(root);
    renderStreamIntegrity(machine, "verifying");
    expect(machine.terminal).toBe(true);
    expect(elements.get("live-flag")?.["textContent"]).toBe("● final · verifying totals");
    expect(() => acceptSnapshot(machine, snapshot())).toThrow(/demote/u);
  });
});
