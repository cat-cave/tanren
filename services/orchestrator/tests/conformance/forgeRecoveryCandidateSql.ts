// SQL recognizers for the `candidates` + `webhook_events` seam members, split out
// of forgeRecoveryMemoryDb.ts to keep that file under the 500-line cap. Each fn
// takes the shared store + the caller's org scope and the whitespace-collapsed
// SQL the store emitted; reads/writes filter to the org scope (the RLS row-
// visibility gate), so an off-scope read sees ZERO of another org's rows — exactly
// like the real org-scoped transaction.

import {
  candidateCols,
  webhookEventCols,
  type CandidateRec,
  type ForgeRecoveryDb,
  type QueryResult,
  type WebhookEventRec,
} from "./forgeRecoveryRecords.js";

export function candidateSql(
  db: ForgeRecoveryDb,
  orgId: string,
  sql: string,
  params: readonly unknown[],
): QueryResult | undefined {
  const visible = (): CandidateRec[] => db.candidates.filter((c) => c.org_id === orgId);
  const cols = (c: CandidateRec): Record<string, unknown> => candidateCols(c, db.inboxSources);
  if (sql.startsWith("INSERT INTO candidates")) {
    // Idempotent upsert keyed by (source_id, external_id): an existing visible row
    // refreshes its content/triage (and status while still new/triaged/auto_routed),
    // otherwise a fresh row is inserted. The source_name/source_kind are passed in
    // as $11/$12 (the store's RETURNING projection) — but the cols() helper joins
    // them from the live source, which is byte-identical.
    const [id, sourceId, ownOrgId, projectId, externalId, title, body, severity, status, triageJson] = params as [
      string,
      string,
      string,
      string | null,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const triage = JSON.parse(triageJson);
    const existing = db.candidates.find((c) => c.source_id === sourceId && c.external_id === externalId);
    if (existing !== undefined) {
      existing.title = title;
      existing.body = body;
      existing.severity = severity;
      existing.triage = triage;
      if (["new", "triaged", "auto_routed"].includes(existing.status)) existing.status = status;
      existing.updated_seq = ++db.seq;
      return { rows: [cols(existing)], rowCount: 1 };
    }
    const seq = ++db.seq;
    const rec: CandidateRec = {
      id,
      source_id: sourceId,
      org_id: ownOrgId,
      project_id: projectId,
      external_id: externalId,
      title,
      body,
      severity,
      status,
      triage,
      resolved_spec_id: null,
      seq,
      updated_seq: seq,
    };
    db.candidates.push(rec);
    return { rows: [cols(rec)], rowCount: 1 };
  }
  if (
    /^SELECT .* FROM candidates c JOIN inbox_sources s .* WHERE c\.org_id = \$1 ORDER BY c\.created_at DESC$/u.test(sql)
  ) {
    const rows = visible()
      .filter((c) => c.org_id === params[0])
      .sort((a, b) => b.seq - a.seq)
      .map((c) => cols(c));
    return { rows, rowCount: rows.length };
  }
  if (/^SELECT .* FROM candidates c JOIN inbox_sources s .* WHERE c\.id = \$1$/u.test(sql)) {
    const c = visible().find((x) => x.id === params[0]);
    return c === undefined ? { rows: [], rowCount: 0 } : { rows: [cols(c)], rowCount: 1 };
  }
  if (sql.startsWith("UPDATE candidates c SET project_id = $2, updated_at = now() FROM inbox_sources s")) {
    const c = visible().find((x) => x.id === params[0]);
    if (c !== undefined) {
      c.project_id = params[1] as string;
      c.updated_seq = ++db.seq;
    }
    return c === undefined ? { rows: [], rowCount: 0 } : { rows: [cols(c)], rowCount: 1 };
  }
  if (
    sql.startsWith(
      "UPDATE candidates c SET status = $2, resolved_spec_id = $3, updated_at = now() FROM inbox_sources s",
    )
  ) {
    const c = visible().find((x) => x.id === params[0]);
    if (c !== undefined) {
      c.status = params[1] as string;
      c.resolved_spec_id = params[2] as string | null;
      c.updated_seq = ++db.seq;
    }
    return c === undefined ? { rows: [], rowCount: 0 } : { rows: [cols(c)], rowCount: 1 };
  }
  if (
    /^SELECT .* FROM candidates c JOIN inbox_sources s .* WHERE c\.status = 'auto_routed' AND c\.resolved_spec_id IS NULL ORDER BY c\.updated_at ASC LIMIT \$1$/u.test(
      sql,
    )
  ) {
    const limit = params[0] as number;
    const rows = visible()
      .filter((c) => c.status === "auto_routed" && c.resolved_spec_id === null)
      .sort((a, b) => a.updated_seq - b.updated_seq)
      .slice(0, limit)
      .map((c) => cols(c));
    return { rows, rowCount: rows.length };
  }
  return undefined;
}

export function webhookEventSql(
  db: ForgeRecoveryDb,
  orgId: string,
  sql: string,
  params: readonly unknown[],
): QueryResult | undefined {
  const visible = (): WebhookEventRec[] => db.webhookEvents.filter((e) => e.org_id === orgId);
  if (sql.startsWith("INSERT INTO webhook_events")) {
    const [id, sourceId, ownOrgId, eventType, deliveryId, payloadJson] = params as [
      string,
      string,
      string,
      string,
      string | null,
      string,
    ];
    const rec: WebhookEventRec = {
      id,
      source_id: sourceId,
      org_id: ownOrgId,
      event_type: eventType,
      delivery_id: deliveryId,
      payload: JSON.parse(payloadJson),
      status: "received",
      attempts: 0,
      last_error: null,
      seq: ++db.seq,
    };
    db.webhookEvents.push(rec);
    return { rows: [webhookEventCols(rec)], rowCount: 1 };
  }
  if (
    /^SELECT .* FROM webhook_events WHERE status IN \('received','failed'\) ORDER BY created_at ASC LIMIT \$1$/u.test(
      sql,
    )
  ) {
    const limit = params[0] as number;
    const rows = visible()
      .filter((e) => e.status === "received" || e.status === "failed")
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map((e) => webhookEventCols(e));
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith("UPDATE webhook_events SET status = 'processed'")) {
    const e = visible().find((x) => x.id === params[0]);
    if (e !== undefined) {
      e.status = "processed";
      e.last_error = null;
    }
    return { rows: [], rowCount: e ? 1 : 0 };
  }
  if (sql.startsWith("UPDATE webhook_events SET attempts = attempts + 1")) {
    // Mirror the store: status is set by the failure's NATURE (the `poison` boolean),
    // NOT a count — transient stays `failed` (re-driven UNBOUNDED), poison dead-letters.
    const [id, error, poison] = params as [string, string, boolean];
    const e = visible().find((x) => x.id === id);
    if (e === undefined) return { rows: [], rowCount: 0 };
    e.attempts += 1;
    e.last_error = error;
    e.status = poison ? "dead_lettered" : "failed";
    return { rows: [{ status: e.status }], rowCount: 1 };
  }
  return undefined;
}
