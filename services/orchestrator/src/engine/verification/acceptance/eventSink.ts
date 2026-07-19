/**
 * rv-11 A1 acceptance: the org-scoped event sink. The orchestrator emits the
 * frozen runtime-verification vocabulary (rv-25) through this seam; the Postgres
 * implementation opens an RLS-scoped transaction per append so every event row
 * carries the tenant key the EventStore's RLS WITH CHECK demands. A conformance
 * fake records the same appends in memory.
 */

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { AppendEventInput } from "../../eventStore.js";
import { PgEventStore } from "../../eventStore.js";
import type { EventName } from "../../events/index.js";

export interface AcceptanceEventSink {
  append<N extends EventName>(input: AppendEventInput<N>): Promise<void>;
}

/** Appends each acceptance event on its own org-scoped transaction. */
export class PgAcceptanceEventSink implements AcceptanceEventSink {
  public constructor(private readonly pool: pg.Pool) {}

  public async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, (client) => new PgEventStore(client).append(input));
  }
}
