/**
 * Run-detail live-update island (P2B-0004). Subscribes to the run's SSE feed
 * (the dashboard same-origin proxy → orchestrator P2A-0014 `/stream`) and
 * patches the cost bar, trajectory spine, run status, and per-moment events in
 * place — no page reload, no client router.
 *
 * The server renders the full initial view; this island only reconciles the
 * deltas the SSE frames carry. Frame contract (P2A-0014 `SseEventName`):
 *   - `snapshot` { run, tasks, recentEvents, costs }  (initial, full)
 *   - `status`   { runId, status, outcome }
 *   - `task`     <TaskTimelineEntry>                   (single changed task)
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

interface BillingAgg {
  tokens: number;
  usd: number;
}

interface CostRecordFrame {
  billingMode: "per_token" | "subscription" | "self_hosted";
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

const COST_SOURCE_VAR: Record<CostRecordFrame["billingMode"], string> = {
  per_token: "var(--cost-token)",
  subscription: "var(--cost-window)",
  self_hosted: "var(--cost-opportunity)",
};
const COST_SOURCE_LABEL: Record<CostRecordFrame["billingMode"], string> = {
  per_token: "per-token",
  subscription: "window",
  self_hosted: "self-hosted",
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
  if (["completed", "failed", "halted", "cancelled", "done"].includes(status)) {
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

export function initRunStream(): void {
  const root = document.querySelector<HTMLElement>('[data-island="run-stream"]');
  if (root === null) return;
  const url = root.dataset["streamUrl"];
  if (url === undefined || url === "") return;
  if (typeof EventSource === "undefined") return;

  const totals = emptyTotals();
  const source = new EventSource(url, { withCredentials: true });

  source.addEventListener("snapshot", (event) => {
    try {
      const data = JSON.parse((event as MessageEvent).data) as {
        costs?: CostRecordFrame[];
        run?: { status: string; outcome: string | null };
      };
      totals.perTokenUsd = 0;
      totals.inputTokens = 0;
      totals.outputTokens = 0;
      totals.cachedInputTokens = 0;
      totals.totalTokens = 0;
      totals.bySource.clear();
      for (const cost of data.costs ?? []) applyCost(totals, cost);
      renderCostBar(root, totals);
      if (data.run !== undefined) applyStatus(root, data.run.status, data.run.outcome);
    } catch {
      /* ignore malformed frame */
    }
  });

  source.addEventListener("costs", (event) => {
    try {
      const data = JSON.parse((event as MessageEvent).data) as { costs?: CostRecordFrame[] };
      for (const cost of data.costs ?? []) applyCost(totals, cost);
      renderCostBar(root, totals);
    } catch {
      /* ignore */
    }
  });

  source.addEventListener("status", (event) => {
    try {
      const data = JSON.parse((event as MessageEvent).data) as {
        status: string;
        outcome: string | null;
      };
      applyStatus(root, data.status, data.outcome);
      if (["completed", "failed", "halted", "cancelled", "done"].includes(data.status)) {
        source.close();
      }
    } catch {
      /* ignore */
    }
  });

  source.addEventListener("task", (event) => {
    try {
      applyTask(root, JSON.parse((event as MessageEvent).data) as TaskFrame);
    } catch {
      /* ignore */
    }
  });

  source.addEventListener("error", () => {
    // EventSource auto-reconnects on transient errors; nothing to do.
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
