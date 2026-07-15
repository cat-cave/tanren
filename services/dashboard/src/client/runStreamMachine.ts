import {
  RunOutcomeWire,
  RunStatusWire,
  SseCostsFrameWire,
  SseDrainedFrameWire,
  SseEventsFrameWire,
  SseHeartbeatFrameWire,
  SseSnapshotFrameWire,
  SseStatusFrameWire,
  SseTaskFrameWire,
  type SseCostsFrameWire as CostsFrame,
  type SseDrainedFrameWire as DrainedFrame,
  type SseEventsFrameWire as EventsFrame,
  type SseSnapshotFrameWire as SnapshotFrame,
  type SseStatusFrameWire as StatusFrame,
  type SseTaskFrameWire as TaskFrame,
} from "../api/runDetailSchemas.js";
import {
  commitTotals,
  emptyTotals,
  parseCostRecords,
  prepareCostAppend,
  prepareCostReset,
  renderCostBar,
  type CostTotalsState,
} from "./runStreamCosts.js";

export type StreamIntegrity = "verifying" | "live" | "stale" | "unavailable" | "verified";

export interface RunStreamMachine {
  readonly root: HTMLElement;
  readonly totals: CostTotalsState;
  readonly expectedRunId: string;
  readonly expectedProjectId: string;
  baselineReceived: boolean;
  eventCursor: string;
  costCursor: string;
  taskWatermark: string;
  knownTaskIds: Set<string>;
  status: StatusFrame["status"];
  outcome: StatusFrame["outcome"];
  terminal: boolean;
  closed: boolean;
}

const TERMINAL = new Set<StatusFrame["status"]>(["completed", "failed", "halted", "cancelled"]);

export function isTerminalRunStatus(status: string): boolean {
  return RunStatusWire.safeParse(status).success && TERMINAL.has(status as StatusFrame["status"]);
}

function requiredDataset(root: HTMLElement, name: "runId" | "projectId" | "runStatus"): string {
  const value = root.dataset[name];
  if (value === undefined || value === "") throw new Error(`run stream root is missing data-${name}`);
  return value;
}

export function createRunStreamMachine(root: HTMLElement): RunStreamMachine {
  const status = RunStatusWire.parse(requiredDataset(root, "runStatus"));
  const rawOutcome = root.dataset["runOutcome"] ?? "";
  const outcome = RunOutcomeWire.parse(rawOutcome === "" ? null : rawOutcome);
  const terminal = TERMINAL.has(status);
  root.dataset["runTerminal"] = terminal ? "true" : "false";
  root.dataset["streamIntegrity"] = root.dataset["streamIntegrity"] ?? "verifying";
  root.dataset["baselineReceived"] = "false";
  return {
    root,
    totals: emptyTotals(),
    expectedRunId: requiredDataset(root, "runId"),
    expectedProjectId: requiredDataset(root, "projectId"),
    baselineReceived: false,
    eventCursor: "0",
    costCursor: "0",
    taskWatermark: "",
    knownTaskIds: new Set(),
    status,
    outcome,
    terminal,
    closed: false,
  };
}

function assertIdentity(machine: RunStreamMachine, frame: { runId: string; projectId: string }): void {
  if (frame.runId !== machine.expectedRunId || frame.projectId !== machine.expectedProjectId) {
    throw new Error("run stream frame identity does not match the SSR surface");
  }
}

function assertCursorAtLeast(cursor: string, floor: string, label: string): void {
  if (BigInt(cursor) < BigInt(floor)) throw new Error(`${label} regressed`);
}

function assertRowsAtOrBelow(rows: ReadonlyArray<{ id: string }>, cursor: string, label: string): void {
  const limit = BigInt(cursor);
  if (rows.some((row) => BigInt(row.id) > limit)) throw new Error(`${label} does not cover its rows`);
}

function assertSnapshotIdentity(machine: RunStreamMachine, frame: SnapshotFrame): void {
  assertIdentity(machine, frame);
  if (frame.run.runId !== machine.expectedRunId || frame.run.projectId !== machine.expectedProjectId) {
    throw new Error("snapshot run identity mismatch");
  }
  const taskIds = new Set(frame.tasks.map((task) => task.taskId));
  if (frame.tasks.some((task) => task.runId !== machine.expectedRunId)) throw new Error("snapshot task run mismatch");
  if (
    frame.recentEvents.some(
      (event) => event.runId !== machine.expectedRunId || event.projectId !== machine.expectedProjectId,
    )
  ) {
    throw new Error("snapshot event identity mismatch");
  }
  if (
    frame.costs.some(
      (cost) =>
        cost.runId !== machine.expectedRunId ||
        cost.projectId !== machine.expectedProjectId ||
        !taskIds.has(cost.taskId),
    )
  ) {
    throw new Error("snapshot cost identity mismatch");
  }
  assertRowsAtOrBelow(frame.recentEvents, frame.eventCursor, "snapshot event cursor");
  assertRowsAtOrBelow(frame.costs, frame.costCursor, "snapshot cost cursor");
  if (machine.baselineReceived) {
    assertCursorAtLeast(frame.eventCursor, machine.eventCursor, "snapshot event cursor");
    assertCursorAtLeast(frame.costCursor, machine.costCursor, "snapshot cost cursor");
  }
  if (
    machine.terminal &&
    (!TERMINAL.has(frame.run.status) || frame.run.status !== machine.status || frame.run.outcome !== machine.outcome)
  ) {
    throw new Error("snapshot attempted to demote terminal workflow truth");
  }
}

function setText(root: HTMLElement, key: string, value: string): void {
  const element = root.querySelector<HTMLElement>(`[data-rd="${key}"]`);
  if (element !== null) element.textContent = value;
}

function renderStatus(machine: RunStreamMachine, status: StatusFrame["status"], outcome: StatusFrame["outcome"]): void {
  const chip = machine.root.querySelector<HTMLElement>('[data-rd="run-status"]');
  if (chip !== null) {
    chip.classList.remove("ok", "warn", "bad");
    chip.classList.add(status === "completed" ? "ok" : TERMINAL.has(status) ? "bad" : "warn");
    const dot = chip.querySelector(".d");
    chip.textContent = "";
    if (dot !== null) chip.append(dot);
    chip.append(`run · ${status}${outcome === null ? "" : ` · ${outcome}`}`);
  }
  setText(machine.root, "header-status", status);
}

function renderTask(machine: RunStreamMachine, task: TaskFrame["task"]): void {
  const row = machine.root.querySelector<HTMLElement>(`[data-rd-moment="${task.taskId}"]`);
  if (row === null) return;
  const failed =
    task.status === "failed" ||
    ["failed", "rejected_by_checker", "rejected_by_auditor", "crashed", "timed_out"].includes(task.outcome ?? "");
  const state = failed
    ? "failed"
    : task.status === "running" || task.status === "claimed"
      ? "live"
      : task.status === "queued"
        ? "queued"
        : "done";
  const dot = row.querySelector<HTMLElement>(".dot");
  if (dot !== null) {
    dot.className = `dot ${state}`;
    dot.textContent = state === "done" ? "✓" : state === "live" ? "↻" : state === "failed" ? "×" : "";
  }
  const phase = row.querySelector<HTMLElement>(".ph");
  if (phase !== null) phase.className = `ph ${state}`;
  row.classList.toggle("queued", state === "queued");
}

export function renderStreamIntegrity(machine: RunStreamMachine, integrity: StreamIntegrity, reason?: string): void {
  machine.root.dataset["streamIntegrity"] = integrity;
  const flag = machine.root.querySelector<HTMLElement>('[data-rd="live-flag"]');
  if (flag === null) return;
  if (machine.terminal) {
    flag.textContent =
      integrity === "verified"
        ? "● final · totals verified"
        : integrity === "stale" || integrity === "unavailable"
          ? "● final · totals unverified"
          : "● final · verifying totals";
  } else {
    flag.textContent =
      integrity === "stale" ? "⚠ stream stale" : integrity === "unavailable" ? "⚠ stream unavailable" : "↻ live";
  }
  if (reason === undefined) flag.removeAttribute("title");
  else flag.title = reason;
}

function commitStatus(machine: RunStreamMachine, status: StatusFrame["status"], outcome: StatusFrame["outcome"]): void {
  if (machine.terminal && (!TERMINAL.has(status) || status !== machine.status || outcome !== machine.outcome)) {
    throw new Error("stream attempted to rewrite terminal workflow truth");
  }
  machine.status = status;
  machine.outcome = outcome;
  machine.terminal = TERMINAL.has(status);
  machine.root.dataset["runStatus"] = status;
  machine.root.dataset["runOutcome"] = outcome ?? "";
  machine.root.dataset["runTerminal"] = machine.terminal ? "true" : "false";
  renderStatus(machine, status, outcome);
}

export function acceptSnapshot(machine: RunStreamMachine, raw: unknown): void {
  if (machine.closed) return;
  const frame = SseSnapshotFrameWire.parse(raw);
  assertSnapshotIdentity(machine, frame);
  const costs = parseCostRecords(frame.costs);
  const nextTotals = prepareCostReset(machine.totals, costs);
  commitTotals(machine.totals, nextTotals);
  machine.knownTaskIds = new Set(frame.tasks.map((task) => task.taskId));
  machine.eventCursor = frame.eventCursor;
  machine.costCursor = frame.costCursor;
  machine.taskWatermark = frame.taskWatermark;
  machine.baselineReceived = true;
  machine.root.dataset["baselineReceived"] = "true";
  commitStatus(machine, frame.run.status, frame.run.outcome);
  for (const task of frame.tasks) renderTask(machine, task);
  renderCostBar(machine.root, machine.totals);
  renderStreamIntegrity(machine, machine.terminal ? "verifying" : "live");
}

function requireBaseline(machine: RunStreamMachine): void {
  if (!machine.baselineReceived) throw new Error("run stream delta arrived before a valid snapshot baseline");
}

export function acceptStatus(machine: RunStreamMachine, raw: unknown): void {
  if (machine.closed) return;
  requireBaseline(machine);
  const frame = SseStatusFrameWire.parse(raw);
  assertIdentity(machine, frame);
  commitStatus(machine, frame.status, frame.outcome);
  renderStreamIntegrity(machine, machine.terminal ? "verifying" : "live");
}

export function acceptTask(machine: RunStreamMachine, raw: unknown): void {
  if (machine.closed) return;
  requireBaseline(machine);
  const frame = SseTaskFrameWire.parse(raw);
  assertIdentity(machine, frame);
  if (frame.task.runId !== machine.expectedRunId) throw new Error("task frame run mismatch");
  machine.knownTaskIds.add(frame.task.taskId);
  machine.taskWatermark = frame.taskWatermark;
  renderTask(machine, frame.task);
}

export function acceptEvents(machine: RunStreamMachine, raw: unknown): void {
  if (machine.closed) return;
  requireBaseline(machine);
  const frame: EventsFrame = SseEventsFrameWire.parse(raw);
  assertIdentity(machine, frame);
  if (
    frame.events.some((event) => event.runId !== machine.expectedRunId || event.projectId !== machine.expectedProjectId)
  ) {
    throw new Error("events frame identity mismatch");
  }
  assertCursorAtLeast(frame.eventCursor, machine.eventCursor, "event cursor");
  assertRowsAtOrBelow(frame.events, frame.eventCursor, "event cursor");
  machine.eventCursor = frame.eventCursor;
}

export function acceptCosts(machine: RunStreamMachine, raw: unknown): void {
  if (machine.closed) return;
  requireBaseline(machine);
  const frame: CostsFrame = SseCostsFrameWire.parse(raw);
  assertIdentity(machine, frame);
  if (
    frame.costs.some(
      (cost) =>
        cost.runId !== machine.expectedRunId ||
        cost.projectId !== machine.expectedProjectId ||
        !machine.knownTaskIds.has(cost.taskId),
    )
  ) {
    throw new Error("costs frame identity mismatch");
  }
  assertCursorAtLeast(frame.costCursor, machine.costCursor, "cost cursor");
  assertRowsAtOrBelow(frame.costs, frame.costCursor, "cost cursor");
  const { next } = prepareCostAppend(machine.totals, parseCostRecords(frame.costs));
  commitTotals(machine.totals, next);
  machine.costCursor = frame.costCursor;
  renderCostBar(machine.root, machine.totals);
}

export function acceptHeartbeat(machine: RunStreamMachine, raw: unknown): void {
  if (machine.closed) return;
  requireBaseline(machine);
  const frame = SseHeartbeatFrameWire.parse(raw);
  assertIdentity(machine, frame);
}

export function acceptDrained(machine: RunStreamMachine, raw: unknown): DrainedFrame {
  if (machine.closed) throw new Error("run stream is already closed");
  requireBaseline(machine);
  const frame = SseDrainedFrameWire.parse(raw);
  assertIdentity(machine, frame);
  if (!machine.terminal || !TERMINAL.has(frame.status))
    throw new Error("drained frame requires terminal workflow truth");
  if (frame.status !== machine.status || frame.outcome !== machine.outcome) throw new Error("drained status mismatch");
  if (
    frame.eventCursor !== machine.eventCursor ||
    frame.costCursor !== machine.costCursor ||
    frame.taskWatermark !== machine.taskWatermark
  ) {
    throw new Error("drained receipt does not match observed cursors");
  }
  renderStreamIntegrity(machine, "verified");
  return frame;
}
