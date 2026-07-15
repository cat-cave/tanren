// Production replan enqueuer: atomic prepareSpecForRecovery (steering + allowlisted
// reopen in ONE org-scoped txn), then createQueuedRun. Terminal/missing/unknown specs
// receive neither steering nor a run attempt.

import { getSystemPool, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
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
 * Production replan enqueuer: prepare (atomic) then enqueue. Prepare fails closed
 * for non-allowlisted sources with zero writes; createQueuedRun only runs after prepared.
 */
export function buildReplanEnqueuer(_pool: pg.Pool, runStateWriter: RunStateWriter): ReplanEnqueuer {
  return {
    async enqueue(input) {
      const prep = await runStateWriter.prepareSpecForRecovery({
        specId: input.specId,
        orgId: input.orgId,
        steeringNote: input.steeringNote,
        reopenStatus: input.reopenStatus,
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

/** Prior replan conflict signatures (system-pool read + org GUC). */
export function buildPriorReplanReader(pool: pg.Pool): PriorReplanReader {
  return {
    async signatures(input) {
      const readPool = getSystemPool() ?? pool;
      return runWithOrgScope(readPool, input.orgId, async (client) => {
        const result = await client.query<{
          payload: { conflictSignature?: string; newContext?: string; otherSpecId?: string };
        }>(
          `SELECT payload
             FROM events
            WHERE spec_id = $1 AND event_type = 'merge.conflict.replan_routed'
            ORDER BY ts ASC, id ASC`,
          [input.specId],
        );
        return result.rows.map(
          (row) =>
            row.payload.conflictSignature ?? conflictSignatureOf(row.payload.newContext ?? "", row.payload.otherSpecId),
        );
      });
    },
  };
}

/** Prior gate-rework error signatures (system-pool read + org GUC). */
export function buildPriorGateReworkReader(
  pool: pg.Pool,
): (input: { specId: string; orgId: string }) => Promise<string[]> {
  return async (input) => {
    const readPool = getSystemPool() ?? pool;
    return runWithOrgScope(readPool, input.orgId, async (client) => {
      const result = await client.query<{ payload: { gateError?: string } }>(
        `SELECT payload
           FROM events
          WHERE spec_id = $1 AND event_type = 'merge.regate.gate_rework_routed'
            AND payload ->> 'disposition' = 'reworked'
          ORDER BY ts ASC, id ASC`,
        [input.specId],
      );
      return result.rows.map((row) => gateErrorSignature(row.payload.gateError ?? ""));
    });
  };
}
