import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { PgEventStore } from "../../engine/eventStore.js";
import { isEventName } from "../../engine/events/index.js";
import { emitRedactionAudit, hasElevatedScope, redactEventPayload } from "../../engine/redaction/index.js";

interface RedactEventRowsInput {
  pool: pg.Pool;
  rows: ReadonlyArray<Record<string, unknown>>;
  runId: string;
  actor: ActorContext | undefined;
  rawView: boolean;
}

// redactEventRows applies the redaction layer to event rows at read
// time. Raw payloads stay in the events table; this serializer hides sensitive
// fields based on the actor's scope. When rawView is true and the actor has an
// elevated scope, a redaction.raw_access audit event is emitted per row that
// actually returned raw fields. Returns the redacted rows; the caller awaits
// the audit emissions before responding.
export async function redactEventRows(input: RedactEventRowsInput): Promise<{
  events: ReadonlyArray<Record<string, unknown>>;
}> {
  const { pool, rows, runId, actor, rawView } = input;
  const eventStoreForAudit = new PgEventStore(pool);
  const auditEmissions: Promise<void>[] = [];
  const serialized = rows.map((row) => {
    const eventType = String(row["event_type"]);
    if (actor === undefined || !isEventName(eventType)) {
      return row;
    }
    const output = redactEventPayload({
      eventName: eventType,
      payload: row["payload"],
      actor,
      rawView,
    });
    if (rawView && output.rawAccessedPaths.length > 0 && hasElevatedScope(actor)) {
      auditEmissions.push(
        emitRedactionAudit({
          store: eventStoreForAudit,
          actor,
          runId: String(row["run_id"] ?? runId),
          specId: String(row["spec_id"] ?? ""),
          projectId: String(row["project_id"] ?? ""),
          taskId: row["task_id"] !== null && row["task_id"] !== undefined ? String(row["task_id"]) : undefined,
          eventReadId: String(row["id"]),
          eventReadType: eventType,
          paths: output.rawAccessedPaths,
        }),
      );
    }
    return {
      ...row,
      payload: output.payload,
      redactedPaths: output.redactedPaths,
    };
  });
  if (auditEmissions.length > 0) {
    await Promise.all(auditEmissions);
  }
  return { events: serialized };
}

// parseRawViewOptIn extracts the raw-view opt-in signal. Two equivalent
// surfaces are accepted: the `X-View-Raw: true` header (for programmatic
// callers) and the `?raw=true` query parameter (for UI links). Either is
// the actor explicitly stating "I want the raw values" — the audit emitter
// rows-this so the operator trail captures the decision.
export function parseRawViewOptIn(c: {
  req: {
    header: (name: string) => string | undefined;
    query: (name: string) => string | undefined;
  };
}): boolean {
  const header = c.req.header("x-view-raw");
  if (header !== undefined && /^(1|true|yes)$/iu.test(header.trim())) {
    return true;
  }
  const query = c.req.query("raw");
  return query !== undefined && /^(1|true|yes)$/iu.test(query.trim());
}
