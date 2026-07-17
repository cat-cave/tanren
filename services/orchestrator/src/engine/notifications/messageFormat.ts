import type { TypedEvent } from "../events/index.js";
import { defaultSeverityFor } from "./eventDefaultSeverity.js";
import type { Severity } from "./schemas.js";

export interface EventContext {
  // The org under which this event was emitted. The dispatcher will not
  // load matrix rows without it; events scoped to a null org (system
  // events) are skipped.
  orgId: string | null;
  // The acting user, if any. User-scope target rows override org-scope
  // rows for this user. System events leave this null.
  actorUserId: string | null;
  // Optional run/spec/project identifiers; used to enrich the payload
  // body and to compute the deep link.
  runId?: string | null;
  specId?: string | null;
  projectId?: string | null;
}

// effectiveSeverityFor: the registry's default-severity map is the base
// rate; a few payload shapes carry per-instance severity hints (run.completed
// outcome "fail", release.finalized cleanedUp=false, demo.completed failed>0)
// so the matrix is actionable without proliferating event names.
export function effectiveSeverityFor(event: TypedEvent): Severity {
  const base = defaultSeverityFor(event.eventType);
  if (event.eventType === "run.completed") {
    const payload = event.payload as { outcome?: string };
    if (typeof payload.outcome === "string" && payload.outcome.includes("fail")) {
      return promote(base);
    }
  }
  // A FAILED teardown (residual resources to reconcile) promotes one tier so
  // a leaked runner reaches the operator.
  if (event.eventType === "release.finalized") {
    const payload = event.payload as { cleanedUp?: boolean };
    if (payload.cleanedUp === false) {
      return promote(base);
    }
  }
  // demos-as-evidence: a demo where any behavior failed promotes (info → warn)
  // so the "deploy verified but planted issue" signal clears the default floor.
  if (event.eventType === "demo.completed") {
    const payload = event.payload as { failed?: number };
    if (typeof payload.failed === "number" && payload.failed > 0) {
      return promote(base);
    }
  }
  return base;
}

function promote(severity: Severity): Severity {
  switch (severity) {
    case "ok":
      return "info";
    case "info":
      return "warn";
    case "warn":
      return "fail";
    case "fail":
      return "fail";
    default: {
      const exhaustive: never = severity;
      throw new Error(`promote: unhandled severity ${String(exhaustive)}`);
    }
  }
}

export function titleFor(eventName: string, severity: Severity): string {
  return `[${severity.toUpperCase()}] ${eventName}`;
}

export function bodyFor(eventName: string, context: EventContext, redactedPayload: unknown): string {
  const lines: string[] = [];
  if (context.projectId) lines.push(`project=${context.projectId}`);
  if (context.runId) lines.push(`run=${context.runId}`);
  if (context.specId) lines.push(`spec=${context.specId}`);
  lines.push(`event=${eventName}`);
  // Stringify the redacted payload defensively; markers serialize cleanly.
  let serialized = "";
  try {
    serialized = JSON.stringify(redactedPayload);
  } catch {
    serialized = "<unserializable>";
  }
  // Cap the body so a verbose payload doesn't blow up ntfy / future
  // channels. 4096 is generous; ntfy limits are stricter in practice and
  // its server truncates further if needed.
  if (serialized.length > 4096) {
    serialized = `${serialized.slice(0, 4093)}...`;
  }
  lines.push(serialized);
  return lines.join("\n");
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
