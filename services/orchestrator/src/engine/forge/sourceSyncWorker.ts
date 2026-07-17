import { randomUUID } from "node:crypto";
import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { PgEventStore } from "../eventStore.js";
import { InboxStore, type InboxSource } from "./inbox/index.js";
import { IssueLoopStore, type IssueLoopRow } from "../repositories/issueLoops.js";
import { SourceSyncOutboxStore, type SourceSyncOutboxRow } from "../repositories/sourceSyncOutbox.js";
import type { IssueSourceAdapter } from "./issueSourceAdapter.js";

export interface SourceSyncWorkerDeps {
  pool: pg.Pool;
  adapters: ReadonlyMap<string, IssueSourceAdapter>;
  workerId?: string;
  claimLeaseMs?: number;
}

export interface SourceSyncProcessResult {
  outbox: SourceSyncOutboxRow;
  verified: boolean;
}

interface WorkContext {
  outbox: SourceSyncOutboxRow;
  source: InboxSource;
  loop: IssueLoopRow;
}

async function loadWork(client: pg.PoolClient, outbox: SourceSyncOutboxRow): Promise<WorkContext | undefined> {
  const source = await InboxStore.getSourceForIntake(client, outbox.sourceId, outbox.orgId);
  const loop = await IssueLoopStore.getById(client, outbox.orgId, outbox.issueLoopId);
  return source === undefined || loop === undefined ? undefined : { outbox, source, loop };
}

export async function processSourceSync(
  deps: SourceSyncWorkerDeps,
  row: SourceSyncOutboxRow,
): Promise<SourceSyncProcessResult | undefined> {
  const workerId = deps.workerId ?? `source-sync-${randomUUID()}`;
  const claimed = await runWithOrgScope(deps.pool, row.orgId, (client) =>
    SourceSyncOutboxStore.claim(client, {
      id: row.id,
      workerId,
      leaseMs: deps.claimLeaseMs ?? 5 * 60_000,
    }),
  );
  if (claimed === undefined) return undefined;
  let context: WorkContext | undefined;
  try {
    context = await runWithOrgScope(deps.pool, row.orgId, (client) => loadWork(client, claimed));
  } catch {
    await runWithOrgScope(deps.pool, row.orgId, (client) => SourceSyncOutboxStore.release(client, row.id, workerId));
    return { outbox: claimed, verified: false };
  }
  const adapter = context === undefined ? undefined : deps.adapters.get(context.source.kind);
  if (context === undefined || adapter === undefined) {
    await runWithOrgScope(deps.pool, row.orgId, (client) => SourceSyncOutboxStore.release(client, row.id, workerId));
    return { outbox: claimed, verified: false };
  }
  const sent =
    claimed.state === "sent" ||
    (await runWithOrgScope(deps.pool, row.orgId, (client) => SourceSyncOutboxStore.markSent(client, row.id, workerId)));
  if (!sent) {
    await runWithOrgScope(deps.pool, row.orgId, (client) => SourceSyncOutboxStore.release(client, row.id, workerId));
    return { outbox: claimed, verified: false };
  }
  try {
    await adapter.sync(context);
  } catch {
    await runWithOrgScope(deps.pool, row.orgId, (client) => SourceSyncOutboxStore.release(client, row.id, workerId));
    return { outbox: claimed, verified: false };
  }
  const verified = await runWithOrgScope(deps.pool, row.orgId, async (client) => {
    const marked = await SourceSyncOutboxStore.markVerified(client, row.id, workerId);
    if (!marked) return false;
    const transitioned = await IssueLoopStore.markSourceSyncVerified(
      client,
      context.loop.orgId,
      context.loop.projectId,
      context.loop.id,
    );
    if (transitioned?.changed) {
      await new PgEventStore(client).append({
        orgId: context.loop.orgId,
        eventType: "source.sync.verified",
        payload: {
          issueLoopId: context.loop.id,
          outboxId: row.id,
          sourceId: row.sourceId,
          operation: row.operation,
          payloadHash: row.payloadHash,
        },
      });
    }
    return true;
  });
  return { outbox: { ...claimed, state: verified ? "verified" : claimed.state }, verified };
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
