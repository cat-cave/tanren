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
  sourceSyncPayloadHash,
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

export interface IssueSourceAdapter {
  readonly provider: string;
  ingest(pool: pg.Pool, observation: IssueObservation): Promise<IssueSourceIngestResult>;
  sync(input: SourceSyncRequest): Promise<SourceSyncReceipt>;
}

export interface ResolutionTransitionInput {
  orgId: string;
  projectId: string;
  issueLoopId: string;
  sourceId: string;
  externalKey: string;
}

export interface ResolutionTransitionResult {
  loop: IssueLoopRow;
  outbox: SourceSyncOutboxRow;
  changed: boolean;
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

function syncPayload(input: ResolutionTransitionInput): Record<string, string> {
  return { externalKey: input.externalKey, desiredState: "closed" };
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
    const payload = { externalKey: input.externalKey, observedRevision: input.providerRevision };
    const queued = await SourceSyncOutboxStore.enqueueWithOutcome(client, {
      orgId: input.orgId,
      issueLoopId: loop.id,
      sourceId: source.id,
      operation: "close",
      payload,
    });
    // A provider-side close is authoritative enough to stop EVERY live close
    // request for this loop. In particular, an already-sent sibling must not be
    // able to acquire/retain a lease and later transition the loop to verified.
    // This stays in the observation transaction with the loop transition.
    await SourceSyncOutboxStore.supersedeCloseSyncsForExternalClose(client, loop.id);
    const external = await IssueLoopStore.markExternallyClosedUnverified(client, input.orgId, projectId, loop.id);
    observedLoop = external?.loop ?? loop;
    externalClose = { ...queued.row, state: "externally_closed_unverified" };
    if (external?.changed && queued.row.state !== "externally_closed_unverified") {
      await events.append({
        orgId: input.orgId,
        projectId,
        eventType: "source.sync.externally_closed_unverified",
        payload: {
          issueLoopId: loop.id,
          outboxId: queued.row.id,
          sourceId: source.id,
          observedRevision: input.providerRevision,
        },
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

export async function enqueueResolutionSync(
  pool: pg.Pool,
  input: ResolutionTransitionInput,
): Promise<ResolutionTransitionResult> {
  return runWithOrgScope(pool, input.orgId, async (client) => {
    const transitioned = await IssueLoopStore.transition(client, {
      orgId: input.orgId,
      projectId: input.projectId,
      issueLoopId: input.issueLoopId,
      toState: "verified_source_sync_pending",
    });
    if (transitioned === undefined) throw new IssueSourceLineageError();
    const payload = syncPayload(input);
    const queued = await SourceSyncOutboxStore.enqueueWithOutcome(client, {
      orgId: input.orgId,
      issueLoopId: input.issueLoopId,
      sourceId: input.sourceId,
      operation: "close",
      payload,
    });
    if (queued.inserted) {
      await new PgEventStore(client).append({
        orgId: input.orgId,
        eventType: "source.sync.pending",
        payload: {
          issueLoopId: input.issueLoopId,
          outboxId: queued.row.id,
          sourceId: input.sourceId,
          operation: "close",
          payloadHash: sourceSyncPayloadHash({
            orgId: input.orgId,
            issueLoopId: input.issueLoopId,
            sourceId: input.sourceId,
            operation: "close",
            payload,
          }),
        },
      });
    }
    return { loop: transitioned.loop, outbox: queued.row, changed: transitioned.changed };
  });
}

export class ManualIssueSourceAdapter implements IssueSourceAdapter {
  readonly provider = "manual";

  ingest(pool: pg.Pool, observation: IssueObservation): Promise<IssueSourceIngestResult> {
    return ingestIssueObservation(pool, observation);
  }

  async sync(input: SourceSyncRequest): Promise<SourceSyncReceipt> {
    if (input.outbox.operation !== "close")
      throw new Error(`unsupported manual source sync operation: ${input.outbox.operation}`);
    return { providerRevision: input.outbox.payloadHash };
  }
}
