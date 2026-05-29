// P3-0029 observability: a lightweight timing helper used at the
// provider / SSH / GitHub adapter boundaries and at workflow stage
// transitions. It captures wall-clock latency for an operation and emits a
// single structured-log line per call. It deliberately does NOT persist to
// any DB table or event type — observability here is logs + metrics + tests,
// not schema (no migration, no new event). The queue-wait timing is owned by
// P3-0028 and is intentionally out of scope here.
//
// The emitted record carries only non-sensitive metadata (operation name,
// boundary, duration, outcome, and caller-supplied attributes that the call
// sites keep secret-free: host/port, HTTP method, path TEMPLATE, provider cli
// + role). Tokens, stdin, request bodies, and credential refs are never
// included, so this layer needs no redaction pass of its own.

export type TimingBoundary = "provider" | "ssh" | "github" | "workflow-stage";

export type TimingOutcome = "ok" | "error";

// A single structured timing record. Shape is stable so log scrapers /
// dashboards can key off `event: "timing"` + `boundary` + `operation`.
export interface TimingRecord {
  event: "timing";
  boundary: TimingBoundary;
  operation: string;
  durationMs: number;
  outcome: TimingOutcome;
  // Free-form, secret-free attributes. Call sites populate boundary-specific
  // dimensions here (e.g. `{ host, port }` for SSH, `{ method, path }` for
  // GitHub, `{ cli, role }` for providers, `{ runId, stage }` for workflow).
  attributes?: Record<string, string | number | boolean>;
  // ISO-8601 emit time, so a log line is self-describing without a collector.
  timestamp: string;
}

// Sink for timing records. Defaults to a console emitter; tests inject a
// capturing sink. Never throws — a failing sink must not break the workflow.
export type TimingSink = (record: TimingRecord) => void;

// Default sink: one structured `console` line per record. INFO for ok,
// WARN for error, so a tail/grep surfaces failing boundaries.
export const consoleTimingSink: TimingSink = (record) => {
  const line = `[timing] ${JSON.stringify(record)}`;
  if (record.outcome === "error") {
    console.warn(line);
  } else {
    console.log(line);
  }
};

export interface TimedOptions {
  boundary: TimingBoundary;
  operation: string;
  attributes?: Record<string, string | number | boolean>;
  sink?: TimingSink;
  // Monotonic clock injection point (tests pin this). Defaults to
  // `performance.now()` for sub-ms resolution that is immune to wall-clock
  // adjustments mid-operation.
  now?: () => number;
}

function safeEmit(sink: TimingSink, record: TimingRecord): void {
  try {
    sink(record);
  } catch {
    // Observability must never take down the operation it measures.
  }
}

// Wraps an async operation, measuring its latency and emitting exactly one
// timing record (ok on resolve, error on reject) before re-propagating the
// original result/error. The wrapped operation's behavior is unchanged: the
// return value and thrown error pass through untouched.
export async function timed<T>(options: TimedOptions, operation: () => Promise<T>): Promise<T> {
  const sink = options.sink ?? consoleTimingSink;
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const base = {
    event: "timing" as const,
    boundary: options.boundary,
    operation: options.operation,
    attributes: options.attributes,
  };
  try {
    const result = await operation();
    safeEmit(sink, {
      ...base,
      durationMs: roundMs(now() - startedAt),
      outcome: "ok",
      timestamp: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    safeEmit(sink, {
      ...base,
      durationMs: roundMs(now() - startedAt),
      outcome: "error",
      timestamp: new Date().toISOString(),
    });
    throw error;
  }
}

// Synchronous variant for workflow stage transitions that have already
// measured their own duration (the loop stages track `startedAt`/runtime).
// This lets a stage report its latency through the same structured channel
// without re-wrapping the call.
export function emitStageTiming(
  stage: string,
  durationMs: number,
  attributes?: Record<string, string | number | boolean>,
  sink: TimingSink = consoleTimingSink,
): void {
  safeEmit(sink, {
    event: "timing",
    boundary: "workflow-stage",
    operation: stage,
    durationMs: roundMs(durationMs),
    outcome: "ok",
    attributes,
    timestamp: new Date().toISOString(),
  });
}

function roundMs(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return rounded > 0 ? rounded : 0;
}
