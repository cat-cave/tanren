// The allocator service's SOLE `events` writer. Its typed append API validates
// allocator-owned payloads and preserves the event notification fanout.

import type pg from "pg";
import { notifyEventAppended, notifyRunActivity, runWithOrgScope } from "@tanren/db";
import { z } from "zod";
import type { AllocationAudit, SweptAudit } from "./runnerLifecycle.js";

type EventClient = Pick<pg.PoolClient, "query">;

const SshTargetSummary = z
  .object({
    host: z.string(),
    port: z.number().int(),
    username: z.string(),
    hostKeyFingerprint: z.string(),
  })
  .strict();

const allocatorEventRegistry = {
  "allocator.allocated": z
    .object({
      runnerId: z.string(),
      imageSha: z.string(),
      target: SshTargetSummary,
    })
    .strict(),
  "runner.swept": z
    .object({
      runnerId: z.string(),
      runId: z.string().nullable(),
      reason: z.enum(["terminal_run", "lease_lapsed", "unclaimed_grace"]),
    })
    .strict(),
} as const;

type AllocatorEventName = keyof typeof allocatorEventRegistry;
type AllocatorEventInput<N extends AllocatorEventName> = {
  runId: string | null;
  projectId: string | null;
  /** Explicit tenant key; never inferred from a project row or ambient scope. */
  orgId: string;
  eventType: N;
  payload: z.output<(typeof allocatorEventRegistry)[N]>;
};

/**
 * The allocator's typed append API. It is the only allocator-side SQL writer
 * for `events`, and callers must supply the tenant key that is stamped on row.
 */
async function appendAllocatorEvent<N extends AllocatorEventName>(
  client: EventClient,
  input: AllocatorEventInput<N>,
): Promise<void> {
  if (input.orgId.trim() === "") {
    throw new Error("appendAllocatorEvent: explicit orgId must be non-empty");
  }
  const payload: unknown = allocatorEventRegistry[input.eventType].parse(input.payload);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO events (run_id, project_id, org_id, event_type, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id::text AS id`,
    [input.runId, input.projectId, input.orgId, input.eventType, JSON.stringify(payload)],
  );
  const eventId = inserted.rows[0]?.id;
  if (eventId === undefined) {
    throw new Error("appendAllocatorEvent: event insert returned no id");
  }
  if (input.runId !== null) {
    await notifyRunActivity(client, input.runId);
  }
  await notifyEventAppended(client, eventId);
}

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
