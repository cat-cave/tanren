// The LIVE writer-backed `LandFinalizer` (tanren-owns-the-engine.md §5) — the
// DURABLE half of the guaranteed transactional land. `MergeAuthority.land` runs:
// authorize → external land via `CodeHost.landAuthorizedRef` → THIS finalize. The
// finalize records the completed land in ONE org-scoped transaction (`merge.completed`
// + the spec `merged` flip together), so the internal state can never silently
// disagree with the host. A THROW here — after the external land already advanced
// `main` — is exactly the `merge_state_unknown` reconcile signal the authority maps;
// it is NEVER swallowed into a silent inconsistency.
//
// This DELETES the §5-P0 ordering bug (the external merge fired BEFORE the durable
// `merge.completed`/finalize): the host land is now the FIRST step inside `land`, and
// this durable record is the LAST — and a finalize failure after the land is a typed
// reconcile state, not a plain failure.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { PgEventStore } from "../eventStore.js";
import { applySetSpecStatus } from "../worker/runStateLifecycleSql.js";
import type { AuditEnvelope } from "../events/schemas/audit.js";
import type { LandAuthorization } from "../contracts/mergeAuthority.js";
import type { LandFinalizer } from "./mergeAuthorityImpl.js";

/**
 * The durable identity + audit context one land finalize records. Resolved from the
 * run's merge-stage context BEFORE the land (so the finalize never has to re-read it
 * after the external land already fired). `integration` labels the event
 * (`direct_merge` / `native_queue`); `auditEnvelope` carries the policy version +
 * the initiating/approving actors stamped onto `merge.completed`.
 */
export interface LandFinalizeContext {
  orgId: string;
  runId: string;
  specId: string;
  projectId: string;
  taskId: string;
  prUrl: string;
  prNumber: number;
  integration: "direct_merge" | "native_queue";
  auditEnvelope: AuditEnvelope;
}

/**
 * Build the LIVE `LandFinalizer` bound to one run's merge-stage context. The
 * finalize runs `merge.completed` + the guarded spec `merged` flip in ONE org-scoped
 * transaction on the worker pool — the §5 transactional record. It returns the
 * recorded run id as the `auditId` (the durable handle of the land). A DB failure
 * THROWS, which `MergeAuthority.land` turns into `merge_state_unknown` (the host
 * already advanced `main`) — never a silent inconsistency, never a duplicate land.
 *
 * The merge TASK finalize (task → done + `task.completed`) stays in the dispatcher's
 * existing `finalize("merged")` path on the authorized branch; this finalizer owns
 * the GOVERNING `merge.completed` + the spec status flip so the ancestor reaching
 * `merged` (which unblocks its dependents) is recorded atomically with the land.
 */
export function buildLandFinalizer(pool: pg.Pool, context: LandFinalizeContext): LandFinalizer {
  return {
    async finalizeLanded(input: { authorization: LandAuthorization; mainSha: string }): Promise<{ auditId: string }> {
      await runWithOrgScope(pool, context.orgId, async (client) => {
        const events = new PgEventStore(client);
        await events.append({
          runId: context.runId,
          specId: context.specId,
          projectId: context.projectId,
          taskId: context.taskId,
          eventType: "merge.completed",
          payload: {
            prUrl: context.prUrl,
            prNumber: context.prNumber,
            integration: context.integration,
            mergeSha: input.mainSha,
            ...context.auditEnvelope,
          },
        });
        // The ancestor reaches `merged` HERE, atomically with `merge.completed` —
        // the single point its dependents' merge-hold clears. Guarded so a spec
        // already `merged`/`done` is left alone (idempotent on a reconcile retry).
        await applySetSpecStatus(client, {
          specId: context.specId,
          orgId: context.orgId,
          status: "merged",
          notFromStatuses: ["merged"],
        });
      });
      return { auditId: context.runId };
    },
  };
}
