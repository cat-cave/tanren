/**
 * Run-detail live-update island. Subscribes to the run's SSE feed
 * (the dashboard same-origin proxy → orchestrator `/stream`) and
 * patches the cost bar, trajectory spine, run status, and per-moment events in
 * place — no page reload, no client router.
 *
 * SSE contract (orchestrator `runs/sse.ts`): the first `snapshot` is a full
 * run/tasks/events/costs payload; every later frame is a delta. Client machine:
 *   live → draining (terminal status) → closed (idle after cost drain)
 * During draining/closed: ignore all `snapshot` fields (including costs) so a
 * reconnect full snapshot cannot rewrite totals/status/tasks or re-arm drain.
 * Only `event: costs` deltas may add late cost records while draining.
 * Drain close is deterministic: terminal entry arms idle; cost deltas re-arm;
 * stream errors never re-arm; dispose is terminal (no reactivation).
 */

interface BillingAgg {
  tokens: number;
  usd: number;
}

interface CostRecordFrame {
  billingMode: "per_token" | "subscription" | "self_hosted" | "unattributed";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  costUsd: string | null;
}

interface TaskFrame {
  taskId: string;
  status: string;
  outcome: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

interface CostTotalsState {
  perTokenUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  bySource: Map<CostRecordFrame["billingMode"], BillingAgg>;
}

/** Idle window after terminal entry or last post-terminal cost delta before close. */
export const COST_DRAIN_IDLE_MS = 2_500;

const COST_SOURCE_VAR: Record<CostRecordFrame["billingMode"], string> = {
  per_token: "var(--cost-token)",
  subscription: "var(--cost-window)",
  self_hosted: "var(--cost-opportunity)",
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

function createDomEl(tag: string): HTMLElement {
  if (typeof document !== "undefined") return document.createElement(tag);
  // Node unit tests: minimal element stub (no full DOM).
  return {
    className: "",
    style: {} as CSSStyleDeclaration,
    textContent: "",
    append: () => {},
  } as unknown as HTMLElement;
}

function renderCostBar(root: HTMLElement, totals: CostTotalsState): void {
  setText(root, "cost-per-token", formatUsd(totals.perTokenUsd));
  setText(root, "cost-tokens", `${formatTokens(totals.inputTokens)} / ${formatTokens(totals.outputTokens)}`);
  const sources = root.querySelector<HTMLElement>('[data-rd="cost-sources"]');
  if (sources !== null) {
    sources.innerHTML = "";
    for (const [mode, agg] of totals.bySource) {
      const row = createDomEl("div");
      row.className = "source-row";
      const sw = createDomEl("span");
      sw.className = "sw";
      sw.style.background = COST_SOURCE_VAR[mode];
      const label = createDomEl("span");
      label.textContent = COST_SOURCE_LABEL[mode];
      const amt = createDomEl("span");
      amt.className = "amt";
      amt.textContent = `${formatTokens(agg.tokens)} tok${agg.usd > 0 ? ` · ${formatUsd(agg.usd)}` : ""}`;
      row.append(sw, label, amt);
      sources.append(row);
    }
  }
}

export function isTerminalRunStatus(status: string): boolean {
  return ["completed", "failed", "halted", "cancelled", "done"].includes(status);
}

export function isFinalStreamState(root: HTMLElement): boolean {
  const flag = root.querySelector<HTMLElement>('[data-rd="live-flag"]');
  return flag?.textContent === "● final";
}

/** Phase: live | draining (terminal, costs still accepted) | closed. */
export type RunStreamPhase = "live" | "draining" | "closed";

export function getRunStreamPhase(root: HTMLElement): RunStreamPhase {
  const phase = root.dataset["rdPhase"];
  if (phase === "draining" || phase === "closed") return phase;
  return isFinalStreamState(root) ? "draining" : "live";
}

export function setRunStreamPhase(root: HTMLElement, phase: RunStreamPhase): void {
  root.dataset["rdPhase"] = phase;
}

/**
 * Live-flag transitions. Once final, live/stale/unavailable are no-ops.
 */
export function setStreamState(
  root: HTMLElement,
  state: "live" | "stale" | "unavailable" | "final",
  reason?: string,
): void {
  const flag = root.querySelector<HTMLElement>('[data-rd="live-flag"]');
  if (flag === null) return;
  if (isFinalStreamState(root) && state !== "final") return;
  if (state === "final") {
    flag.textContent = "● final";
    flag.removeAttribute("title");
    if (getRunStreamPhase(root) !== "closed") setRunStreamPhase(root, "draining");
    return;
  }
  if (state === "live") {
    flag.textContent = "↻ live";
    flag.removeAttribute("title");
    return;
  }
  flag.textContent = state === "stale" ? "⚠ stream stale" : "⚠ stream unavailable";
  if (reason !== undefined) flag.title = reason;
}

export function markStreamUnavailableUnlessFinal(root: HTMLElement, reason: string): void {
  if (isFinalStreamState(root) || getRunStreamPhase(root) !== "live") return;
  setStreamState(root, "unavailable", reason);
}

/**
 * Idle-grace closer: after terminal, close once cost activity is quiet.
 * - enterDrain arms the deadline once (idempotent while already draining).
 * - noteCostActivity re-arms only for real `event: costs` deltas.
 * - onStreamError never re-arms or extends (reconnect storms cannot keep-alive).
 * - dispose is terminal: cancel timer, mark closed, reject all further arms.
 * - timer callbacks are generation-fenced so a canceled idle cannot fire after
 *   a later re-arm from real cost activity.
 */
export function createCostDrainCloser(
  opts: {
    idleMs?: number;
    schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    cancel?: (id: ReturnType<typeof setTimeout>) => void;
  } = {},
): {
  enterDrain: (close: () => void) => void;
  noteCostActivity: () => void;
  onStreamError: () => void;
  isDraining: () => boolean;
  isClosed: () => boolean;
  /** Monotonic fence id for tests / stale-callback rejection. */
  generation: () => number;
  dispose: () => void;
} {
  const idleMs = opts.idleMs ?? COST_DRAIN_IDLE_MS;
  const schedule = opts.schedule ?? setTimeout;
  const cancel = opts.cancel ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closeFn: (() => void) | undefined;
  let draining = false;
  let closed = false;
  let gen = 0;

  const arm = (): void => {
    if (!draining || closed || closeFn === undefined) return;
    if (timer !== undefined) cancel(timer);
    const myGen = ++gen;
    timer = schedule(() => {
      // Stale canceled callback — a newer arm superseded this deadline.
      if (myGen !== gen || closed) return;
      closed = true;
      draining = false;
      timer = undefined;
      const fn = closeFn;
      closeFn = undefined;
      fn?.();
    }, idleMs);
  };

  return {
    enterDrain(close) {
      if (closed) return;
      if (draining) {
        // Already draining: keep the existing deadline (errors must not extend it).
        if (closeFn === undefined) closeFn = close;
        return;
      }
      draining = true;
      closeFn = close;
      arm();
    },
    noteCostActivity() {
      if (!draining || closed) return;
      arm();
    },
    onStreamError() {
      // First (and any) post-terminal error: do not close now, do not re-arm.
    },
    isDraining: () => draining && !closed,
    isClosed: () => closed,
    generation: () => gen,
    dispose() {
      if (timer !== undefined) cancel(timer);
      timer = undefined;
      gen += 1; // fence any in-flight scheduled callback
      closed = true;
      draining = false;
      closeFn = undefined;
    },
  };
}

export function applyStatus(root: HTMLElement, status: string, outcome: string | null): boolean {
  // After terminal lock, status/header must never demote or rewrite.
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
  costsDelta: number;
}

/**
 * Snapshot is the initial full payload while live only. During draining/closed
 * every field is ignored (including costs) — reconnect snapshots must not
 * mutate totals, status, header, tasks, or the drain deadline.
 */
export function applySnapshotFrame(
  root: HTMLElement,
  totals: CostTotalsState,
  data: { costs?: CostRecordFrame[]; run?: { status: string; outcome: string | null } },
  drain?: { noteCostActivity: () => void; enterDrain: (close: () => void) => void; close: () => void },
): SnapshotApplyResult {
  const phase = getRunStreamPhase(root);
  if (phase === "draining" || phase === "closed") {
    return { applied: false, costsReset: false, statusApplied: false, costsDelta: 0 };
  }

  setStreamState(root, "live");
  totals.perTokenUsd = 0;
  totals.inputTokens = 0;
  totals.outputTokens = 0;
  totals.cachedInputTokens = 0;
  totals.totalTokens = 0;
  totals.bySource.clear();
  for (const cost of data.costs ?? []) applyCost(totals, cost);
  renderCostBar(root, totals);
  let statusApplied = false;
  if (data.run !== undefined) {
    statusApplied = applyStatus(root, data.run.status, data.run.outcome);
    if (isTerminalRunStatus(data.run.status) && drain !== undefined) {
      drain.enterDrain(drain.close);
    }
  }
  return {
    applied: true,
    costsReset: true,
    statusApplied,
    costsDelta: data.costs?.length ?? 0,
  };
}

/** Incremental cost deltas only. Re-arms drain deadline while draining. */
export function applyCostsFrame(
  root: HTMLElement,
  totals: CostTotalsState,
  costs: CostRecordFrame[],
  drain?: { noteCostActivity: () => void },
): boolean {
  const phase = getRunStreamPhase(root);
  if (phase === "closed") return false;
  if (phase === "live") setStreamState(root, "live");
  if (costs.length === 0) return true;
  for (const cost of costs) applyCost(totals, cost);
  renderCostBar(root, totals);
  if (phase === "draining") drain?.noteCostActivity();
  return true;
}

export function initRunStream(): void {
  const root = document.querySelector<HTMLElement>('[data-island="run-stream"]');
  if (root === null) return;
  const url = root.dataset["streamUrl"];
  if (url === undefined || url === "") return;
  if (typeof EventSource === "undefined") return;

  const totals = emptyTotals();
  const source = new EventSource(url, { withCredentials: true });
  setRunStreamPhase(root, "live");

  const drain = createCostDrainCloser();
  let streamClosed = false;
  const closeStream = (): void => {
    // Exactly-once: timer, dispose, and error races all funnel here.
    if (streamClosed) return;
    streamClosed = true;
    setRunStreamPhase(root, "closed");
    source.close();
    drain.dispose();
  };
  const drainHooks = {
    noteCostActivity: () => drain.noteCostActivity(),
    enterDrain: (close: () => void) => drain.enterDrain(close),
    close: closeStream,
  };

  source.addEventListener("snapshot", (event) => {
    try {
      const data: {
        costs?: CostRecordFrame[];
        run?: { status: string; outcome: string | null };
      } = JSON.parse(event.data);
      applySnapshotFrame(root, totals, data, drainHooks);
    } catch {
      setStreamState(root, "stale", "Malformed snapshot frame from the live stream.");
    }
  });

  source.addEventListener("costs", (event) => {
    try {
      const data: { costs?: CostRecordFrame[] } = JSON.parse(event.data);
      applyCostsFrame(root, totals, data.costs ?? [], drainHooks);
    } catch {
      setStreamState(root, "stale", "Malformed costs frame from the live stream.");
    }
  });

  source.addEventListener("status", (event) => {
    try {
      const data: { status: string; outcome: string | null } = JSON.parse(event.data);
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
      const frame: TaskFrame = JSON.parse(event.data);
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
      // Do not close on first post-terminal error; do not re-arm the deadline.
      // Existing idle from terminal entry (or last cost delta) still governs close.
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
    const params = new URLSearchParams(window.location.search);
    params.set("moment", taskId);
    window.location.search = params.toString();
  });
}
