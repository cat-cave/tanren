// Org-scoped read projection for the latest PROJECT-LEVEL DagWalker budget
// pause. `PgBudgetGate` remains the sole authority for whether the project is
// paused; this reader only exposes the durable `dag.budget.paused` proof so the
// HTTP/UI surface can show how many eligible specs the walker actually held.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { z } from "zod";
import { DagBudgetPausedPayload } from "../events/schemas/dag.js";

export interface BudgetPauseObservation {
  eventType: "dag.budget.paused";
  readyHeldBack: number;
  observedAt: string;
}

const EventTimestamp = z.union([z.date(), z.string().datetime({ offset: true })]);

/** Read the latest walker-owned pause event for one org/project. */
export class PgBudgetPauseObservationReader {
  constructor(private readonly pool: pg.Pool) {}

  async latest(orgId: string, projectId: string): Promise<BudgetPauseObservation | null> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<{ ts: unknown; payload: unknown }>(
        `SELECT ts, payload
           FROM events
          WHERE org_id = $1
            AND project_id = $2
            AND event_type = 'dag.budget.paused'
            AND run_id IS NULL
            AND task_id IS NULL
            AND spec_id IS NULL
          ORDER BY ts DESC, id DESC
          LIMIT 1`,
        [orgId, projectId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;

      // Durable event rows are validated on append; decode again at this HTTP
      // boundary so malformed historical data fails loud instead of becoming a
      // fabricated held count.
      const payload = DagBudgetPausedPayload.parse(row.payload);
      const timestamp = EventTimestamp.parse(row.ts);
      return {
        eventType: "dag.budget.paused",
        readyHeldBack: payload.readyHeldBack,
        observedAt: timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString(),
      };
    });
  }
}
