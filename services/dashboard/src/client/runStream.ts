/**
 * Run-detail live-update island. Subscribes to the run's SSE feed
 * (the dashboard same-origin proxy → orchestrator `/stream`) and
 * patches the cost bar, trajectory spine, run status, and per-moment events in
 * place — no page reload, no client router.
 *
 * The server renders the full initial view; this island only reconciles the
 * deltas the SSE frames carry. Frame contract (`SseEventName`):
 *   - `snapshot` { run, tasks, recentEvents, costs }  (initial, full)
 *   - `status`   { runId, status, outcome }
 *   - `task`     { tasks, taskWatermark }              (full task projection)
 *   - `events`   { events: [...] }                     (new event rows)
 *   - `costs`    { costs: [...] }                       (new cost records)
 *   - `heartbeat`{ ts }
 *
 * It never invents data — it only writes values carried by the frames into the
 * `data-rd="..."` hooks the server emitted. Trajectory-row selection (click)
 * is wired here too so the reasoning pane swaps without a round-trip is left to
 * a full navigation in v0; clicking a moment reloads with `?moment=` so the
 * server re-renders the pane (keeps the reasoning derivation server-side and
 * contract-typed).
 */

import { RunStreamProtocol, type CostRecordFrame, type TaskFrame } from "./runStreamProtocol.js";

interface BillingAgg {
  tokens: number;
  usd: number;
}

interface CostTotalsState {
  perTokenUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  bySource: Map<CostRecordFrame["billingMode"], BillingAgg>;
}

const COST_SOURCE_VAR: Record<CostRecordFrame["billingMode"], string> = {
  per_token: "var(--cost-token)",
  subscription: "var(--cost-window)",
  self_hosted: "var(--cost-opportunity)",
  // BUDGET-SAFETY C1: an unrecognized credential ref (a misconfig) — distinct color.
  unattributed: "var(--cost-unattributed, var(--status-fail))",
};
const COST_SOURCE_LABEL: Record<CostRecordFrame["billingMode"], string> = {
  per_token: "per-token",
  subscription: "window",
  self_hosted: "self-hosted",
  unattributed: "unattributed",
};

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}
function formatUsd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

function emptyTotals(): CostTotalsState {
  return {
    perTokenUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    bySource: new Map(),
  };
}

function cloneTotals(totals: CostTotalsState): CostTotalsState {
  return { ...totals, bySource: new Map(totals.bySource) };
}

function applyCost(totals: CostTotalsState, cost: CostRecordFrame): void {
  const usd = cost.costUsd === null ? 0 : Number.parseFloat(cost.costUsd);
  const usdSafe = Number.isFinite(usd) ? usd : 0;
  totals.inputTokens += cost.inputTokens;
  totals.outputTokens += cost.outputTokens;
  totals.cachedInputTokens += cost.cachedInputTokens;
  totals.totalTokens += cost.totalTokens;
  if (cost.billingMode === "per_token") totals.perTokenUsd += usdSafe;
  const src = totals.bySource.get(cost.billingMode) ?? { tokens: 0, usd: 0 };
  src.tokens += cost.totalTokens;
  src.usd += usdSafe;
  totals.bySource.set(cost.billingMode, src);
}

function setText(root: HTMLElement, key: string, text: string): void {
  const el = root.querySelector<HTMLElement>(`[data-rd="${key}"]`);
  if (el !== null) el.textContent = text;
}

function renderCostBar(root: HTMLElement, totals: CostTotalsState): void {
  setText(root, "cost-per-token", formatUsd(totals.perTokenUsd));
  setText(root, "cost-tokens", `${formatTokens(totals.inputTokens)} / ${formatTokens(totals.outputTokens)}`);
  const sources = root.querySelector<HTMLElement>('[data-rd="cost-sources"]');
  if (sources !== null) {
    sources.innerHTML = "";
    for (const [mode, agg] of totals.bySource) {
      const row = document.createElement("div");
      row.className = "source-row";
      const sw = document.createElement("span");
      sw.className = "sw";
      sw.style.background = COST_SOURCE_VAR[mode];
      const label = document.createElement("span");
      label.textContent = COST_SOURCE_LABEL[mode];
      const amt = document.createElement("span");
      amt.className = "amt";
      amt.textContent = `${formatTokens(agg.tokens)} tok${agg.usd > 0 ? ` · ${formatUsd(agg.usd)}` : ""}`;
      row.append(sw, label, amt);
      sources.append(row);
    }
  }
}

function applyStatus(root: HTMLElement, status: string, outcome: string | null): void {
  const chip = root.querySelector<HTMLElement>('[data-rd="run-status"]');
  if (chip !== null) {
    chip.classList.remove("ok", "warn", "bad");
    chip.classList.add(
      status === "completed" ? "ok" : ["failed", "halted", "cancelled"].includes(status) ? "bad" : "warn",
    );
    const dot = chip.querySelector(".d");
    chip.textContent = "";
    if (dot !== null) chip.append(dot);
    chip.append(`run · ${status}${outcome === null ? "" : ` · ${outcome}`}`);
  }
  setText(root, "header-status", status);
  if (isTerminalRunStatus(status)) {
    const flag = root.querySelector<HTMLElement>('[data-rd="live-flag"]');
    if (flag !== null) flag.textContent = "● final · verifying totals";
  }
}

function isTerminalRunStatus(status: string): boolean {
  return ["completed", "failed", "halted", "cancelled", "done"].includes(status);
}

function parseMessageData(event: Event): unknown {
  return JSON.parse((event as MessageEvent<string>).data);
}

export function isFinalStreamState(root: HTMLElement): boolean {
  const flag = root.querySelector<HTMLElement>('[data-rd="live-flag"]');
  return flag?.textContent?.startsWith("● final") === true;
}

export function markStreamUnavailableUnlessFinal(root: HTMLElement, reason: string): void {
  if (isFinalStreamState(root)) {
    const flag = root.querySelector<HTMLElement>('[data-rd="live-flag"]');
    if (flag !== null) {
      flag.textContent = "● final · totals unverified";
      flag.title = reason;
    }
    return;
  }
  setStreamState(root, "unavailable", reason);
}

export function setStreamState(root: HTMLElement, state: "live" | "stale" | "unavailable", reason?: string): void {
  const flag = root.querySelector<HTMLElement>('[data-rd="live-flag"]');
  if (flag === null) return;
  if (state === "live") {
    if (isFinalStreamState(root)) return;
    flag.textContent = "↻ live";
    flag.removeAttribute("title");
    return;
  }
  flag.textContent = state === "stale" ? "⚠ stream stale" : "⚠ stream unavailable";
  if (reason !== undefined) flag.title = reason;
}

type StreamTask = TaskFrame["tasks"][number];

function streamTaskState(task: StreamTask): "done" | "live" | "queued" | "failed" {
  let state: "done" | "live" | "queued" | "failed" = "done";
  if (task.status === "running" || task.status === "claimed") state = "live";
  else if (task.status === "queued") state = "queued";
  else if (
    task.status === "failed" ||
    task.outcome === "rejected_by_checker" ||
    task.outcome === "rejected_by_auditor" ||
    task.outcome === "crashed" ||
    task.outcome === "timed_out"
  )
    state = "failed";
  return state;
}

function taskDuration(task: StreamTask): string {
  if (task.startedAt === null) return "";
  const start = Date.parse(task.startedAt);
  const end = task.endedAt === null ? Date.now() : Date.parse(task.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
  const seconds = Math.round((end - start) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Replace the complete accepted task projection, including newly-created rows. */
export function applyTasks(root: HTMLElement, tasks: StreamTask[]): void {
  const body = root.querySelector<HTMLElement>('[data-rd="trajectory"] .rd-panel-body');
  if (body === null) return;
  const spine = body.querySelector<HTMLElement>('[data-rd="spine"]');
  body.replaceChildren();
  if (spine !== null) body.append(spine);
  const sorted = [...tasks].sort((left, right) => {
    if (left.startedAt === null) return right.startedAt === null ? 0 : 1;
    if (right.startedAt === null) return -1;
    return Date.parse(left.startedAt) - Date.parse(right.startedAt);
  });
  let writeIndex = 0;
  let completed = 0;
  let livePosition = -1;
  for (const [index, task] of sorted.entries()) {
    const state = streamTaskState(task);
    if (state === "done" || state === "failed") completed += 1;
    if (state === "live" && livePosition < 0) livePosition = index + 1;
    if (task.kind === "write") writeIndex += 1;
    const phase = task.kind === "write" ? `write subtask ${writeIndex}` : task.kind;
    const row = document.createElement("div");
    row.className = `traj-row${state === "queued" ? " queued" : ""}`;
    row.dataset["rdMoment"] = task.taskId;
    row.dataset["rdIndex"] = String(index);
    // Every watermark field is represented on the accepted DOM projection;
    // reconnects cannot silently preserve stale task metadata.
    row.dataset["taskProjection"] = JSON.stringify(task);
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    const dot = document.createElement("span");
    dot.className = `dot ${state}`;
    dot.textContent = state === "done" ? "✓" : state === "live" ? "↻" : state === "failed" ? "×" : "";
    const cell = document.createElement("div");
    cell.className = "body-cell";
    const phaseNode = document.createElement("div");
    phaseNode.className = `ph ${state}`;
    const duration = taskDuration(task);
    phaseNode.textContent = `${phase}${duration === "" ? "" : ` · ${duration}`} · attempt ${task.attempt + 1}`;
    const title = document.createElement("div");
    title.className = "t";
    title.textContent = task.title === "" ? phase : task.title;
    const detail = document.createElement("div");
    detail.className = "io";
    detail.textContent = `${task.cli}${task.model === null ? "" : ` · ${task.model}`}${task.outcome === null ? "" : ` · ${task.outcome}`}`;
    cell.append(phaseNode, title, detail);
    if (task.failureKind !== null) {
      const failure = document.createElement("div");
      failure.className = "io";
      failure.style.color = "var(--status-fail)";
      failure.textContent = task.failureKind;
      cell.append(failure);
    }
    row.append(dot, cell);
    body.append(row);
  }
  if (sorted.length === 0) {
    const empty = document.createElement("div");
    empty.dataset["rdTasksEmpty"] = "true";
    empty.style.cssText = "padding:14px;font-size:12px;color:var(--fg-3)";
    empty.textContent = "no tasks yet · the planner has not run";
    body.append(empty);
  }
  if (spine !== null) {
    const donePct = sorted.length === 0 ? 0 : (completed / sorted.length) * 100;
    const livePct = livePosition < 0 || sorted.length === 0 ? donePct : (livePosition / sorted.length) * 100;
    spine.style.background = `linear-gradient(to bottom, var(--status-ok) 0%, var(--status-ok) ${donePct}%, var(--ember-08) ${donePct}%, var(--ember-08) ${livePct}%, var(--line-2) ${livePct}%)`;
  }
}

export function initRunStream(): void {
  const root = document.querySelector<HTMLElement>('[data-island="run-stream"]');
  if (root === null) return;
  const url = root.dataset["streamUrl"];
  if (url === undefined || url === "") return;
  if (typeof EventSource === "undefined") return;
  const runId = root.dataset["runId"];
  const projectId = root.dataset["projectId"];
  const initialStatus = root.dataset["runStatus"];
  if (runId === undefined || projectId === undefined || initialStatus === undefined) {
    setStreamState(root, "unavailable", "The rendered run identity is incomplete.");
    return;
  }

  let totals = emptyTotals();
  const protocol = new RunStreamProtocol(runId, projectId, initialStatus, root.dataset["runOutcome"] || null);
  const source = new EventSource(url, { withCredentials: true });

  const invalid = (reason: string): void => {
    if (protocol.isTerminal) markStreamUnavailableUnlessFinal(root, reason);
    else setStreamState(root, "stale", reason);
  };

  source.addEventListener("snapshot", (event) => {
    if (protocol.isClosed) return;
    try {
      const decoded = protocol.snapshot(parseMessageData(event));
      if (!decoded.ok) return invalid(decoded.reason);
      const data = decoded.value;
      setStreamState(root, "live");
      const next = emptyTotals();
      for (const cost of data.costs) applyCost(next, cost);
      totals = next;
      renderCostBar(root, totals);
      applyTasks(root, data.tasks);
      applyStatus(root, data.run.status, data.run.outcome);
    } catch {
      invalid("Malformed snapshot frame from the live stream.");
    }
  });

  source.addEventListener("costs", (event) => {
    if (protocol.isClosed) return;
    try {
      const decoded = protocol.costs(parseMessageData(event));
      if (!decoded.ok) return invalid(decoded.reason);
      setStreamState(root, "live");
      const next = cloneTotals(totals);
      for (const cost of decoded.value.costs) applyCost(next, cost);
      totals = next;
      renderCostBar(root, totals);
    } catch {
      invalid("Malformed costs frame from the live stream.");
    }
  });

  source.addEventListener("status", (event) => {
    if (protocol.isClosed) return;
    try {
      const decoded = protocol.status(parseMessageData(event));
      if (!decoded.ok) return invalid(decoded.reason);
      setStreamState(root, "live");
      applyStatus(root, decoded.value.status, decoded.value.outcome);
    } catch {
      invalid("Malformed status frame from the live stream.");
    }
  });

  source.addEventListener("task", (event) => {
    if (protocol.isClosed) return;
    try {
      const decoded = protocol.task(parseMessageData(event));
      if (!decoded.ok) return invalid(decoded.reason);
      setStreamState(root, "live");
      applyTasks(root, decoded.value.tasks);
    } catch {
      invalid("Malformed task frame from the live stream.");
    }
  });

  source.addEventListener("events", (event) => {
    if (protocol.isClosed) return;
    try {
      const decoded = protocol.events(parseMessageData(event));
      if (!decoded.ok) return invalid(decoded.reason);
      setStreamState(root, "live");
    } catch {
      invalid("Malformed events frame from the live stream.");
    }
  });

  source.addEventListener("heartbeat", (event) => {
    if (protocol.isClosed) return;
    try {
      const decoded = protocol.heartbeat(parseMessageData(event));
      if (!decoded.ok) invalid(decoded.reason);
    } catch {
      invalid("Malformed heartbeat frame from the live stream.");
    }
  });

  source.addEventListener("drained", (event) => {
    if (protocol.isClosed) return;
    try {
      const decoded = protocol.drained(parseMessageData(event));
      if (!decoded.ok) return invalid(decoded.reason);
      const flag = root.querySelector<HTMLElement>('[data-rd="live-flag"]');
      if (flag !== null) {
        flag.textContent = "● final · totals verified";
        flag.removeAttribute("title");
      }
      source.close();
    } catch {
      invalid("Malformed drained receipt from the live stream.");
    }
  });

  source.addEventListener("error", () => {
    if (protocol.isClosed) return;
    markStreamUnavailableUnlessFinal(
      root,
      "The browser lost the run event stream; EventSource will keep reconnecting.",
    );
  });

  // Click a trajectory moment → re-render the reasoning pane server-side with
  // the selected moment (keeps the reasoning derivation contract-typed on the
  // server rather than reshaping payloads client-side).
  root.addEventListener("click", (clickEvent) => {
    const moment = (clickEvent.target as HTMLElement).closest<HTMLElement>("[data-rd-moment]");
    if (moment === null) return;
    const taskId = moment.dataset["rdMoment"];
    if (taskId === undefined) return;
    const params = new URLSearchParams(window.location.search);
    params.set("moment", taskId);
    window.location.search = params.toString();
  });
}
