// Structured logger seam (H10 hardening): a thin, dependency-free wrapper over
// `console` that emits ONE structured JSON line per call — a level, a message, an
// optional correlation context (runId/orgId/specId/projectId where in scope), and
// an optional detail payload — instead of the prior ad-hoc `console.log/warn/error`
// string interpolation. Level-filtered via `TANREN_LOG_LEVEL` (default `info`), so
// a noisy `debug` line can be silenced without a redeploy.
//
// Redaction is BAKED IN: every emitted string field (message + string detail
// values) is run through `redactLogString`, the same URL/token/secret stripper the
// internal failure log uses, so a logged error message can never leak a bearer
// token, an `api_key=...` assignment, or a credential-bearing URL. Structured, not
// string-spliced, so an operator can grep/parse the stream by field.

const LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * The correlation context attached to a log line. Every field is optional — a log
 * site supplies whichever ids are in scope (a run-path site has `runId`; a route
 * has `orgId`; a DAG site has `projectId`/`specId`). The `component` is the
 * subsystem tag that replaces the prior `[run-worker]`-style message prefix.
 */
export interface LogContext {
  component?: string;
  runId?: string;
  orgId?: string;
  specId?: string;
  projectId?: string;
  taskId?: string;
  eventId?: string;
  [field: string]: unknown;
}

/** Best-effort redaction for a logged string: strip URLs + token/secret shapes. */
export function redactLogString(detail: string): string {
  return detail
    .replaceAll(/\bhttps?:\/\/\S+/giu, "[url]")
    .replaceAll(/\b(bearer|authorization|token|password|secret|api[_-]?key)(\s*[:=]\s*)\S+/giu, "$1$2[redacted]");
}

/** Recursively redact every string in a detail payload (objects/arrays/strings). */
function redactDetail(value: unknown): unknown {
  if (typeof value === "string") return redactLogString(value);
  if (value instanceof Error) return redactLogString(value.message);
  if (Array.isArray(value)) return value.map((item) => redactDetail(item));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactDetail(inner);
    }
    return out;
  }
  return value;
}

function configuredLevel(): LogLevel {
  const raw = (process.env["TANREN_LOG_LEVEL"] ?? "info").toLowerCase();
  return (LEVELS as readonly string[]).includes(raw) ? (raw as LogLevel) : "info";
}

function emit(level: LogLevel, message: string, context: LogContext, detail?: unknown): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[configuredLevel()]) return;
  const { component, ...rest } = context;
  const line: Record<string, unknown> = {
    level,
    ts: new Date().toISOString(),
    ...(component !== undefined && { component }),
    msg: redactLogString(message),
    ...rest,
    ...(detail !== undefined && { detail: redactDetail(detail) }),
  };
  // One structured JSON line. `console.error` for warn/error so the stream splits
  // operationally (stdout vs stderr) the way the prior convention did; info/debug
  // go to stdout.
  const sink = level === "warn" || level === "error" ? console.error : console.log;
  sink(JSON.stringify(line));
}

/**
 * A structured logger bound to a fixed {@link LogContext} (typically the
 * subsystem `component`, plus whatever correlation ids are stable for the call
 * site). Each method emits one structured line; a per-call `context` is merged
 * over the bound context so a site can attach the run/spec/org id it has in hand.
 */
export interface Logger {
  debug(message: string, context?: LogContext, detail?: unknown): void;
  info(message: string, context?: LogContext, detail?: unknown): void;
  warn(message: string, context?: LogContext, detail?: unknown): void;
  error(message: string, context?: LogContext, detail?: unknown): void;
  /** Derive a child logger with additional bound context merged in. */
  child(context: LogContext): Logger;
}

function buildLogger(bound: LogContext): Logger {
  const at = (level: LogLevel) => (message: string, context?: LogContext, detail?: unknown) =>
    emit(level, message, { ...bound, ...context }, detail);
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: (context: LogContext) => buildLogger({ ...bound, ...context }),
  };
}

/** Create a logger bound to a subsystem `component` (and any stable context). */
export function createLogger(component: string, context: LogContext = {}): Logger {
  return buildLogger({ component, ...context });
}
