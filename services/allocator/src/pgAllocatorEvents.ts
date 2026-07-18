// The allocator service's SOLE `events` writer. It routes through the shared,
// typed event-store API because the allocator is a separate microservice and
// cannot use the orchestrator's in-process PgEventStore directly.

import type pg from "pg";
import { appendAllocatorEvent, runWithOrgScope } from "@tanren/db";
import type { AllocationAudit, SweptAudit } from "./runnerLifecycle.js";

/**
 * Append the durable `allocator.allocated` audit event for a successful allocation,
 * org-scoped (same RLS scope as the `runners` row). `run_id` is NULL for a runless
 * Forge allocation (no `runs` row to reference); the events table allows it. The
 * event type is in the events_event_type_check vocabulary — no migration.
 */
export async function recordAllocatedEvent(appPool: pg.Pool, audit: AllocationAudit): Promise<void> {
  await runWithOrgScope(appPool, audit.orgId, async (client) => {
    await appendAllocatorEvent(client, {
      runId: audit.runId,
      projectId: audit.projectId,
      orgId: audit.orgId,
      eventType: "allocator.allocated",
      payload: {
        runnerId: audit.runnerId,
        imageSha: audit.imageSha,
        target: audit.target,
      },
    });
  });
}

/**
 * Append the durable `runner.swept` audit event for a sweeper reclaim, org-scoped
 * (same RLS scope as the `runners` row). The payload carries the discriminated
 * stuck-state `reason` plus the NON-SECRET runner/run handles — the proof a leaked
 * runner the normal release path missed was reconciled LOUDLY, never silently.
 * `run_id` is NULL for a wedged (unclaimed-grace) allocation never tied to a `runs`
 * row. The event type is in the `events_event_type_check` vocabulary (migration 0029).
 */
export async function recordSweptEvent(appPool: pg.Pool, audit: SweptAudit): Promise<void> {
  await runWithOrgScope(appPool, audit.orgId, async (client) => {
    await appendAllocatorEvent(client, {
      runId: audit.runId,
      projectId: audit.projectId,
      orgId: audit.orgId,
      eventType: "runner.swept",
      payload: {
        runnerId: audit.runnerId,
        runId: audit.runId,
        reason: audit.reason,
      },
    });
  });
}
