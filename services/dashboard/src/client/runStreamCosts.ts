/**
 * Cost aggregation for the run-stream island.
 *
 * Stable `RunCostRecord.id` is the dedupe key: live snapshot resets totals +
 * seen-ids; draining reconciling a full reconnect snapshot applies only unseen
 * ids; repeated delta ids are no-ops. Malformed/missing ids fail closed at parse.
 */

export type BillingMode = "per_token" | "subscription" | "self_hosted" | "unattributed";

export interface CostRecordFrame {
  /** Normalized stable id (string form of number|string wire id). */
  id: string;
  billingMode: BillingMode;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  costUsd: string | null;
}

export interface CostTotalsState {
  perTokenUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  bySource: Map<BillingMode, { tokens: number; usd: number }>;
  /** Applied cost record ids — never double-count across snapshot/delta. */
  seenIds: Set<string>;
}

const BILLING_MODES = new Set<string>(["per_token", "subscription", "self_hosted", "unattributed"]);

const COST_SOURCE_VAR: Record<BillingMode, string> = {
  per_token: "var(--cost-token)",
  subscription: "var(--cost-window)",
  self_hosted: "var(--cost-opportunity)",
  unattributed: "var(--cost-unattributed, var(--status-fail))",
};
const COST_SOURCE_LABEL: Record<BillingMode, string> = {
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

function nonNegInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}

/** Fail-closed parse: missing/empty id or broken numeric fields → undefined. */
export function parseCostRecord(raw: unknown): CostRecordFrame | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  const rawId = rec["id"];
  if (typeof rawId !== "string" && typeof rawId !== "number") return undefined;
  const id = String(rawId);
  if (id === "") return undefined;
  const billingMode = rec["billingMode"];
  if (typeof billingMode !== "string" || !BILLING_MODES.has(billingMode)) return undefined;
  const model = rec["model"];
  if (typeof model !== "string") return undefined;
  const inputTokens = nonNegInt(rec["inputTokens"]);
  const outputTokens = nonNegInt(rec["outputTokens"]);
  const cachedInputTokens = nonNegInt(rec["cachedInputTokens"]);
  const totalTokens = nonNegInt(rec["totalTokens"]);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cachedInputTokens === undefined ||
    totalTokens === undefined
  ) {
    return undefined;
  }
  const costUsdRaw = rec["costUsd"];
  const costUsd =
    costUsdRaw === null || costUsdRaw === undefined ? null : typeof costUsdRaw === "string" ? costUsdRaw : undefined;
  if (costUsd === undefined) return undefined;
  return {
    id,
    billingMode: billingMode as BillingMode,
    model,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens,
    costUsd,
  };
}

/** Parse a wire costs array; drop malformed rows (never invent zeros). */
export function parseCostRecords(raw: unknown): CostRecordFrame[] {
  if (!Array.isArray(raw)) return [];
  const out: CostRecordFrame[] = [];
  for (const item of raw) {
    const parsed = parseCostRecord(item);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

export function emptyTotals(): CostTotalsState {
  return {
    perTokenUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    bySource: new Map(),
    seenIds: new Set(),
  };
}

export function resetTotals(totals: CostTotalsState): void {
  totals.perTokenUsd = 0;
  totals.inputTokens = 0;
  totals.outputTokens = 0;
  totals.cachedInputTokens = 0;
  totals.totalTokens = 0;
  totals.bySource.clear();
  totals.seenIds.clear();
}

/** Apply one cost if its id is unseen. Returns true when newly applied. */
export function applyCost(totals: CostTotalsState, cost: CostRecordFrame): boolean {
  if (totals.seenIds.has(cost.id)) return false;
  totals.seenIds.add(cost.id);
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
  return true;
}

/** Apply many costs; returns count of newly applied (unseen) records. */
export function applyCostList(totals: CostTotalsState, costs: CostRecordFrame[]): number {
  let applied = 0;
  for (const cost of costs) {
    if (applyCost(totals, cost)) applied += 1;
  }
  return applied;
}

function setText(root: HTMLElement, key: string, text: string): void {
  const el = root.querySelector<HTMLElement>(`[data-rd="${key}"]`);
  if (el !== null) el.textContent = text;
}

export function renderCostBar(root: HTMLElement, totals: CostTotalsState): void {
  setText(root, "cost-per-token", formatUsd(totals.perTokenUsd));
  setText(root, "cost-tokens", `${formatTokens(totals.inputTokens)} / ${formatTokens(totals.outputTokens)}`);
  const sources = root.querySelector<HTMLElement>('[data-rd="cost-sources"]');
  if (sources === null || typeof document === "undefined") return;
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
