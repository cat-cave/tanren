/**
 * Run-detail live-update island. Subscribes to the run's SSE feed
 * (the dashboard same-origin proxy → orchestrator `/stream`) and
 * patches the cost bar, trajectory spine, run status, and per-moment events in
 * place — no page reload, no client router.
 *
 * Cost state is keyed/upserted by exact bigint-decimal row identity (never
 * append-summed), so same-id null→known reconciliation applies once and
 * reconnect cannot double-count. Terminal status does not abort delivery —
 * server stream closure is authoritative.
 *
 * Frame contract (`SseEventName`):
 *   - `snapshot` { run, tasks, recentEvents, costs }  (initial, full)
 *   - `status`   { runId, status, outcome }
 *   - `task`     <TaskTimelineEntry>                   (single changed task)
 *   - `events`   { events: [...] }                     (new event rows)
 *   - `costs`    { costs: [...] }                       (new/reconciled cost records)
 *   - `heartbeat`{ ts }
 */

interface CostRecordFrame {
  id?: string | number;
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

interface BillingAgg {
  tokens: number;
  knownUsd: number;
  unknownRecords: number;
  pricedRecords: number;
}

interface CostTotalsState {
  perTokenKnownUsd: number;
  perTokenUnknown: number;
  perTokenPriced: number;
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
  unattributed: "var(--cost-unattributed, var(--status-fail))",
};
const COST_SOURCE_LABEL: Record<CostRecordFrame["billingMode"], string> = {
  per_token: "per-token",
  subscription: "window",
  self_hosted: "self-hosted",
  unattributed: "unattributed",
};

/**
 * Run statuses that mark a run finished. Drives both the "● final" paint and
 * the stream's terminal-seen flag (the latter gates EOF close — see
 * `RunStreamReducer`). Centralized so the SSE client and its reducer cannot
 * drift on what "terminal" means.
 */
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "halted", "cancelled", "done"]);

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}
function formatUsd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

function formatCostLabel(totals: CostTotalsState): string {
  if (totals.perTokenPriced === 0 && totals.perTokenUnknown > 0) return "unknown";
  if (totals.perTokenUnknown > 0) return `${formatUsd(totals.perTokenKnownUsd)} known`;
  return formatUsd(totals.perTokenKnownUsd);
}

function emptyTotals(): CostTotalsState {
  return {
    perTokenKnownUsd: 0,
    perTokenUnknown: 0,
    perTokenPriced: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    bySource: new Map(),
  };
}

function costIdentity(cost: CostRecordFrame, fallbackIndex: number): string {
  if (cost.id !== undefined && cost.id !== null && String(cost.id) !== "") {
    return String(cost.id);
  }
  // Frames without an id (legacy/test) still need a stable upsert key per frame.
  return `__anon_${fallbackIndex}`;
}

/** Recompute aggregates from the upsert map — never append-sum frames. */
function recomputeTotals(byId: Map<string, CostRecordFrame>): CostTotalsState {
  const totals = emptyTotals();
  for (const cost of byId.values()) {
    const parsed = cost.costUsd === null ? null : Number.parseFloat(cost.costUsd);
    const knownUsd = parsed !== null && Number.isFinite(parsed) ? parsed : null;
    totals.inputTokens += cost.inputTokens;
    totals.outputTokens += cost.outputTokens;
    totals.cachedInputTokens += cost.cachedInputTokens;
    totals.totalTokens += cost.totalTokens;
    if (cost.billingMode === "per_token") {
      if (knownUsd === null) totals.perTokenUnknown += 1;
      else {
        totals.perTokenKnownUsd += knownUsd;
        totals.perTokenPriced += 1;
      }
    }
    const src = totals.bySource.get(cost.billingMode) ?? {
      tokens: 0,
      knownUsd: 0,
      unknownRecords: 0,
      pricedRecords: 0,
    };
    src.tokens += cost.totalTokens;
    if (knownUsd === null) src.unknownRecords += 1;
    else {
      src.knownUsd += knownUsd;
      src.pricedRecords += 1;
    }
    totals.bySource.set(cost.billingMode, src);
  }
  return totals;
}

function formatSourceAmt(agg: BillingAgg): string {
  // Coverage from priced/unknown **counts**, never dollar magnitude.
  let usd = "";
  if (agg.pricedRecords === 0 && agg.unknownRecords > 0) usd = " · unknown";
  else if (agg.pricedRecords > 0 && agg.unknownRecords > 0) usd = ` · ${formatUsd(agg.knownUsd)} known`;
  else if (agg.pricedRecords > 0) usd = ` · ${formatUsd(agg.knownUsd)}`;
  return `${formatTokens(agg.tokens)} tok${usd}`;
}

function setText(root: HTMLElement, key: string, text: string): void {
  const el = root.querySelector<HTMLElement>(`[data-rd="${key}"]`);
  if (el !== null) el.textContent = text;
}

function renderCostBar(root: HTMLElement, totals: CostTotalsState): void {
  setText(root, "cost-per-token", formatCostLabel(totals));
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
      amt.textContent = formatSourceAmt(agg);
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
  if (TERMINAL_RUN_STATUSES.has(status)) {
    const flag = root.querySelector<HTMLElement>('[data-rd="live-flag"]');
    if (flag !== null) flag.textContent = "● final";
  }
}

function applyTask(root: HTMLElement, task: TaskFrame): void {
  const row = root.querySelector<HTMLElement>(`[data-rd-moment="${task.taskId}"]`);
  if (row === null) return;
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
}

/**
 * Pure frame-sequence state for the run-detail SSE island. Owns the
 * exact-identity cost upsert map + the terminal-seen flag so the SSE frame
 * contract — terminal status does NOT abort delivery; the server stream close
 * (EOF) is authoritative — is unit-testable without a DOM/EventSource. A final
 * same-id cost reconciliation (null→known) arriving AFTER a terminal status
 * frame still applies, because nothing here (or in `initRunStream`) drops
 * frames once terminal is seen; only an EOF closes the stream.
 */
export class RunStreamReducer {
  private readonly costsById = new Map<string, CostRecordFrame>();
  private anonSeq = 0;
  private terminalSeen = false;

  get totals(): CostTotalsState {
    return recomputeTotals(this.costsById);
  }

  get isTerminal(): boolean {
    return this.terminalSeen;
  }

  /** Reset + upsert a full snapshot's cost rows by exact identity. */
  ingestSnapshotCosts(costs: CostRecordFrame[] | undefined): void {
    this.costsById.clear();
    this.anonSeq = 0;
    this.ingestCosts(costs);
  }

  /** Upsert cost deltas/reconciliations by exact identity (never append-sum). */
  ingestCosts(costs: CostRecordFrame[] | undefined): void {
    for (const cost of costs ?? []) {
      this.costsById.set(costIdentity(cost, this.anonSeq++), cost);
    }
  }

  /** Record a status frame. Returns true once a terminal status has been seen. */
  ingestStatus(status: string): boolean {
    if (TERMINAL_RUN_STATUSES.has(status)) this.terminalSeen = true;
    return this.terminalSeen;
  }
}

export function initRunStream(): void {
  const root = document.querySelector<HTMLElement>('[data-island="run-stream"]');
  if (root === null) return;
  const url = root.dataset["streamUrl"];
  if (url === undefined || url === "") return;
  if (typeof EventSource === "undefined") return;

  /** Exact bigint-decimal cost identity → latest record (upsert, never append-sum). */
  const reducer = new RunStreamReducer();
  // Server stream closure is authoritative. We only close after terminal status
  // once the EventSource reports a close/error, so final cost frames delivered
  // before or with the terminal status still apply.
  const source = new EventSource(url, { withCredentials: true });

  const paint = (): void => {
    renderCostBar(root, reducer.totals);
  };

  source.addEventListener("snapshot", (event) => {
    try {
      const data: {
        costs?: CostRecordFrame[];
        run?: { status: string; outcome: string | null };
      } = JSON.parse(event.data);
      reducer.ingestSnapshotCosts(data.costs);
      paint();
      if (data.run !== undefined) applyStatus(root, data.run.status, data.run.outcome);
    } catch {
      /* ignore malformed frame */
    }
  });

  source.addEventListener("costs", (event) => {
    try {
      const data: { costs?: CostRecordFrame[] } = JSON.parse(event.data);
      reducer.ingestCosts(data.costs);
      paint();
    } catch {
      /* ignore */
    }
  });

  source.addEventListener("status", (event) => {
    try {
      const data: {
        status: string;
        outcome: string | null;
      } = JSON.parse(event.data);
      applyStatus(root, data.status, data.outcome);
      // Mark terminal but do not close yet — final tasks/events/costs may still
      // arrive if the server reorders poorly; server EOF is authoritative.
      reducer.ingestStatus(data.status);
    } catch {
      /* ignore */
    }
  });

  source.addEventListener("task", (event) => {
    try {
      const frame: TaskFrame = JSON.parse(event.data);
      applyTask(root, frame);
    } catch {
      /* ignore */
    }
  });

  source.addEventListener("error", () => {
    // After a terminal status, treat stream error/EOF as authoritative close
    // (prevents infinite reconnect on a finished run without aborting
    // mid-delivery of final cost reconciliations).
    if (reducer.isTerminal) {
      source.close();
    }
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

/** Test seam: recompute totals from upserted cost frames (count-based coverage). */
export function recomputeTotalsFromFrames(costs: CostRecordFrame[]): CostTotalsState {
  const byId = new Map<string, CostRecordFrame>();
  let i = 0;
  for (const cost of costs) byId.set(costIdentity(cost, i++), cost);
  return recomputeTotals(byId);
}

export function formatSourceAmtForTest(agg: BillingAgg): string {
  return formatSourceAmt(agg);
}
