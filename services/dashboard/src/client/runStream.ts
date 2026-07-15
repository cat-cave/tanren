/**
 * Run-detail live-update island. Subscribes to the run's SSE feed
 * (dashboard same-origin proxy → orchestrator `/stream`) and patches cost bar,
 * trajectory, and run status in place.
 *
 * SSE contract (orchestrator `runs/sse.ts`): first `snapshot` is full
 * run/tasks/events/costs; later frames are deltas. Client machine:
 *   live → draining (terminal) → closed (idle after cost quiet)
 *
 * Cost accounting uses stable `RunCostRecord.id`: live snapshot resets totals +
 * seen-ids; draining reconciling a reconnect snapshot applies only unseen cost
 * ids (run/status/tasks ignored); closed ignores all. Only newly applied costs
 * re-arm the drain deadline. Errors never re-arm.
 */

import {
  applyCostList,
  emptyTotals,
  parseCostRecords,
  renderCostBar,
  resetTotals,
  type CostRecordFrame,
  type CostTotalsState,
} from "./runStreamCosts.js";
import {
  COST_DRAIN_IDLE_MS,
  createCostDrainCloser,
  getRunStreamPhase,
  isFinalStreamState,
  isTerminalRunStatus,
  markStreamUnavailableUnlessFinal,
  setRunStreamPhase,
  setStreamState,
  type CostDrainCloser,
} from "./runStreamDrain.js";

export { COST_DRAIN_IDLE_MS, createCostDrainCloser, getRunStreamPhase, isFinalStreamState, isTerminalRunStatus };
export { markStreamUnavailableUnlessFinal, setRunStreamPhase, setStreamState };
export type { RunStreamPhase } from "./runStreamDrain.js";
export {
  applyCost,
  applyCostList,
  emptyTotals,
  parseCostRecord,
  parseCostRecords,
  resetTotals,
  type CostRecordFrame,
  type CostTotalsState,
} from "./runStreamCosts.js";

interface TaskFrame {
  taskId: string;
  status: string;
  outcome: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

function setText(root: HTMLElement, key: string, text: string): void {
  const el = root.querySelector<HTMLElement>(`[data-rd="${key}"]`);
  if (el !== null) el.textContent = text;
}

export function applyStatus(root: HTMLElement, status: string, outcome: string | null): boolean {
  if (getRunStreamPhase(root) !== "live") return false;
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
    setStreamState(root, "final");
  }
  return true;
}

export function applyTask(root: HTMLElement, task: TaskFrame): boolean {
  if (getRunStreamPhase(root) !== "live") return false;
  const row = root.querySelector<HTMLElement>(`[data-rd-moment="${task.taskId}"]`);
  if (row === null) return false;
  const dot = row.querySelector<HTMLElement>(".dot");
  const ph = row.querySelector<HTMLElement>(".ph");
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
  if (dot !== null) {
    dot.className = `dot ${state}`;
    dot.textContent = state === "done" ? "✓" : state === "live" ? "↻" : state === "failed" ? "×" : "";
  }
  if (ph !== null) {
    const text = ph.textContent ?? "";
    ph.className = `ph ${state}`;
    ph.textContent = text;
  }
  row.classList.toggle("queued", state === "queued");
  return true;
}

export interface SnapshotApplyResult {
  applied: boolean;
  costsReset: boolean;
  statusApplied: boolean;
  /** Count of newly applied (unseen-id) costs. */
  costsDelta: number;
}

export type DrainHooks = {
  noteCostActivity: () => void;
  enterDrain: (close: () => void) => void;
  close: () => void;
};

/**
 * Live: full reset of totals+seen, apply all parsed costs, apply status.
 * Draining: ignore run/status/tasks; reconcile costs by unseen id only;
 *   re-arm only when at least one new id applied.
 * Closed: ignore everything.
 */
export function applySnapshotFrame(
  root: HTMLElement,
  totals: CostTotalsState,
  data: { costs?: unknown; run?: { status: string; outcome: string | null } },
  drain?: DrainHooks,
): SnapshotApplyResult {
  const phase = getRunStreamPhase(root);
  if (phase === "closed") {
    return { applied: false, costsReset: false, statusApplied: false, costsDelta: 0 };
  }

  if (phase === "draining") {
    const costs = parseCostRecords(data.costs);
    const n = applyCostList(totals, costs);
    if (n > 0) {
      renderCostBar(root, totals);
      drain?.noteCostActivity();
    }
    return { applied: n > 0, costsReset: false, statusApplied: false, costsDelta: n };
  }

  setStreamState(root, "live");
  resetTotals(totals);
  const costs = parseCostRecords(data.costs);
  const n = applyCostList(totals, costs);
  renderCostBar(root, totals);
  let statusApplied = false;
  if (data.run !== undefined) {
    statusApplied = applyStatus(root, data.run.status, data.run.outcome);
    if (isTerminalRunStatus(data.run.status) && drain !== undefined) {
      drain.enterDrain(drain.close);
    }
  }
  return { applied: true, costsReset: true, statusApplied, costsDelta: n };
}

/**
 * Incremental `event: costs` deltas. Dedupes by id; re-arms drain only when
 * at least one unseen id was applied.
 */
export function applyCostsFrame(
  root: HTMLElement,
  totals: CostTotalsState,
  costsRaw: unknown,
  drain?: { noteCostActivity: () => void },
): { applied: boolean; costsDelta: number } {
  const phase = getRunStreamPhase(root);
  if (phase === "closed") return { applied: false, costsDelta: 0 };
  if (phase === "live") setStreamState(root, "live");
  const costs = parseCostRecords(costsRaw);
  const n = applyCostList(totals, costs);
  if (n > 0) {
    renderCostBar(root, totals);
    if (phase === "draining") drain?.noteCostActivity();
  }
  return { applied: n > 0 || costs.length === 0, costsDelta: n };
}

/** Optional seams for unit tests (EventSource, document, timers). */
export interface RunStreamInitDeps {
  document?: Document;
  EventSourceCtor?: typeof EventSource;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (id: ReturnType<typeof setTimeout>) => void;
  idleMs?: number;
}

export function initRunStream(deps: RunStreamInitDeps = {}): void {
  const doc = deps.document ?? (typeof document !== "undefined" ? document : undefined);
  if (doc === undefined) return;
  const root = doc.querySelector<HTMLElement>('[data-island="run-stream"]');
  if (root === null) return;
  const url = root.dataset["streamUrl"];
  if (url === undefined || url === "") return;
  const ES = deps.EventSourceCtor ?? (typeof EventSource !== "undefined" ? EventSource : undefined);
  if (ES === undefined) return;

  const totals = emptyTotals();
  const source = new ES(url, { withCredentials: true });
  setRunStreamPhase(root, "live");

  const drain: CostDrainCloser = createCostDrainCloser({
    idleMs: deps.idleMs ?? COST_DRAIN_IDLE_MS,
    schedule: deps.schedule,
    cancel: deps.cancel,
  });
  let streamClosed = false;
  const closeStream = (): void => {
    if (streamClosed) return;
    streamClosed = true;
    setRunStreamPhase(root, "closed");
    source.close();
    drain.dispose();
  };
  const drainHooks: DrainHooks = {
    noteCostActivity: () => drain.noteCostActivity(),
    enterDrain: (close) => drain.enterDrain(close),
    close: closeStream,
  };

  source.addEventListener("snapshot", (event) => {
    try {
      const data: { costs?: unknown; run?: { status: string; outcome: string | null } } = JSON.parse(
        (event as MessageEvent).data as string,
      );
      applySnapshotFrame(root, totals, data, drainHooks);
    } catch {
      setStreamState(root, "stale", "Malformed snapshot frame from the live stream.");
    }
  });

  source.addEventListener("costs", (event) => {
    try {
      const data: { costs?: unknown } = JSON.parse((event as MessageEvent).data as string);
      applyCostsFrame(root, totals, data.costs ?? [], drainHooks);
    } catch {
      setStreamState(root, "stale", "Malformed costs frame from the live stream.");
    }
  });

  source.addEventListener("status", (event) => {
    try {
      const data: { status: string; outcome: string | null } = JSON.parse((event as MessageEvent).data as string);
      if (getRunStreamPhase(root) !== "live") return;
      setStreamState(root, "live");
      applyStatus(root, data.status, data.outcome);
      if (isTerminalRunStatus(data.status)) {
        drain.enterDrain(closeStream);
      }
    } catch {
      setStreamState(root, "stale", "Malformed status frame from the live stream.");
    }
  });

  source.addEventListener("task", (event) => {
    try {
      const frame: TaskFrame = JSON.parse((event as MessageEvent).data as string);
      if (getRunStreamPhase(root) !== "live") return;
      setStreamState(root, "live");
      applyTask(root, frame);
    } catch {
      setStreamState(root, "stale", "Malformed task frame from the live stream.");
    }
  });

  source.addEventListener("error", () => {
    if (streamClosed || getRunStreamPhase(root) === "closed") return;
    if (getRunStreamPhase(root) === "draining" || isFinalStreamState(root)) {
      if (!drain.isDraining() && !drain.isClosed()) {
        drain.enterDrain(closeStream);
      }
      drain.onStreamError();
      return;
    }
    markStreamUnavailableUnlessFinal(
      root,
      "The browser lost the run event stream; EventSource will keep reconnecting.",
    );
  });

  root.addEventListener("click", (clickEvent) => {
    const moment = (clickEvent.target as HTMLElement).closest<HTMLElement>("[data-rd-moment]");
    if (moment === null) return;
    const taskId = moment.dataset["rdMoment"];
    if (taskId === undefined) return;
    const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
    params.set("moment", taskId);
    if (typeof window !== "undefined") {
      window.location.search = params.toString();
    }
  });
}
