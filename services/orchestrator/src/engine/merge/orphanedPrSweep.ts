// DEFENSE-IN-DEPTH (PR #724 follow-up — apex v67/v69 root cause #2): the orphaned-PR
// startup sweep the `MergeCoordinatorSubscriber` boot path runs once. It scans the
// `events` ledger for runs whose `github.pr.created` event landed but whose `merge_queue`
// row never did — the exact split-brain a crash/pool-blip between PR #724's three
// separate transactions (events append → INSERT → events append) could still produce
// (and that PR #724 was meant to close). The seam's `runWithOrgScope` 3-write block
// (mergeQueueEarlyEnqueueSeam) closes the on-the-fly case; this sweep is the catch-up
// path for any orphan that pre-existed the fix or escaped it.
//
// Per-orphan, this opens ONE `runWithOrgScope` and:
//   1. SELECTs to confirm no `merge_queue` row exists (idempotent guard against a race
//      with a concurrent enqueue);
//   2. INSERTs the merge_queue row using `PgMergeQueueModel.enqueueOnClient`;
//   3. APPENDs `merge.scheduled` so the observability + downstream subscribers see the
//      catch-up as a real schedule event (not a silent recovery).
// All three are in ONE transaction (the same atomicity guarantee the seam enforces).
//
// The discovery query joins `events`/`runs`/`projects` system-scoped (BYPASSRLS) because
// it spans every project; the per-orphan write is org-scoped per run.

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { PgEventStore } from "../eventStore.js";
import { createLogger } from "../observability/logger.js";
import { PgMergeQueueModel } from "./coordinatorPg.js";

const log = createLogger("merge-coordinator");

interface OrphanRow {
  run_id: string;
  spec_id: string;
  project_id: string;
  org_id: string;
  pr_url: string;
  pr_number: string;
}

const DISCOVER_ORPHANED_PRS_SQL = `
SELECT DISTINCT ON (e.run_id)
       e.run_id::text       AS run_id,
       e.spec_id::text      AS spec_id,
       e.project_id::text   AS project_id,
       e.org_id::text       AS org_id,
       e.payload ->> 'prUrl'    AS pr_url,
       e.payload ->> 'prNumber' AS pr_number
  FROM events e
  JOIN runs r ON r.run_id = e.run_id
  JOIN projects p ON p.project_id = e.project_id
 WHERE e.event_type = 'github.pr.created'
   AND e.run_id IS NOT NULL
   AND (e.payload ->> 'prUrl')    IS NOT NULL AND (e.payload ->> 'prUrl')    <> ''
   AND (e.payload ->> 'prNumber') IS NOT NULL AND (e.payload ->> 'prNumber') <> ''
   AND COALESCE(p.config ->> 'mergeIntegration', '') = 'native_queue'
   AND r.status NOT IN ('merged', 'cancelled', 'superseded')
   AND NOT EXISTS (
     SELECT 1 FROM merge_queue mq
      WHERE mq.run_id = e.run_id
        AND mq.status IN ('queued', 'merging', 'merged')
   )
 ORDER BY e.run_id, e.ts DESC, e.id DESC`;

/**
 * Result of one sweep pass: total orphans discovered + how many were recovered (a row
 * survived a concurrent enqueue race ⇒ counted as discovered but not as recovered).
 */
export interface OrphanedPrSweepResult {
  discovered: number;
  recovered: number;
}

/**
 * Scan for runs whose `github.pr.created` event landed but whose `merge_queue` row never
 * did, and ATOMICALLY enqueue + emit `merge.scheduled` for each (one transaction per
 * orphan — the same atomicity guarantee the on-the-fly seam enforces). Idempotent: a
 * row that already exists (lost a race to the seam or a concurrent sweep) is left alone;
 * `recovered` reports only those THIS pass created.
 *
 * Logged LOUD per orphan so an operator notices recovery activity — silent recovery would
 * mask the underlying bug class. Errors per-orphan are caught + logged so one bad row
 * does not abort the whole sweep.
 */
export async function discoverOrphanedPrs(pool: pg.Pool): Promise<OrphanedPrSweepResult> {
  const orphans = await runWithSystemScope(pool, async (client) => {
    const result = await client.query<OrphanRow>(DISCOVER_ORPHANED_PRS_SQL);
    return result.rows;
  });
  if (orphans.length === 0) {
    return { discovered: 0, recovered: 0 };
  }
  log.warn("orphaned-PR sweep: PR events with no merge_queue row — recovering", {
    count: orphans.length,
  });
  const model = new PgMergeQueueModel(pool);
  let recovered = 0;
  for (const orphan of orphans) {
    try {
      const created = await recoverOrphan(pool, model, orphan);
      if (created) recovered += 1;
    } catch (error) {
      // One bad orphan must not abort the sweep — log + continue. The next boot will
      // re-try this row, so a transient error self-heals; a permanent one stays loud.
      log.error(
        "orphaned-PR sweep: recovery failed for one run (continuing)",
        { runId: orphan.run_id, prUrl: orphan.pr_url },
        error,
      );
    }
  }
  return { discovered: orphans.length, recovered };
}

async function recoverOrphan(pool: pg.Pool, model: PgMergeQueueModel, orphan: OrphanRow): Promise<boolean> {
  const prNumber = Number(orphan.pr_number);
  if (!Number.isFinite(prNumber)) {
    // A malformed payload — log + skip rather than INSERTing nonsense into the queue.
    log.warn("orphaned-PR sweep: skipping orphan with non-numeric prNumber", {
      runId: orphan.run_id,
      prNumber: orphan.pr_number,
    });
    return false;
  }
  return runWithOrgScope(pool, orphan.org_id, async (client) => {
    const { created } = await model.enqueueOnClient(client, orphan.org_id, {
      projectId: orphan.project_id,
      runId: orphan.run_id,
      specId: orphan.spec_id,
      prUrl: orphan.pr_url,
      prNumber,
    });
    if (created) {
      // The catch-up signal — observably distinct from a normal `merge.scheduled` only
      // by virtue of arriving long after the PR-create event. The payload shape is the
      // SAME as the seam emits (no new schema) so downstream subscribers do not need
      // a separate handler. `merge.scheduled` is the safe one: if a write-side race
      // means the seam ALSO emitted it later (very unlikely — the partial unique index
      // would have prevented the duplicate INSERT), the downstream is already idempotent
      // on it (PR #724 §-tests prove this).
      await new PgEventStore(client).append({
        runId: orphan.run_id,
        specId: orphan.spec_id,
        projectId: orphan.project_id,
        orgId: orphan.org_id,
        eventType: "merge.scheduled",
        payload: { prUrl: orphan.pr_url, prNumber, integration: "native_queue" },
      });
      log.warn("orphaned-PR sweep: recovered one orphan PR into merge_queue", {
        runId: orphan.run_id,
        prUrl: orphan.pr_url,
        prNumber,
      });
    }
    return created;
  });
}
