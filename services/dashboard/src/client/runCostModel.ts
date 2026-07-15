/** Exact, environment-neutral run cost model shared by SSR and the browser. */
import { RunCostRecordWire, type RunCostRecordWire as RunCostRecord } from "../api/runDetailSchemas.js";

export type BillingMode = RunCostRecord["billingMode"];
export type CostRecordFrame = RunCostRecord & { microUsd: bigint; fingerprint: string };
interface CostAggregate {
  tokens: number;
  microUsd: bigint;
}
interface ModelAggregate extends CostAggregate {
  provider: string;
}

export interface CostTotalsState {
  perTokenMicros: bigint;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  bySource: Map<BillingMode, CostAggregate>;
  byModel: Map<string, ModelAggregate>;
  seenIds: Set<string>;
  fingerprints: Map<string, string>;
}

export class CostFrameParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostFrameParseError";
  }
}

const MAX_EXACT = Number.MAX_SAFE_INTEGER;
const MAX_MICRO_USD = BigInt(MAX_EXACT);
const DECIMAL_RE = /^(\d+)(?:\.(\d{1,6}))?$/u;

export function decimalToMicros(value: string): bigint {
  const match = DECIMAL_RE.exec(value);
  if (match === null) throw new CostFrameParseError("costUsd must be a nonnegative decimal string");
  const integer = match[1];
  const fraction = match[2] ?? "";
  let digits = `${integer}${fraction}`.replace(/^0+(?=\d)/u, "");
  digits += "0".repeat(6 - fraction.length);
  const micros = BigInt(digits || "0");
  if (micros > MAX_MICRO_USD) throw new CostFrameParseError("costUsd exceeds the exact accounting range");
  return micros;
}

function fingerprint(record: RunCostRecord, micros: bigint): string {
  return JSON.stringify([
    record.id,
    record.runId,
    record.taskId,
    record.projectId,
    record.cli,
    record.provider,
    record.model,
    record.inputTokens,
    record.cachedInputTokens,
    record.cacheCreationTokens,
    record.outputTokens,
    record.reasoningOutputTokens,
    record.totalTokens,
    micros.toString(),
    record.billingMode,
    record.costBasis,
    record.recordedAt,
  ]);
}

export function parseCostRecord(raw: unknown): CostRecordFrame {
  const result = RunCostRecordWire.safeParse(raw);
  if (!result.success) throw new CostFrameParseError("cost record does not match RunCostRecord");
  const microUsd = result.data.costUsd === null ? 0n : decimalToMicros(result.data.costUsd);
  return { ...result.data, microUsd, fingerprint: fingerprint(result.data, microUsd) };
}

export function parseCostRecords(raw: unknown): CostRecordFrame[] {
  if (!Array.isArray(raw)) throw new CostFrameParseError("costs must be an array");
  return raw.map((record, index) => {
    try {
      return parseCostRecord(record);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "invalid record";
      throw new CostFrameParseError(`costs[${index}]: ${detail}`);
    }
  });
}

export function emptyTotals(): CostTotalsState {
  return {
    perTokenMicros: 0n,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    bySource: new Map(),
    byModel: new Map(),
    seenIds: new Set(),
    fingerprints: new Map(),
  };
}

function cloneTotals(source: CostTotalsState): CostTotalsState {
  return {
    perTokenMicros: source.perTokenMicros,
    inputTokens: source.inputTokens,
    outputTokens: source.outputTokens,
    cachedInputTokens: source.cachedInputTokens,
    totalTokens: source.totalTokens,
    bySource: new Map([...source.bySource].map(([key, value]) => [key, { ...value }])),
    byModel: new Map([...source.byModel].map(([key, value]) => [key, { ...value }])),
    seenIds: new Set(source.seenIds),
    fingerprints: new Map(source.fingerprints),
  };
}

export function commitTotals(target: CostTotalsState, source: CostTotalsState): void {
  target.perTokenMicros = source.perTokenMicros;
  target.inputTokens = source.inputTokens;
  target.outputTokens = source.outputTokens;
  target.cachedInputTokens = source.cachedInputTokens;
  target.totalTokens = source.totalTokens;
  target.bySource = source.bySource;
  target.byModel = source.byModel;
  target.seenIds = source.seenIds;
  target.fingerprints = source.fingerprints;
}

function checkedAdd(left: number, right: number, field: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new CostFrameParseError(`${field} aggregate exceeds safe integer range`);
  return sum;
}

function checkedMicros(left: bigint, right: bigint): bigint {
  const sum = left + right;
  if (sum > MAX_MICRO_USD) throw new CostFrameParseError("cost aggregate exceeds the exact accounting range");
  return sum;
}

function appendCandidate(candidate: CostTotalsState, cost: CostRecordFrame): boolean {
  const existing = candidate.fingerprints.get(cost.id);
  if (existing !== undefined) {
    if (existing !== cost.fingerprint) throw new CostFrameParseError(`cost id ${cost.id} collided with different data`);
    return false;
  }
  candidate.inputTokens = checkedAdd(candidate.inputTokens, cost.inputTokens, "inputTokens");
  candidate.outputTokens = checkedAdd(candidate.outputTokens, cost.outputTokens, "outputTokens");
  candidate.cachedInputTokens = checkedAdd(candidate.cachedInputTokens, cost.cachedInputTokens, "cachedInputTokens");
  candidate.totalTokens = checkedAdd(candidate.totalTokens, cost.totalTokens, "totalTokens");
  if (cost.billingMode === "per_token")
    candidate.perTokenMicros = checkedMicros(candidate.perTokenMicros, cost.microUsd);
  const source = candidate.bySource.get(cost.billingMode) ?? { tokens: 0, microUsd: 0n };
  source.tokens = checkedAdd(source.tokens, cost.totalTokens, "source tokens");
  source.microUsd = checkedMicros(source.microUsd, cost.microUsd);
  candidate.bySource.set(cost.billingMode, source);
  const modelKey = `${cost.provider}/${cost.model}`;
  const model = candidate.byModel.get(modelKey) ?? { tokens: 0, microUsd: 0n, provider: cost.provider };
  model.tokens = checkedAdd(model.tokens, cost.totalTokens, "model tokens");
  model.microUsd = checkedMicros(model.microUsd, cost.microUsd);
  candidate.byModel.set(modelKey, model);
  candidate.seenIds.add(cost.id);
  candidate.fingerprints.set(cost.id, cost.fingerprint);
  return true;
}

export function prepareCostAppend(
  totals: CostTotalsState,
  costs: CostRecordFrame[],
): { next: CostTotalsState; added: number } {
  const next = cloneTotals(totals);
  let added = 0;
  for (const cost of costs) if (appendCandidate(next, cost)) added += 1;
  return { next, added };
}

export function prepareCostReset(totals: CostTotalsState, costs: CostRecordFrame[]): CostTotalsState {
  for (const cost of costs) {
    const prior = totals.fingerprints.get(cost.id);
    if (prior !== undefined && prior !== cost.fingerprint) {
      throw new CostFrameParseError(`cost id ${cost.id} collided with different snapshot data`);
    }
  }
  const next = emptyTotals();
  for (const cost of costs) appendCandidate(next, cost);
  return next;
}

export function summarizeCostRecords(costs: ReadonlyArray<RunCostRecord>): CostTotalsState {
  const parsed = parseCostRecords(costs);
  const totals = emptyTotals();
  commitTotals(totals, prepareCostReset(totals, parsed));
  return totals;
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

export function formatMicros(micros: bigint): string {
  const dollars = micros / 1_000_000n;
  let fraction = (micros % 1_000_000n).toString().padStart(6, "0");
  while (fraction.length > 4 && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return `$${dollars}.${fraction}`;
}
