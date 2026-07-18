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
    // Match the INSERT ... SELECT gate exactly: a caller may persist only through
    // its own, enabled, active source, and a project-bound source must still point
    // at a project in the same org. A failed INSERT deliberately returns no row so
    // the store can perform its duplicate-delivery lookup before throwing lineage.
    const source = db.inboxSources.find((s) => s.id === sourceId && s.org_id === ownOrgId && s.org_id === orgId);
    const sourceIsValid =
      source !== undefined &&
      source.enabled === "true" &&
      source.state === "active" &&
      (source.project_id === null ||
        db.projects.some((p) => p.project_id === source.project_id && p.org_id === source.org_id));
    if (!sourceIsValid) return { rows: [], rowCount: 0 };

    // The production partial unique index applies only to non-null delivery IDs.
    // `ON CONFLICT DO NOTHING` returns no row; persistWithOutcome then SELECTs the
    // existing delivery below.
    if (
      deliveryId !== null &&
      db.webhookEvents.some(
        (e) =>
          e.org_id === ownOrgId && e.source_id === sourceId && e.provider === provider && e.delivery_id === deliveryId,
      )
    ) {
      return { rows: [], rowCount: 0 };
    }
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
    /^SELECT .* FROM webhook_events WHERE org_id = \$1 AND source_id = \$2 AND provider = \$3 AND delivery_id = \$4 LIMIT 1$/u.test(
      sql,
    )
  ) {
    const [eventOrgId, sourceId, provider, deliveryId] = params as [string, string, string, string];
    const event = visible().find(
      (e) =>
        e.org_id === eventOrgId && e.source_id === sourceId && e.provider === provider && e.delivery_id === deliveryId,
    );
    return event === undefined ? { rows: [], rowCount: 0 } : { rows: [webhookEventCols(event)], rowCount: 1 };
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
  if (sql.startsWith("UPDATE webhook_events SET claim_owner = $2,")) {
    const [id, workerId, leaseMs] = params as [string, string, number];
    const event = visible().find(
      (e) =>
        e.id === id &&
        ["received", "failed"].includes(e.status) &&
        (e.claim_owner === null ||
          (e.claim_expires_at !== null && new Date(e.claim_expires_at).getTime() <= Date.now())),
    );
    if (event === undefined) return { rows: [], rowCount: 0 };
    event.claim_owner = workerId;
    event.claim_expires_at = new Date(Date.now() + leaseMs).toISOString();
    return { rows: [webhookEventCols(event)], rowCount: 1 };
  }
  if (sql.startsWith("UPDATE webhook_events SET status = 'processed'")) {
    const [id, workerId] = params as [string, string | null];
    const e = visible().find(
      (x) =>
        x.id === id && ["received", "failed"].includes(x.status) && (workerId === null || x.claim_owner === workerId),
    );
    if (e !== undefined) {
      e.status = "processed";
      e.last_error = null;
      e.claim_owner = null;
      e.claim_expires_at = null;
    }
    return { rows: [], rowCount: e ? 1 : 0 };
  }
  if (sql.startsWith("UPDATE webhook_events SET claim_owner = NULL, claim_expires_at = NULL")) {
    const [id, workerId] = params as [string, string];
    const e = visible().find((x) => x.id === id && x.claim_owner === workerId);
    if (e !== undefined) {
      e.claim_owner = null;
      e.claim_expires_at = null;
    }
    return { rows: [], rowCount: e ? 1 : 0 };
  }
  if (sql.startsWith("UPDATE webhook_events SET attempts = attempts + 1")) {
    // Mirror the store: status is set by the failure's NATURE (the `poison` boolean),
    // NOT a count — transient stays `failed` (re-driven UNBOUNDED), poison dead-letters.
    const [id, error, poison, workerId] = params as [string, string, boolean, string | null];
    const e = visible().find((x) => x.id === id && (workerId === null || x.claim_owner === workerId));
    if (e === undefined) return { rows: [], rowCount: 0 };
    e.attempts += 1;
    e.last_error = error;
    e.status = poison ? "dead_lettered" : "failed";
    e.claim_owner = null;
    e.claim_expires_at = null;
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
  if (sql.startsWith("SELECT 1 FROM resolution_decisions AS decision")) {
    const [decisionOrgId, decisionId, issueLoopId, sourceId] = params as [string, string, string, string];
    const authorized =
      decisionOrgId === orgId && decisionId === "rdec_authorized" && issueLoopId === "loop_a" && sourceId === "src_a";
    return authorized ? { rows: [{ "?column?": 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (sql.startsWith("INSERT INTO source_sync_outbox")) {
    const [ownOrgId, id, issueLoopId, sourceId, operation, payload, payloadHash, resolutionDecisionId] = params as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string | null,
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
      payload: JSON.parse(payload),
      payload_hash: payloadHash,
      resolution_decision_id: resolutionDecisionId,
      attempt: 0,
      next_attempt_at: new Date("2026-03-01T00:00:00.000Z"),
      provider_receipt: null,
      readback: null,
      last_error: null,
      claim_owner: null,
      claim_expires_at: null,
      created_at: new Date("2026-03-01T00:00:00.000Z"),
      updated_at: new Date("2026-03-01T00:00:00.000Z"),
      seq: ++db.seq,
    };
    db.sourceSyncOutbox.push(rec);
    return { rows: [sourceSyncOutboxCols(rec)], rowCount: 1 };
  }
  if (sql.startsWith("SELECT org_id, id, issue_loop_id, source_id, operation, state, payload, payload_hash")) {
    const row = visible().find((candidate) => candidate.id === params[1]);
    return row === undefined ? { rows: [], rowCount: 0 } : { rows: [sourceSyncOutboxCols(row)], rowCount: 1 };
  }
  if (/^SELECT .* FROM source_sync_outbox WHERE state IN \('pending','sent'\)/u.test(sql)) {
    const limit = params[0] as number;
    const rows = visible()
      .filter(
        (row) =>
          ["pending", "sent"].includes(row.state) &&
          new Date(row.next_attempt_at).getTime() <= Date.now() &&
          (row.claim_owner === null ||
            (row.claim_expires_at !== null && new Date(row.claim_expires_at).getTime() <= Date.now())),
      )
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map((row) => sourceSyncOutboxCols(row));
    return { rows, rowCount: rows.length };
  }
  if (
    sql ===
    "SELECT DISTINCT org_id FROM source_sync_outbox WHERE state IN ('pending','sent') AND next_attempt_at <= now()"
  ) {
    const rows = [
      ...new Set(
        visible()
          .filter((row) => new Date(row.next_attempt_at).getTime() <= Date.now())
          .map((row) => row.org_id),
      ),
    ].map((id) => ({ org_id: id }));
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith("UPDATE source_sync_outbox") && sql.includes("SET claim_owner = $3")) {
    const row = visible().find((candidate) => candidate.id === params[1]);
    const claimable =
      row !== undefined &&
      ["pending", "sent"].includes(row.state) &&
      new Date(row.next_attempt_at).getTime() <= Date.now() &&
      (row.claim_owner === null ||
        (row.claim_expires_at !== null && new Date(row.claim_expires_at).getTime() <= Date.now()));
    if (!claimable || row === undefined) return { rows: [], rowCount: 0 };
    row.claim_owner = params[2] as string;
    row.claim_expires_at = new Date(Date.now() + Number(params[3])).toISOString();
    // This is the real store's RETURNING projection. Returning no row while
    // rowCount=1 makes `SourceSyncOutboxStore.claim()` report undefined.
    return { rows: [sourceSyncOutboxCols(row)], rowCount: 1 };
  }
  if (sql.startsWith("WITH candidate AS") && sql.includes("UPDATE source_sync_outbox AS outbox")) {
    const row = visible().find(
      (candidate) =>
        ["pending", "sent"].includes(candidate.state) &&
        new Date(candidate.next_attempt_at).getTime() <= Date.now() &&
        (candidate.claim_owner === null ||
          (candidate.claim_expires_at !== null && new Date(candidate.claim_expires_at).getTime() <= Date.now())),
    );
    if (row === undefined) return { rows: [], rowCount: 0 };
    row.claim_owner = params[1] as string;
    row.claim_expires_at = new Date(Date.now() + Number(params[2])).toISOString();
    return { rows: [sourceSyncOutboxCols(row)], rowCount: 1 };
  }
  if (sql.startsWith("UPDATE source_sync_outbox") && sql.includes("SET state = 'sent', attempt = attempt + 1")) {
    const row = visible().find(
      (candidate) =>
        candidate.id === params[1] &&
        ["pending", "sent"].includes(candidate.state) &&
        candidate.claim_owner === params[2],
    );
    if (row !== undefined) {
      row.state = "sent";
      row.attempt += 1;
      row.last_error = null;
    }
    return { rows: row === undefined ? [] : [sourceSyncOutboxCols(row)], rowCount: row === undefined ? 0 : 1 };
  }
  if (sql.startsWith("UPDATE source_sync_outbox") && sql.includes("SET provider_receipt = $4::jsonb")) {
    const row = visible().find(
      (candidate) => candidate.id === params[1] && candidate.state === "sent" && candidate.claim_owner === params[2],
    );
    if (row !== undefined) row.provider_receipt = JSON.parse(params[3] as string);
    return { rows: [], rowCount: row === undefined ? 0 : 1 };
  }
  if (sql.startsWith("UPDATE source_sync_outbox") && sql.includes("state = 'verified'")) {
    const row = visible().find(
      (candidate) =>
        candidate.id === params[1] &&
        candidate.state === "sent" &&
        candidate.claim_owner === params[2] &&
        candidate.provider_receipt !== null,
    );
    if (row !== undefined) {
      row.state = "verified";
      row.readback = JSON.parse(params[3] as string);
      row.claim_owner = null;
      row.claim_expires_at = null;
    }
    return { rows: [], rowCount: row === undefined ? 0 : 1 };
  }
  if (sql.startsWith("UPDATE source_sync_outbox") && sql.includes("SET claim_owner = NULL")) {
    const row = visible().find(
      (candidate) =>
        candidate.id === params[1] &&
        ["pending", "sent"].includes(candidate.state) &&
        candidate.claim_owner === params[2],
    );
    if (row !== undefined) {
      row.claim_owner = null;
      row.claim_expires_at = null;
    }
    return { rows: [], rowCount: row === undefined ? 0 : 1 };
  }
  if (sql.startsWith("UPDATE source_sync_outbox") && sql.includes("WHERE org_id = $1 AND issue_loop_id = $2")) {
    const rows = visible().filter(
      (candidate) =>
        candidate.issue_loop_id === params[1] &&
        candidate.operation === "close" &&
        ["pending", "sent"].includes(candidate.state),
    );
    for (const row of rows) {
      row.state = "externally_closed_unverified";
      row.claim_owner = null;
      row.claim_expires_at = null;
    }
    return { rows: [], rowCount: rows.length };
  }
  return undefined;
}
