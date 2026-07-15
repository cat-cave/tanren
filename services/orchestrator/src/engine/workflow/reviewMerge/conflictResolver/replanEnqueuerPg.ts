// The PRODUCTION wirings of the replan router's never-discard seams (v35 — the
// replan-routed-but-never-executed stall fix). The `SpecStatusReplanRouter` is the
// single chokepoint both the base-shift coordinator and the change-percolation settler
// reach (via `recordReplanContext`) when an in-place rebase cannot be re-gated onto the
// shifted base. It used to only flip the spec's status + append an event — so the spec
// sat `in_flight` with NO live run forever. These seams make a routed replan actually
// RUN: a fresh re-plan run is ENQUEUED (the spec's work re-authored on the new base),
// and the prior-replan count is read so the routing is BOUNDED (no hot-loop).
//
// Both seams reuse the EXACT mechanisms the recovery `replan_with_steering` action and
// the DagWalker enqueue already use — re-open the spec to `open`, append the replan
// context as steering, then `createQueuedRunFromSpec` (in-process) or the control-plane
// `RunStateWriter.createQueuedRun`. The re-open + steering UPDATEs COMMIT in their own
// short org-scoped txn BEFORE the run-create (which opens its own connection and claims
// the now-`open` spec) reads them — the same ordering `replanWithSteering` documents.

import { getSystemPool, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { ActorContext } from "../../../../auth/schemas.js";
import type { RunStateWriter } from "../../../contracts/runStateWriter.js";
import { isPool, type QueryClient } from "../../../data/orgScopedDb.js";
import {
  conflictSignatureOf,
  gateErrorSignature,
  type PriorReplanReader,
  type ReplanEnqueuer,
} from "./replanRouter.js";

/**
 * Resolve a real `pg.Pool` for events-table reads: prefer the BYPASSRLS system
 * pool (the events table is unreadable to the de-privileged data-plane role),
 * else the caller's pool when it is a real Pool. No `as pg.Pool` cast — `isPool`
 * is the typed narrow (workflow layers thread `QueryClient` / `RunStateClient`).
 */
function resolveEventsReadPool(fallback: QueryClient): pg.Pool {
  const system = getSystemPool();
  if (system !== undefined) return system;
  if (isPool(fallback)) return fallback;
  throw new Error("events-table read requires a real pg.Pool when TANREN_SYSTEM_DATABASE_URL / system pool is unset");
}

/**
 * The production replan enqueuer: re-open the spec to the re-drivable status + append
 * the replan context as steering (one short org-scoped txn that COMMITS first), then
 * enqueue a fresh re-plan run. Routes the run-create through the control plane when a
 * writer is wired, else `createQueuedRunFromSpec` in-process (the same dual path the
 * DagWalker enqueuer uses). Returns the new run id (the observable `replanRunId`).
 *
 * The first arg is retained for call-site arity (historical pool threading) but is
 * unused — all writes route through `runStateWriter` (audit D-R3.2). Accepts
 * `QueryClient` so workflow seams need no `as pg.Pool` cast.
 */
export function buildReplanEnqueuer(_pool: QueryClient, runStateWriter: RunStateWriter): ReplanEnqueuer {
  return {
    async enqueue(input) {
      // Audit D-R3.2: the writer is REQUIRED — both re-open + steer writes route through
      // the privileged control-plane pool over mTLS (the de-privileged data plane cannot
      // write `specs` directly per migration 0000:919). The in-process raw-SQL fallback
      // was unreachable in production once PR #714's `runStateWriterFromEnv` always
      // returned a writer.
      await runStateWriter.appendSpecSteering({
        specId: input.specId,
        orgId: input.orgId,
        steeringNote: input.steeringNote,
      });
      await runStateWriter.setSpecStatus({
        specId: input.specId,
        orgId: input.orgId,
        status: input.reopenStatus,
        notFromStatuses: ["merged"],
      });
      // (2) Enqueue the re-plan run — the never-discard re-author on the new base.
      const actor: ActorContext = {
        userId: "replan-router",
        orgId: input.orgId,
        projectId: input.projectId,
        scopes: ["platform:admin"],
        source: "local_dev",
      };
      const createInput = { specId: input.specId, trigger: "replan_routed" };
      const run = await runStateWriter.createQueuedRun({ input: createInput, actor });
      return { replanRunId: run.runId, plannerTaskId: run.plannerTaskId };
    },
  };
}

/**
 * The production prior-replan reader (the convergence-detector input): read the spec's prior
 * `merge.conflict.replan_routed` conflict signatures, oldest→newest. The `events` table is
 * unreadable to the de-privileged data-plane role (0031 REVOKE), so read on the BYPASSRLS
 * system pool with the org GUC still applied on top (the same hop the drive-path uses). A
 * legacy row without a `conflictSignature` falls back to a hash of its `newContext` so the
 * detector can still tell same-conflict from different-conflict.
 */
export function buildPriorReplanReader(pool: QueryClient): PriorReplanReader {
  return {
    async signatures(input) {
      const readPool = resolveEventsReadPool(pool);
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

/**
 * The production prior-gate-rework reader (the convergence-detector input for the re-gate
 * gate-fail rework router): read the spec's prior `merge.regate.gate_rework_routed`
 * (disposition `reworked`) gate-error SIGNATURES, oldest→newest. The `events` table is
 * unreadable to the de-privileged data-plane role (0031 REVOKE), so read on the BYPASSRLS
 * system pool with the org GUC applied on top (the same hop the replan reader uses). A spec
 * whose re-gate error keeps CHANGING is making progress; the SAME signature recurring is the
 * fixed point that escalates.
 */
export function buildPriorGateReworkReader(
  pool: QueryClient,
): (input: { specId: string; orgId: string }) => Promise<string[]> {
  return async (input) => {
    const readPool = resolveEventsReadPool(pool);
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
