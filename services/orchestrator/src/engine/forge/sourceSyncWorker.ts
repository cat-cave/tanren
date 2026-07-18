import { randomUUID } from "node:crypto";
import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { PgEventStore } from "../eventStore.js";
import { InboxStore, type InboxSource } from "./inbox/index.js";
import { IssueLoopStore, type IssueLoopRow } from "../repositories/issueLoops.js";
import { SourceSyncOutboxStore, type SourceSyncOutboxRow } from "../repositories/sourceSyncOutbox.js";
import type { IssueSourceAdapter, SourceSyncReadback, SourceSyncReceipt } from "./issueSourceAdapter.js";

const DEFAULT_SOURCE_SYNC_LEASE_MS = 5 * 60_000;
const DEFAULT_SOURCE_SYNC_RETRY_MS = 30_000;
const DEFAULT_SOURCE_SYNC_SCAN_INTERVAL_MS = 30_000;

export interface SourceSyncWorkerDeps {
  pool: pg.Pool;
  adapters: ReadonlyMap<string, IssueSourceAdapter>;
  workerId?: string;
  claimLeaseMs?: number;
  retryMs?: number;
}

export interface SourceSyncProcessResult {
  outbox: SourceSyncOutboxRow;
  verified: boolean;
}

export interface SourceSyncWorkerOptions {
  scanIntervalMs?: number;
  batchSize?: number;
}

interface WorkContext {
  outbox: SourceSyncOutboxRow;
  source: InboxSource;
  loop: IssueLoopRow;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readbackMatches(outbox: SourceSyncOutboxRow, readback: SourceSyncReadback): boolean {
  if (outbox.operation === "close") return readback.desiredState === "closed";
  if (outbox.operation === "reopen") return readback.desiredState === "open";
  return readback.desiredState === "comment_recorded";
}

function receiptRecord(receipt: SourceSyncReceipt): Record<string, unknown> {
  return { providerRevision: receipt.providerRevision };
}

function readbackRecord(readback: SourceSyncReadback): Record<string, unknown> {
  return { providerRevision: readback.providerRevision, desiredState: readback.desiredState };
}

function hasGenuineMutationReceipt(outbox: SourceSyncOutboxRow): boolean {
  return (
    outbox.providerReceipt !== null &&
    outbox.providerReceipt["reconciled"] !== true &&
    outbox.providerReceipt["reconciled"] !== "true"
  );
}

async function loadWork(client: pg.PoolClient, outbox: SourceSyncOutboxRow): Promise<WorkContext | undefined> {
  const source = await InboxStore.getSourceForIntake(client, outbox.sourceId, outbox.orgId);
  const loop = await IssueLoopStore.getById(client, outbox.orgId, outbox.issueLoopId);
  return source === undefined || loop === undefined ? undefined : { outbox, source, loop };
}

async function releaseFailure(
  deps: SourceSyncWorkerDeps,
  context: WorkContext,
  workerId: string,
  error: unknown,
  attempt: number,
): Promise<void> {
  if (attempt <= 0) {
    await runWithOrgScope(deps.pool, context.outbox.orgId, (client) =>
      SourceSyncOutboxStore.release(client, { orgId: context.outbox.orgId, id: context.outbox.id, workerId }),
    );
    return;
  }
  await runWithOrgScope(deps.pool, context.outbox.orgId, async (client) => {
    const released = await SourceSyncOutboxStore.releaseFailure(client, {
      orgId: context.outbox.orgId,
      id: context.outbox.id,
      workerId,
      error: errorText(error),
      retryMs: deps.retryMs ?? DEFAULT_SOURCE_SYNC_RETRY_MS,
    });
    if (!released) return;
    await new PgEventStore(client).append({
      orgId: context.loop.orgId,
      projectId: context.loop.projectId,
      eventType: "source_issue.sync.failed",
      payload: {
        projectId: context.loop.projectId,
        issueLoopId: context.loop.id,
        sourceSyncOutboxId: context.outbox.id,
        attempt,
      },
    });
  });
}

async function completeSync(
  deps: SourceSyncWorkerDeps,
  context: WorkContext,
  workerId: string,
  readback: SourceSyncReadback,
): Promise<boolean> {
  return runWithOrgScope(deps.pool, context.outbox.orgId, async (client) => {
    let loopChanged = false;
    if (context.outbox.operation === "close") {
      const transitioned = await IssueLoopStore.markSourceSyncVerified(
        client,
        context.loop.orgId,
        context.loop.projectId,
        context.loop.id,
      );
      if (transitioned === undefined || (!transitioned.changed && transitioned.loop.state !== "verified_closed"))
        return false;
      loopChanged = transitioned.changed;
    }
    const verified = await SourceSyncOutboxStore.markVerified(client, {
      orgId: context.outbox.orgId,
      id: context.outbox.id,
      workerId,
      readback: readbackRecord(readback),
    });
    if (!verified) throw new Error(`source sync ${context.outbox.id} lost its lease before verification`);
    const events = new PgEventStore(client);
    await events.append({
      orgId: context.loop.orgId,
      projectId: context.loop.projectId,
      eventType: "source_issue.sync.succeeded",
      payload: {
        projectId: context.loop.projectId,
        issueLoopId: context.loop.id,
        sourceSyncOutboxId: context.outbox.id,
        attempt: context.outbox.attempt,
      },
    });
    if (loopChanged) {
      const decision = await client.query<{ resolution_job_id: string; id: string }>(
        `SELECT id, resolution_job_id
           FROM resolution_decisions
          WHERE org_id = $1 AND id = $2 AND issue_loop_id = $3 AND decision IN ('authorized', 'waived')`,
        [context.loop.orgId, context.outbox.resolutionDecisionId, context.loop.id],
      );
      const row = decision.rows[0];
      if (row === undefined) throw new Error(`verified source sync ${context.outbox.id} has no authority decision`);
      await events.append({
        orgId: context.loop.orgId,
        projectId: context.loop.projectId,
        eventType: "issue_loop.verified",
        payload: {
          projectId: context.loop.projectId,
          issueLoopId: context.loop.id,
          resolutionJobId: row.resolution_job_id,
          resolutionDecisionId: row.id,
        },
      });
    }
    return true;
  });
}

function startLeaseHeartbeat(
  deps: SourceSyncWorkerDeps,
  outbox: SourceSyncOutboxRow,
  workerId: string,
  leaseMs: number,
): { stop(): void } {
  let stopped = false;
  let renewing = false;
  const renew = async (): Promise<void> => {
    if (stopped || renewing) return;
    renewing = true;
    try {
      const renewed = await runWithOrgScope(deps.pool, outbox.orgId, (client) =>
        SourceSyncOutboxStore.renewClaim(client, { orgId: outbox.orgId, id: outbox.id, workerId, leaseMs }),
      );
      if (!renewed) stopped = true;
    } finally {
      renewing = false;
    }
  };
  const interval = setInterval(() => void renew(), Math.max(1, Math.floor(leaseMs / 3)));
  interval.unref?.();
  return {
    stop(): void {
      stopped = true;
      clearInterval(interval);
    },
  };
}

export async function processSourceSync(
  deps: SourceSyncWorkerDeps,
  row: SourceSyncOutboxRow,
): Promise<SourceSyncProcessResult | undefined> {
  const workerId = deps.workerId ?? `source-sync-${randomUUID()}`;
  const leaseMs = deps.claimLeaseMs ?? DEFAULT_SOURCE_SYNC_LEASE_MS;
  const claimed = await runWithOrgScope(deps.pool, row.orgId, (client) =>
    SourceSyncOutboxStore.claim(client, {
      orgId: row.orgId,
      id: row.id,
      workerId,
      leaseMs,
    }),
  );
  if (claimed === undefined) return undefined;
  const heartbeat = startLeaseHeartbeat(deps, claimed, workerId, leaseMs);
  let context: WorkContext | undefined;
  try {
    context = await runWithOrgScope(deps.pool, row.orgId, (client) => loadWork(client, claimed));
  } catch {
    heartbeat.stop();
    await runWithOrgScope(deps.pool, row.orgId, (client) =>
      SourceSyncOutboxStore.release(client, { orgId: row.orgId, id: row.id, workerId }),
    );
    return { outbox: claimed, verified: false };
  }
  const adapter = context === undefined ? undefined : deps.adapters.get(context.source.kind);
  if (context === undefined || adapter === undefined) {
    heartbeat.stop();
    await runWithOrgScope(deps.pool, row.orgId, (client) =>
      SourceSyncOutboxStore.release(client, { orgId: row.orgId, id: row.id, workerId }),
    );
    return { outbox: claimed, verified: false };
  }

  let attempted = claimed;
  try {
    if (claimed.state === "sent" && hasGenuineMutationReceipt(claimed)) {
      const recoveredReadback = await adapter.readback(context);
      if (!readbackMatches(context.outbox, recoveredReadback))
        throw new Error(`source sync readback does not match ${claimed.operation}`);
      const verified = await completeSync(deps, context, workerId, recoveredReadback);
      return { outbox: { ...claimed, state: verified ? "verified" : claimed.state }, verified };
    }

    const begun = await runWithOrgScope(deps.pool, row.orgId, (client) =>
      SourceSyncOutboxStore.beginAttempt(client, { orgId: row.orgId, id: row.id, workerId }),
    );
    if (begun === undefined) return { outbox: claimed, verified: false };
    attempted = begun;
    const request = { ...context, outbox: begun };
    const receipt = await adapter.sync(request);
    const recorded = await runWithOrgScope(deps.pool, row.orgId, (client) =>
      SourceSyncOutboxStore.recordProviderReceipt(client, {
        orgId: row.orgId,
        id: row.id,
        workerId,
        receipt: receiptRecord(receipt),
      }),
    );
    if (!recorded) return { outbox: attempted, verified: false };
    const readback = await adapter.readback(request);
    if (!readbackMatches(begun, readback)) throw new Error(`source sync readback does not match ${begun.operation}`);
    const verified = await completeSync(deps, { ...context, outbox: begun }, workerId, readback);
    return { outbox: { ...begun, state: verified ? "verified" : begun.state }, verified };
  } catch (error) {
    await releaseFailure(deps, context, workerId, error, attempted.attempt);
    return { outbox: attempted, verified: false };
  } finally {
    heartbeat.stop();
  }
}

export async function sweepSourceSync(deps: SourceSyncWorkerDeps, limit = 20): Promise<number> {
  const orgIds = await runWithSystemScope(deps.pool, (client) =>
    SourceSyncOutboxStore.listDistinctRunnableOrgIds(client),
  );
  let count = 0;
  for (const orgId of orgIds) {
    const rows = await runWithOrgScope(deps.pool, orgId, (client) => SourceSyncOutboxStore.listRunnable(client, limit));
    for (const row of rows) {
      await processSourceSync(deps, row);
      count += 1;
    }
  }
  return count;
}

/** Live periodic worker: polling backs up every dropped wake and expired lease. */
export class SourceSyncWorker {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private readonly scanIntervalMs: number;
  private readonly batchSize: number;

  constructor(
    private readonly deps: SourceSyncWorkerDeps,
    options: SourceSyncWorkerOptions = {},
  ) {
    this.scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SOURCE_SYNC_SCAN_INTERVAL_MS;
    this.batchSize = options.batchSize ?? 20;
  }

  start(): void {
    if (this.timer !== undefined) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.scanIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      return await sweepSourceSync(this.deps, this.batchSize);
    } finally {
      this.ticking = false;
    }
  }
}
