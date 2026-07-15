/**
 * Cost aggregation for the run-stream island.
 *
 * Stable `RunCostRecord.id` is the dedupe key: live snapshot resets totals +
 * seen-ids only after a fully valid costs array parses; draining reconciling a
 * reconnect snapshot applies only unseen ids. The costs array is an atomic
 * strict boundary — non-array or any malformed row throws before mutation.
 */

export type BillingMode = "per_token" | "subscription" | "self_hosted" | "unattributed";

export interface CostRecordFrame {
  /** Normalized stable id (trimmed string form of number|string wire id). */
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

/** Thrown when a costs frame fails the atomic strict boundary (no partial apply). */
export class CostFrameParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostFrameParseError";
  }
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

/** Finite nonnegative integer — no fractional truncation. */
function nonNegInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Entire-string finite decimal (no parseFloat prefix acceptance).
 * Schema decision: allow optional sign, integer/fractional part, and optional
 * scientific exponent (e.g. "0.0010", "-1.5", "1e-4"). Reject hex, NaN/Infinity
 * tokens, trailing/prefix junk, and internal whitespace.
 */
const FINITE_DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

/** True iff the full string is a finite decimal representation (after no trim here). */
export function isFiniteDecimalString(value: string): boolean {
  if (!FINITE_DECIMAL_RE.test(value)) return false;
  const n = Number(value);
  return Number.isFinite(n);
}

/** Normalize wire id: number|string only; reject non-finite numbers and empty/NaN/Infinity strings. */
function parseCostId(rawId: unknown): string {
  if (typeof rawId === "number") {
    if (!Number.isFinite(rawId)) {
      throw new CostFrameParseError("cost id number must be finite");
    }
    return String(rawId);
  }
  if (typeof rawId === "string") {
    const id = rawId.trim();
    if (id === "") {
      throw new CostFrameParseError("cost id must be a nonempty string after trim");
    }
    // Reject string forms of non-finite numbers (and bare numeric garbage).
    if (/^[+-]?nan$/iu.test(id) || /^[+-]?infinity$/iu.test(id)) {
      throw new CostFrameParseError("cost id must not be NaN or Infinity");
    }
    return id;
  }
  throw new CostFrameParseError("cost id must be a number or string");
}

/**
 * Strict single-row parse aligned with RunCostRecord essentials.
 * Throws CostFrameParseError on any violation (caller treats frame as atomic).
 */
export function parseCostRecord(raw: unknown): CostRecordFrame {
  if (typeof raw !== "object" || raw === null) {
    throw new CostFrameParseError("cost record must be an object");
  }
  if (!hasOwn(raw, "id") || !hasOwn(raw, "costUsd")) {
    throw new CostFrameParseError("cost record requires own id and costUsd fields");
  }
  const rec = raw as Record<string, unknown>;
  const id = parseCostId(rec["id"]);
  const billingMode = rec["billingMode"];
  if (typeof billingMode !== "string" || !BILLING_MODES.has(billingMode)) {
    throw new CostFrameParseError("invalid billingMode");
  }
  const modelRaw = rec["model"];
  if (typeof modelRaw !== "string") {
    throw new CostFrameParseError("model must be a string");
  }
  const model = modelRaw.trim();
  if (model === "") {
    throw new CostFrameParseError("model must be nonempty after trim");
  }
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
    throw new CostFrameParseError("token fields must be finite nonnegative integers");
  }
  const costUsdRaw = rec["costUsd"];
  let costUsd: string | null;
  if (costUsdRaw === null) {
    costUsd = null;
  } else if (typeof costUsdRaw === "string") {
    const trimmed = costUsdRaw.trim();
    if (trimmed === "") {
      throw new CostFrameParseError("costUsd string must be nonempty after trim");
    }
    // Entire trimmed string must be a finite decimal — not a parseFloat prefix.
    if (!isFiniteDecimalString(trimmed)) {
      throw new CostFrameParseError("costUsd string must be a finite decimal representation");
    }
    costUsd = trimmed;
  } else {
    throw new CostFrameParseError("costUsd must be null or a finite decimal string");
  }
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

/**
 * Atomic costs-array boundary: non-array or any bad row throws before any
 * totals mutation. Empty array is a valid (no-op) success payload.
 */
export function parseCostRecords(raw: unknown): CostRecordFrame[] {
  if (!Array.isArray(raw)) {
    throw new CostFrameParseError("costs must be an array");
  }
  const out: CostRecordFrame[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    try {
      out.push(parseCostRecord(raw[i]));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "invalid cost row";
      throw new CostFrameParseError(`costs[${i}]: ${msg}`);
    }
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
  // costUsd already validated finite-or-null at parse boundary.
  const usd = cost.costUsd === null ? 0 : Number.parseFloat(cost.costUsd);
  totals.inputTokens += cost.inputTokens;
  totals.outputTokens += cost.outputTokens;
  totals.cachedInputTokens += cost.cachedInputTokens;
  totals.totalTokens += cost.totalTokens;
  if (cost.billingMode === "per_token") totals.perTokenUsd += usd;
  const src = totals.bySource.get(cost.billingMode) ?? { tokens: 0, usd: 0 };
  src.tokens += cost.totalTokens;
  src.usd += usd;
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

/** Render via root.ownerDocument (or global document) — no test-only create shims. */
export function renderCostBar(root: HTMLElement, totals: CostTotalsState): void {
  setText(root, "cost-per-token", formatUsd(totals.perTokenUsd));
  setText(root, "cost-tokens", `${formatTokens(totals.inputTokens)} / ${formatTokens(totals.outputTokens)}`);
  const sources = root.querySelector<HTMLElement>('[data-rd="cost-sources"]');
  if (sources === null) return;
  const doc = root.ownerDocument ?? (typeof document === "undefined" ? null : document);
  if (doc === null) return;
  sources.innerHTML = "";
  for (const [mode, agg] of totals.bySource) {
    const row = doc.createElement("div");
    row.className = "source-row";
    const sw = doc.createElement("span");
    sw.className = "sw";
    sw.style.background = COST_SOURCE_VAR[mode];
    const label = doc.createElement("span");
    label.textContent = COST_SOURCE_LABEL[mode];
    const amt = doc.createElement("span");
    amt.className = "amt";
    amt.textContent = `${formatTokens(agg.tokens)} tok${agg.usd > 0 ? ` · ${formatUsd(agg.usd)}` : ""}`;
    row.append(sw, label, amt);
    sources.append(row);
  }
}
