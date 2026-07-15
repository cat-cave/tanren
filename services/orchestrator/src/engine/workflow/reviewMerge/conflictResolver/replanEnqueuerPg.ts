// Production replan enqueuer + prior-signature readers for conflict/gate rework.
// Enqueuer: atomic prepareSpecForRecovery then createQueuedRun (writer-only; no pool).
// Prior readers: events-table SELECT under system-pool + org GUC, Zod-decoded rows.

import { getSystemPool, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../../../auth/schemas.js";
import type { RunStateWriter } from "../../../contracts/runStateWriter.js";
import { SpecNotPreparedForRecoveryError } from "../../../workflow/projectSpecErrors.js";
import {
  conflictSignatureOf,
  gateErrorSignature,
  type PriorReplanReader,
  type ReplanEnqueuer,
} from "./replanRouter.js";

/**
 * Zod-decoded `events` row for `merge.conflict.replan_routed`. Replaces an unchecked
 * `client.query<{ payload: … }>` cast: malformed/null/wrong-type payloads fail as
 * Zod validation errors instead of silent `??` coercion into a fake signature.
 */
const PriorReplanEventRow = z.object({
  payload: z.object({
    conflictSignature: z.string().optional(),
    newContext: z.string().optional(),
    otherSpecId: z.string().optional(),
  }),
});

/**
 * Zod-decoded `events` row for `merge.regate.gate_rework_routed` (SQL filters
 * disposition = reworked). Same fail-closed decode as {@link PriorReplanEventRow}.
 */
const PriorGateReworkEventRow = z.object({
  payload: z.object({
    gateError: z.string().optional(),
  }),
});

/**
 * Atomic prepare then enqueue via the run-state writer. Prepare fails closed for
 * non-allowlisted sources with zero writes; createQueuedRun only after prepared.
 */
export function buildReplanEnqueuer(runStateWriter: RunStateWriter): ReplanEnqueuer {
  return {
    async enqueue(input) {
      const prep = await runStateWriter.prepareSpecForRecovery({
        specId: input.specId,
        orgId: input.orgId,
        steeringNote: input.steeringNote,
      });
      if (!prep.prepared) {
        throw new SpecNotPreparedForRecoveryError(input.specId, prep.reason, prep.status);
      }
      const actor: ActorContext = {
        userId: "replan-router",
        orgId: input.orgId,
        projectId: input.projectId,
        scopes: ["platform:admin"],
        source: "local_dev",
      };
      const run = await runStateWriter.createQueuedRun({
        input: { specId: input.specId, trigger: "replan_routed" },
        actor,
      });
      return { replanRunId: run.runId, plannerTaskId: run.plannerTaskId };
    },
  };
}

/** Prior replan conflict signatures (system-pool read + org GUC; Zod-decoded rows). */
export function buildPriorReplanReader(pool: pg.Pool): PriorReplanReader {
  return {
    async signatures(input) {
      const readPool = getSystemPool() ?? pool;
      return runWithOrgScope(readPool, input.orgId, async (client) => {
        const result = await client.query(
          `SELECT payload
             FROM events
            WHERE spec_id = $1 AND event_type = 'merge.conflict.replan_routed'
            ORDER BY ts ASC, id ASC`,
          [input.specId],
        );
        return result.rows.map((row) => {
          const payload = PriorReplanEventRow.parse(row).payload;
          return payload.conflictSignature ?? conflictSignatureOf(payload.newContext ?? "", payload.otherSpecId);
        });
      });
    },
  };
}

/** Prior gate-rework error signatures (system-pool read + org GUC; Zod-decoded rows). */
export function buildPriorGateReworkReader(
  pool: pg.Pool,
): (input: { specId: string; orgId: string }) => Promise<string[]> {
  return async (input) => {
    const readPool = getSystemPool() ?? pool;
    return runWithOrgScope(readPool, input.orgId, async (client) => {
      const result = await client.query(
        `SELECT payload
           FROM events
          WHERE spec_id = $1 AND event_type = 'merge.regate.gate_rework_routed'
            AND payload ->> 'disposition' = 'reworked'
          ORDER BY ts ASC, id ASC`,
        [input.specId],
      );
      return result.rows.map((row) => gateErrorSignature(PriorGateReworkEventRow.parse(row).payload.gateError ?? ""));
    });
  };
}
