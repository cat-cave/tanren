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
  sourceSyncOutboxCols,
  type SourceSyncOutboxRec,
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
    const [
      id,
      sourceId,
      ownOrgId,
      eventType,
      deliveryId,
      provider,
      payloadJson,
      canonicalPayloadHash,
      signatureAlgo,
      signatureKeyVersion,
      deliverySignedAt,
    ] = params as [
      string,
      string,
      string,
      string,
      string | null,
      string | null,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
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
      provider: provider ?? null,
      canonical_payload_hash: canonicalPayloadHash ?? null,
      signature_algo: signatureAlgo ?? null,
      signature_key_version: signatureKeyVersion ?? null,
      delivery_signed_at: deliverySignedAt ?? null,
      claim_owner: null,
      claim_expires_at: null,
      seq: ++db.seq,
    };
    db.webhookEvents.push(rec);
    return { rows: [webhookEventCols(rec)], rowCount: 1 };
  }
  if (
    /^SELECT .* FROM webhook_events WHERE status IN \('received','failed'\)( AND \(claim_owner IS NULL OR claim_expires_at <= now\(\)\))? ORDER BY created_at ASC LIMIT \$1$/u.test(
      sql,
    )
  ) {
    const limit = params[0] as number;
    const claimFiltered = /claim_owner IS NULL OR claim_expires_at <= now\(\)/u.test(sql);
    const rows = visible()
      .filter((e) => e.status === "received" || e.status === "failed")
      // bh-3 sweeper: an unclaimed or expired-claim row is undriven; a live claim is skipped.
      .filter(
        (e) =>
          !claimFiltered ||
          e.claim_owner === null ||
          (e.claim_expires_at !== null && e.claim_expires_at <= new Date().toISOString()),
      )
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

export function sourceSyncOutboxSql(
  db: ForgeRecoveryDb,
  orgId: string,
  sql: string,
  params: readonly unknown[],
): QueryResult | undefined {
  const visible = (): SourceSyncOutboxRec[] => db.sourceSyncOutbox.filter((row) => row.org_id === orgId);
  if (sql.startsWith("INSERT INTO source_sync_outbox")) {
    const [ownOrgId, id, issueLoopId, sourceId, operation, payloadHash] = params as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (db.sourceSyncOutbox.some((row) => row.org_id === ownOrgId && row.id === id)) {
      return { rows: [], rowCount: 0 };
    }
    const rec: SourceSyncOutboxRec = {
      org_id: ownOrgId,
      id,
      issue_loop_id: issueLoopId,
      source_id: sourceId,
      operation,
      state: "pending",
      payload_hash: payloadHash,
      claim_owner: null,
      claim_expires_at: null,
      created_at: new Date("2026-03-01T00:00:00.000Z"),
      seq: ++db.seq,
    };
    db.sourceSyncOutbox.push(rec);
    return { rows: [sourceSyncOutboxCols(rec)], rowCount: 1 };
  }
  if (sql.startsWith("SELECT org_id, id, issue_loop_id, source_id, operation, state, payload_hash")) {
    const row = visible().find((candidate) => candidate.id === params[0]);
    return row === undefined ? { rows: [], rowCount: 0 } : { rows: [sourceSyncOutboxCols(row)], rowCount: 1 };
  }
  if (/^SELECT .* FROM source_sync_outbox WHERE state IN \('pending','sent'\)/u.test(sql)) {
    const limit = params[0] as number;
    const rows = visible()
      .filter((row) => ["pending", "sent"].includes(row.state) && row.claim_owner === null)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map((row) => sourceSyncOutboxCols(row));
    return { rows, rowCount: rows.length };
  }
  if (sql === "SELECT DISTINCT org_id FROM source_sync_outbox WHERE state IN ('pending','sent')") {
    return { rows: [...new Set(visible().map((row) => ({ org_id: row.org_id })))], rowCount: visible().length };
  }
  if (sql.startsWith("UPDATE source_sync_outbox") && sql.includes("SET claim_owner = $2")) {
    const row = visible().find((candidate) => candidate.id === params[0]);
    if (row !== undefined) row.claim_owner = params[1] as string;
    return { rows: [], rowCount: row === undefined ? 0 : 1 };
  }
  if (sql.startsWith("UPDATE source_sync_outbox SET state = 'sent'")) {
    const row = visible().find((candidate) => candidate.id === params[0] && candidate.claim_owner === params[1]);
    if (row !== undefined) row.state = "sent";
    return { rows: [], rowCount: row === undefined ? 0 : 1 };
  }
  if (sql.startsWith("UPDATE source_sync_outbox") && sql.includes("state = 'verified'")) {
    const row = visible().find((candidate) => candidate.id === params[0] && candidate.claim_owner === params[1]);
    if (row !== undefined) {
      row.state = "verified";
      row.claim_owner = null;
    }
    return { rows: [], rowCount: row === undefined ? 0 : 1 };
  }
  if (sql.startsWith("UPDATE source_sync_outbox") && sql.includes("state = 'externally_closed_unverified'")) {
    const row = visible().find((candidate) => candidate.id === params[0]);
    if (row !== undefined && ["pending", "sent"].includes(row.state)) row.state = "externally_closed_unverified";
    return { rows: [], rowCount: row === undefined ? 0 : 1 };
  }
  return undefined;
}
