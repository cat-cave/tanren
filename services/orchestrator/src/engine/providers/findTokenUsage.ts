// Shared, BOUNDED token-usage finder for the managed CLI adapters
// (codex/claude/opencode/reasonix). Each adapter parses one provider JSONL event
// object and walks it looking for the provider's usage record; the per-provider
// SHAPE (which fields, how to de-overlap) lives in each adapter's
// `tokenUsageFromRecord`, which is injected here.
//
// WHY BOUNDED: a hostile or buggy JSONL event can be arbitrarily deeply nested
// (or arbitrarily wide). An UNBOUNDED `Object.values` recursion over such an
// event blows the V8 stack / hangs the worker slot. So the walk is hard-capped
// on BOTH depth and total visited nodes.
//
// FAIL-LOUD on the bound (token-accounting invariant): if the cap is hit we do
// NOT silently return `undefined`/zero — token accounting is mandatory, and a
// bounded parse that found nothing must be VISIBLE. We log a LOUD
// `usage-parse-bounded` signal (provider + which cap) so the dropped usage is
// never lost quietly, then return whatever usage WAS found before the bound (the
// real, well-formed case is shallow and finds it long before any cap).

import type { TokenUsage } from "./types.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("provider-usage");

// Generous caps: every real provider usage record sits within the first few
// levels of a single event object and a handful of nodes. These bounds only ever
// trip on pathological (hostile/buggy) input, so the normal case is identical.
export const MAX_USAGE_PARSE_DEPTH = 64;
export const MAX_USAGE_PARSE_NODES = 50_000;

// Splits a JSON Lines stream into its non-empty records. Keep the original line
// text so callers can apply provider-specific malformed-line policies.
export function splitNonEmptyJsonlLines(stdout: string): string[] {
  return stdout.split(/\r?\n/u).filter((line) => line.trim() !== "");
}

// JSONL telemetry events must be objects. Primitive JSON values and arrays are
// rejected alongside syntactically invalid JSON so each provider can decide
// whether that rejected line is loud or benign.
export function parseJsonObject(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A node/depth-bounded walk that the per-provider shape decoder rides on. */
export function findTokenUsageBounded(
  provider: string,
  value: unknown,
  decode: (record: Record<string, unknown>) => TokenUsage | undefined,
): TokenUsage | undefined {
  // Mutable budget shared across the whole walk of one event object.
  const budget = { nodes: MAX_USAGE_PARSE_NODES, bounded: false as boolean, reason: "" };
  const found = walk(value, 0, decode, budget);
  if (budget.bounded) {
    // LOUD, never silent: the usage-parse hit a bound. Surfacing this keeps the
    // token-accounting invariant honest — a bounded parse that found nothing is a
    // VISIBLE signal, not a quiet zero.
    log.error(
      "usage-parse-bounded: token-usage walk hit a parse bound; usage may be UNDER-counted for this event. " +
        "This indicates a hostile/buggy provider JSONL event.",
      { provider, reason: budget.reason, maxDepth: MAX_USAGE_PARSE_DEPTH, maxNodes: MAX_USAGE_PARSE_NODES },
    );
  }
  return found;
}

function walk(
  value: unknown,
  depth: number,
  decode: (record: Record<string, unknown>) => TokenUsage | undefined,
  budget: { nodes: number; bounded: boolean; reason: string },
): TokenUsage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  if (depth > MAX_USAGE_PARSE_DEPTH) {
    budget.bounded = true;
    budget.reason = "max-depth";
    return undefined;
  }
  if (budget.nodes <= 0) {
    budget.bounded = true;
    budget.reason = "max-nodes";
    return undefined;
  }
  budget.nodes -= 1;

  const record = value as Record<string, unknown>;
  const usage = decode(record);
  if (usage !== undefined) {
    return usage;
  }
  for (const child of Object.values(record)) {
    const nested = walk(child, depth + 1, decode, budget);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}
