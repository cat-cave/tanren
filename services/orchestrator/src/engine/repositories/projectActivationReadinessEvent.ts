import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { PgEventStore } from "../eventStore.js";
import { ProjectActivationReadinessBlockedError, type ActivationReadinessVerdict } from "./activationReadiness.js";

/**
 * Persist a readiness block after its activation transaction has rolled back.
 * This deliberately starts a fresh scoped transaction: writing it on the failed
 * activation client would roll the event back with the gate failure and create
 * the phantom-observability bug this event exists to prevent.
 */
export async function appendProjectActivationReadinessBlocked(
  pool: pg.Pool,
  input: { orgId: string; projectId: string; verdict: ActivationReadinessVerdict },
): Promise<void> {
  await runWithOrgScope(pool, input.orgId, async (client) => {
    await new PgEventStore(client).append({
      orgId: input.orgId,
      projectId: input.projectId,
      eventType: "project.activation.readiness_blocked",
      payload: {
        reason: {
          unreadyCapabilities: input.verdict.blockers.map((blocker) => ({ ...blocker })),
          materializationGaps: input.verdict.gaps.map((gap) => ({ ...gap })),
        },
      },
    });
  });
}

/** Run the activation CAS in its own transaction, then preserve a gate block outside it. */
export async function runActivationWithReadinessBlockEvent<T>(
  pool: pg.Pool,
  input: { orgId: string; projectId: string },
  activate: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  try {
    return await runWithOrgScope(pool, input.orgId, activate);
  } catch (error) {
    if (error instanceof ProjectActivationReadinessBlockedError) {
      await appendProjectActivationReadinessBlocked(pool, { ...input, verdict: error.verdict });
    }
    throw error;
  }
}
