// The allocator service's SOLE `events` writer — the allocator-side analogue of the
// orchestrator's PgEventStore. The allocator is a SEPARATE de-privileged
// microservice (its own package), so it cannot route through the orchestrator's
// in-process event store; this module is the ONE place the allocator appends a
// durable, org-scoped audit event, keeping the single-event-writer invariant per
// service. All writes are org-scoped (RLS) on the restricted app-role pool.

import type pg from "pg";
import { runWithOrgScope } from "@tanren/db";
import type { AllocationAudit } from "./runnerLifecycle.js";

const allocatorName = "sidecar-docker";

/**
 * Append the durable `allocator.allocated` audit event for a successful allocation,
 * org-scoped (same RLS scope as the `runners` row). `run_id` is NULL for a runless
 * Forge allocation (no `runs` row to reference); the events table allows it. The
 * event type is in the events_event_type_check vocabulary — no migration.
 */
export async function recordAllocatedEvent(appPool: pg.Pool, audit: AllocationAudit): Promise<void> {
  await runWithOrgScope(appPool, audit.orgId, async (client) => {
    await client.query(
      `INSERT INTO events (run_id, project_id, org_id, event_type, payload)
       VALUES ($1, $2, $3, 'allocator.allocated', $4::jsonb)`,
      [
        audit.runId,
        audit.projectId,
        audit.orgId,
        JSON.stringify({
          runnerId: audit.runnerId,
          allocator: allocatorName,
          imageSha: audit.imageSha,
          runless: audit.runless,
        }),
      ],
    );
  });
}
