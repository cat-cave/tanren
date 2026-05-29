import type { TokenUsage } from "../providers/types.js";
import type { CcusageAccounting, CcusageModelUsage } from "./contracts.js";

// Parses the real `ccusage <cli> --json` output:
//   { daily: [ { date, inputTokens, outputTokens, cachedInputTokens,
//                reasoningOutputTokens, totalTokens, costUSD,
//                models: { <model>: { ...same buckets..., isFallback } } } ],
//     totals: { inputTokens, outputTokens, cachedInputTokens,
//               reasoningOutputTokens, totalTokens, costUSD } }
//
// ccusage's buckets are DISJOINT (input excludes cache) — the same convention
// as the disjoint TokenUsage schema, so no de-overlap is needed. ccusage may
// not emit `cacheCreationTokens` for codex (Anthropic-only) → default 0.
//
// Cost mapping: subscription windows usually report `costUSD: 0` or omit it.
// We treat 0 (and absent) as NULL — a subscription cost is not a real dollar
// figure. Only a POSITIVE costUSD becomes a cost_basis='ccusage' figure.
//
// Tolerant by contract: empty (`daily: []`) → zero totals + null cost; any
// unrecognized shape → null ("no data"). Never throws.
export function parseCcusageAccounting(stdout: string, cli: string): CcusageAccounting | null {
  const parsed = parseJson(stdout);
  if (!isObject(parsed)) {
    return null;
  }
  const totalsRecord = isObject(parsed["totals"]) ? (parsed["totals"] as Record<string, unknown>) : undefined;
  const dailyArray = Array.isArray(parsed["daily"]) ? parsed["daily"] : undefined;
  if (totalsRecord === undefined && dailyArray === undefined) {
    return null;
  }
  const totals = totalsRecord !== undefined ? tokenUsageFromRecord(totalsRecord) : emptyUsage();
  return {
    cli,
    totals,
    costUsd: positiveCostOrNull(totalsRecord?.["costUSD"]),
    perModel: collectPerModel(dailyArray ?? []),
    capturedAt: new Date().toISOString()
  };
}

// Aggregates per-model token usage across every daily bucket so a multi-day
// window still yields one entry per model.
function collectPerModel(daily: unknown[]): CcusageModelUsage[] {
  const aggregate = new Map<string, TokenUsage>();
  for (const day of daily) {
    if (!isObject(day) || !isObject(day["models"])) {
      continue;
    }
    for (const [model, raw] of Object.entries(day["models"] as Record<string, unknown>)) {
      if (!isObject(raw)) {
        continue;
      }
      const usage = tokenUsageFromRecord(raw);
      const existing = aggregate.get(model);
      aggregate.set(model, existing === undefined ? usage : addUsage(existing, usage));
    }
  }
  return [...aggregate.entries()].map(([model, usage]) => ({ model, usage }));
}

function tokenUsageFromRecord(record: Record<string, unknown>): TokenUsage {
  const inputTokens = numberField(record["inputTokens"]) ?? 0;
  const cachedInputTokens = numberField(record["cachedInputTokens"]) ?? 0;
  const cacheCreationTokens = numberField(record["cacheCreationTokens"]) ?? 0; // Anthropic-only; 0 for codex
  const outputTokens = numberField(record["outputTokens"]) ?? 0;
  const reasoningOutputTokens = numberField(record["reasoningOutputTokens"]) ?? 0;
  const totalTokens =
    numberField(record["totalTokens"]) ??
    inputTokens + cachedInputTokens + cacheCreationTokens + outputTokens + reasoningOutputTokens;
  return { inputTokens, cachedInputTokens, cacheCreationTokens, outputTokens, reasoningOutputTokens, totalTokens };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
    totalTokens: a.totalTokens + b.totalTokens
  };
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

// A subscription reports costUSD 0 (or omits it): not a real dollar figure, so
// treat as null. Only a strictly-positive figure is a real cost.
function positiveCostOrNull(value: unknown): number | null {
  const cost = numberField(value);
  return cost !== undefined && cost > 0 ? cost : null;
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
