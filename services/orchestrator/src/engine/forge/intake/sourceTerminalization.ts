import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { PgEventStore } from "../../eventStore.js";
import { InboxSourceLifecycleStore } from "../../repositories/inboxSourceLifecycle.js";
import { InboxSourceAttention, type InboxSource } from "../inbox/types.js";

export interface PermanentSourceFailure {
  code: InboxSourceAttention["code"];
  message: string;
}

/**
 * The sole permanent-failure transition. The source CAS and canonical event append
 * share one org-scoped transaction, so neither state nor audit proof can land alone.
 */
export async function terminalizeInboxSource(
  pool: pg.Pool,
  source: { id: string; orgId: string; projectId: string | null },
  failure: PermanentSourceFailure,
  now: Date = new Date(),
): Promise<boolean> {
  const attention = InboxSourceAttention.parse({
    code: failure.code,
    message: failure.message,
    observedAt: now.toISOString(),
  });
  return runWithOrgScope(pool, source.orgId, async (client) => {
    const discardInvalidConfig = failure.code === "invalid_config" || failure.code === "unsupported_provider";
    const parked = await InboxSourceLifecycleStore.markNeedsAttention(client, source, attention, discardInvalidConfig);
    if (!parked) return false;
    await new PgEventStore(client).append({
      orgId: source.orgId,
      ...(source.projectId === null ? {} : { projectId: source.projectId }),
      eventType: "credential.failed",
      payload: { message: `inbox source ${source.id} needs attention (${failure.code})` },
    });
    return true;
  });
}

/** Persist a provider-directed delay; the serial poll loop never sleeps. */
export async function deferInboxSourceRetry(
  pool: pg.Pool,
  source: Pick<InboxSource, "id" | "orgId">,
  retryNotBefore: Date,
): Promise<boolean> {
  return runWithOrgScope(pool, source.orgId, (client) =>
    InboxSourceLifecycleStore.scheduleRetry(client, source, retryNotBefore.toISOString()),
  );
}
