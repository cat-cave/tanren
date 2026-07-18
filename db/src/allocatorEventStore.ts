// Shared allocator-event writer. The allocator is a separate service, so it
// cannot use the orchestrator's in-process PgEventStore. This package owns the
// two allocator event schemas and the durable insert + notify behavior they
// share with the orchestrator event store.

import type pg from "pg";
import { z } from "zod";
import { notifyEventAppended, notifyRunActivity } from "./notify.js";

type EventClient = Pick<pg.PoolClient, "query">;

const SshTargetSummary = z
  .object({
    host: z.string(),
    port: z.number().int(),
    username: z.string(),
    hostKeyFingerprint: z.string(),
  })
  .strict();

export const AllocatorAllocatedPayload = z
  .object({
    runnerId: z.string(),
    imageSha: z.string(),
    target: SshTargetSummary,
  })
  .strict();

export const RunnerSweptPayload = z
  .object({
    runnerId: z.string(),
    runId: z.string().nullable(),
    reason: z.enum(["terminal_run", "lease_lapsed", "unclaimed_grace"]),
  })
  .strict();

export const AllocatorEventRegistry = {
  "allocator.allocated": AllocatorAllocatedPayload,
  "runner.swept": RunnerSweptPayload,
} as const;

export type AllocatorEventName = keyof typeof AllocatorEventRegistry;
export type AllocatorEventPayload<N extends AllocatorEventName> = z.output<(typeof AllocatorEventRegistry)[N]>;

export interface AllocatorEventInput<N extends AllocatorEventName> {
  runId: string | null;
  projectId: string | null;
  /** Explicit tenant key; never inferred from a project row or ambient scope. */
  orgId: string;
  eventType: N;
  payload: AllocatorEventPayload<N>;
}

/**
 * Append one allocator-owned event using the shared event-table protocol.
 * Callers must already hold the matching `runWithOrgScope` transaction; this
 * helper validates the payload and preserves the central notification fanout.
 */
export async function appendAllocatorEvent<N extends AllocatorEventName>(
  client: EventClient,
  input: AllocatorEventInput<N>,
): Promise<void> {
  if (input.orgId.trim() === "") {
    throw new Error("appendAllocatorEvent: explicit orgId must be non-empty");
  }
  const parsedPayload: unknown = AllocatorEventRegistry[input.eventType].parse(input.payload);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO events (run_id, project_id, org_id, event_type, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id::text AS id`,
    [input.runId, input.projectId, input.orgId, input.eventType, JSON.stringify(parsedPayload)],
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
