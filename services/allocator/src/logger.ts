// Structured logger seam (H10 hardening) for the allocator sidecar: a thin,
// dependency-free `console` wrapper that emits ONE structured JSON line per call
// (level + message + correlation context: runId/orgId/runnerId where in scope)
// instead of ad-hoc string interpolation. Level-filtered via `TANREN_LOG_LEVEL`
// (default `info`). Mirrors the orchestrator's logger seam; kept local because the
// allocator is a separate package with no shared-util dependency.

const LEVELS = ["debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LEVELS)[number];
const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogContext {
  component?: string;
  runId?: string;
  orgId?: string;
  runnerId?: string;
  projectId?: string;
  [field: string]: unknown;
}

/** Strip URLs + token/secret shapes from a logged string (redaction preserved). */
function redact(detail: string): string {
  return detail
    .replaceAll(/\bhttps?:\/\/\S+/giu, "[url]")
    .replaceAll(/\b(bearer|authorization|token|password|secret|api[_-]?key)(\s*[:=]\s*)\S+/giu, "$1$2[redacted]");
}

function redactDetail(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (value instanceof Error) return redact(value.message);
  if (Array.isArray(value)) return value.map((item) => redactDetail(item));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) out[key] = redactDetail(inner);
    return out;
  }
  return value;
}

function configuredLevel(): LogLevel {
  const raw = (process.env["TANREN_LOG_LEVEL"] ?? "info").toLowerCase();
  return (LEVELS as readonly string[]).includes(raw) ? (raw as LogLevel) : "info";
}

function emit(level: LogLevel, message: string, context: LogContext, detail?: unknown): void {
  if (RANK[level] < RANK[configuredLevel()]) return;
  const { component, ...rest } = context;
  const line: Record<string, unknown> = {
    level,
    ts: new Date().toISOString(),
    ...(component !== undefined && { component }),
    msg: redact(message),
    ...rest,
    ...(detail !== undefined && { detail: redactDetail(detail) }),
  };
  const sink = level === "warn" || level === "error" ? console.error : console.log;
  sink(JSON.stringify(line));
}

export interface Logger {
  debug(message: string, context?: LogContext, detail?: unknown): void;
  info(message: string, context?: LogContext, detail?: unknown): void;
  warn(message: string, context?: LogContext, detail?: unknown): void;
  error(message: string, context?: LogContext, detail?: unknown): void;
}

/** Create a logger bound to a subsystem `component` (and any stable context). */
export function createLogger(component: string, context: LogContext = {}): Logger {
  const bound: LogContext = { component, ...context };
  const at = (level: LogLevel) => (message: string, ctx?: LogContext, detail?: unknown) =>
    emit(level, message, { ...bound, ...ctx }, detail);
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
