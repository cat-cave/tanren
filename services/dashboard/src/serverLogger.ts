// Structured SERVER logger seam (H10 hardening) for the dashboard's Node entrypoint
// (main.tsx). A thin, dependency-free `console` wrapper that emits ONE structured
// JSON line per call (level + message + optional context) with token/secret/URL
// redaction baked in — the same shape as the orchestrator + allocator seams. Kept
// local because the dashboard is a separate package. SERVER-ONLY: the browser
// bundle under `client/` keeps its own browser `console`.

const LEVELS = ["debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LEVELS)[number];
const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogContext {
  component?: string;
  [field: string]: unknown;
}

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

/** Create a server logger bound to a subsystem `component`. */
export function createLogger(component: string, context: LogContext = {}): Logger {
  const bound: LogContext = { component, ...context };
  const at = (level: LogLevel) => (message: string, ctx?: LogContext, detail?: unknown) =>
    emit(level, message, { ...bound, ...ctx }, detail);
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
