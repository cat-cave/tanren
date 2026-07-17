import { createHash } from "node:crypto";
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { PgEventStore } from "../eventStore.js";
import { InboxStore, type InboxSource } from "./inbox/index.js";
import {
  IssueLoopStore,
  type IssueLoopRow,
  type IssueLoopSeverity,
  type SourceFindingRow,
} from "../repositories/issueLoops.js";
import {
  SourceSyncOutboxStore,
  type SourceSyncOperation,
  type SourceSyncOutboxRow,
} from "../repositories/sourceSyncOutbox.js";

export type IssueObservationStatus = "open" | "closed" | "reopened" | "edited" | "deleted" | "unknown";
export type IssueObservationSeverity = "info" | "warn" | "fail";

export interface IssueObservation {
  orgId: string;
  sourceId: string;
  projectId?: string;
  externalKey: string;
  providerObjectId: string;
  providerRevision: string;
  status: IssueObservationStatus;
  severity: IssueObservationSeverity;
  title: string;
  body?: string;
  observedAt?: Date;
  deliveryId?: string | null;
  context?: Record<string, unknown>;
}

export interface IssueSourceIngestResult {
  loop: IssueLoopRow;
  finding: SourceFindingRow;
  findingInserted: boolean;
  externalClose: SourceSyncOutboxRow | null;
}

export interface SourceSyncRequest {
  outbox: SourceSyncOutboxRow;
  source: InboxSource;
  loop: IssueLoopRow;
}

export interface SourceSyncReceipt {
  providerRevision: string;
}

export interface SourceSyncReadback {
  providerRevision: string;
  desiredState: "open" | "closed" | "comment_recorded";
}

export interface IssueSourceAdapter {
  readonly provider: string;
  ingest(pool: pg.Pool, observation: IssueObservation): Promise<IssueSourceIngestResult>;
  sync(input: SourceSyncRequest): Promise<SourceSyncReceipt>;
  readback(input: SourceSyncRequest): Promise<SourceSyncReadback>;
}

export class IssueSourceProjectRequiredError extends Error {
  constructor(sourceId: string) {
    super(`issue source ${sourceId} must be bound to a project before recording a finding`);
    this.name = "IssueSourceProjectRequiredError";
  }
}

export class IssueSourceLineageError extends Error {
  constructor() {
    super("issue observation does not match its org or source project");
    this.name = "IssueSourceLineageError";
  }
}

function loopSeverity(severity: IssueObservationSeverity): IssueLoopSeverity {
  if (severity === "fail") return "high";
  if (severity === "warn") return "medium";
  return "info";
}

function fingerprint(input: IssueObservation): string {
  const source = { body: input.body ?? "", severity: input.severity, title: input.title };
  return `sha256:${createHash("sha256").update(JSON.stringify(source), "utf8").digest("hex")}`;
}

function sourceRevisionHash(providerRevision: string): string {
  return `sha256:${createHash("sha256").update(providerRevision, "utf8").digest("hex")}`;
}

async function sourceFor(client: pg.PoolClient, input: IssueObservation): Promise<InboxSource> {
  const source = await InboxStore.getSourceForIntake(client, input.sourceId, input.orgId);
  if (source === undefined) throw new IssueSourceLineageError();
  if (source.projectId !== null && input.projectId !== undefined && source.projectId !== input.projectId) {
    throw new IssueSourceLineageError();
  }
  return source;
}

async function recordObservation(client: pg.PoolClient, source: InboxSource, input: IssueObservation) {
  const projectId = input.projectId ?? source.projectId;
  if (projectId === null || projectId === undefined) throw new IssueSourceProjectRequiredError(source.id);
  const observedAt = input.observedAt ?? new Date();
  const fp = fingerprint(input);
  const loopResult = await IssueLoopStore.upsertForSource(client, {
    orgId: input.orgId,
    projectId,
    sourceId: source.id,
    externalKey: input.externalKey,
    fingerprint: fp,
    severity: loopSeverity(input.severity),
    sourceRevisionId: input.providerRevision,
  });
  const loop = loopResult.loop;
  const append = await IssueLoopStore.appendFindingIfAbsent(client, {
    orgId: input.orgId,
    projectId,
    issueLoopId: loop.id,
    sourceId: source.id,
    providerObjectId: input.providerObjectId,
    providerRevision: input.providerRevision,
    status: input.status,
    title: input.title,
    body: input.body,
    fingerprint: fp,
    observedAt,
    deliveryId: input.deliveryId,
    context: input.context,
  });
  const events = new PgEventStore(client);
  if (append.inserted) {
    await events.append({
      orgId: input.orgId,
      projectId,
      eventType: "source.finding.recorded",
      payload: {
        projectId,
        issueLoopId: loop.id,
        sourceFindingId: append.finding.id,
        sourceId: source.id,
        providerRevision: input.providerRevision,
      },
    });
    if (loopResult.created) {
      await events.append({
        orgId: input.orgId,
        projectId,
        eventType: "issue_loop.opened",
        payload: { projectId, issueLoopId: loop.id, sourceFindingId: append.finding.id },
      });
    }
    await events.append({
      orgId: input.orgId,
      projectId,
      eventType: "issue_loop.source_revision_observed",
      payload: {
        projectId,
        issueLoopId: loop.id,
        sourceFindingId: append.finding.id,
        sourceRevisionHash: sourceRevisionHash(input.providerRevision),
      },
    });
  }
  let externalClose: SourceSyncOutboxRow | null = null;
  let observedLoop = loop;
  if (input.status === "closed" && append.inserted && loop.state !== "verified_closed") {
    const superseded = await SourceSyncOutboxStore.supersedeCloseSyncsForExternalClose(client, input.orgId, loop.id);
    const reopenedSync = await SourceSyncOutboxStore.enqueueWithOutcome(client, {
      orgId: input.orgId,
      issueLoopId: loop.id,
      sourceId: source.id,
      operation: "reopen",
      payload: { desiredState: "open", observedRevision: input.providerRevision },
    });
    const external = await IssueLoopStore.markExternallyClosedUnverified(client, input.orgId, projectId, loop.id);
    const reopened = await IssueLoopStore.transition(client, {
      orgId: input.orgId,
      projectId,
      issueLoopId: loop.id,
      toState: "open",
      fromStates: ["externally_closed_unverified", "verified_source_sync_pending"],
    });
    observedLoop = reopened?.loop ?? external?.loop ?? loop;
    externalClose = reopenedSync.row;
    if (external?.changed) {
      const sourceSyncOutboxId = superseded[0]?.id ?? reopenedSync.row.id;
      await events.append({
        orgId: input.orgId,
        projectId,
        eventType: "source.sync.externally_closed_unverified",
        payload: {
          issueLoopId: loop.id,
          outboxId: sourceSyncOutboxId,
          sourceId: source.id,
          observedRevision: input.providerRevision,
        },
      });
      await events.append({
        orgId: input.orgId,
        projectId,
        eventType: "source_issue.sync.drifted",
        payload: {
          projectId,
          issueLoopId: loop.id,
          sourceSyncOutboxId,
          observedRevisionHash: sourceRevisionHash(input.providerRevision),
        },
      });
    }
    if (reopenedSync.inserted) {
      await events.append({
        orgId: input.orgId,
        projectId,
        eventType: "source_issue.sync.enqueued",
        payload: { projectId, issueLoopId: loop.id, sourceSyncOutboxId: reopenedSync.row.id, attempt: 0 },
      });
    }
    if (reopened?.changed) {
      await events.append({
        orgId: input.orgId,
        projectId,
        eventType: "issue_loop.reopened",
        payload: { projectId, issueLoopId: loop.id, sourceFindingId: append.finding.id },
      });
    }
  }
  return { loop: observedLoop, finding: append.finding, findingInserted: append.inserted, externalClose };
}

export async function ingestIssueObservation(pool: pg.Pool, input: IssueObservation): Promise<IssueSourceIngestResult> {
  return runWithOrgScope(pool, input.orgId, async (client) => {
    const source = await sourceFor(client, input);
    return recordObservation(client, source, input);
  });
}

export class ManualIssueSourceAdapter implements IssueSourceAdapter {
  readonly provider = "manual";

  ingest(pool: pg.Pool, observation: IssueObservation): Promise<IssueSourceIngestResult> {
    return ingestIssueObservation(pool, observation);
  }

  async sync(input: SourceSyncRequest): Promise<SourceSyncReceipt> {
    return { providerRevision: input.outbox.payloadHash };
  }

  async readback(input: SourceSyncRequest): Promise<SourceSyncReadback> {
    const desiredState = manualDesiredState(input.outbox.operation);
    return { providerRevision: input.outbox.payloadHash, desiredState };
  }
}

function manualDesiredState(operation: SourceSyncOperation): SourceSyncReadback["desiredState"] {
  if (operation === "close") return "closed";
  if (operation === "reopen") return "open";
  return "comment_recorded";
}
