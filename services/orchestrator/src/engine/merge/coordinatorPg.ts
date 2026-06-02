// The pg-backed MergeCoordinator seam wirings (autonomy-engine.md §2d), split out
// of `coordinator.ts` to keep each file under the 500-line cap. This module
// carries the two production wirings the EventEmittingMergeCoordinator composes:
//   - PgMergeQueueModel: the org-scoped native-queue model (enqueue / loadSnapshot
//     / atomic claim / settle / crash-recovery). DAG state is the source of truth,
//     so ordering is NOT stored — the snapshot reads the queue rows + the DAG facts
//     (each entry's spec `depends_on` + priority + the merged-spec set) fresh each
//     pass, and `selectNextMerge` orders them. RLS-scoped to the project's org.
//   - PgMergeRunner: drives ONE queued run's merge through the EXISTING per-run
//     merge path (mergeForRun in `native_queue` DRIVE mode) — NOT a second merge
//     impl. It maps the merge-stage outcome to the coordinator's drive outcome.
//
// Scope: like PgDagReadModel, each method resolves the project's org (system-scoped
// bootstrap) then reads/writes UNDER THAT ORG SCOPE (RLS denies by default).

import { randomUUID } from "node:crypto";
import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { SpecPriority } from "../state/spec.js";
import {
  type MergeDriveOutcome,
  type MergeQueueEntry,
  type MergeQueueModel,
  type MergeQueueSnapshot,
  type MergeRunner,
} from "../contracts/mergeCoordinator.js";
import type { DriveMergeForQueuedRun } from "./coordinator.js";

/** Resolve a project's org (the system-scoped bootstrap before any tenant work). */
async function resolveProjectOrg(pool: pg.Pool, projectId: string): Promise<string | null> {
  return runWithSystemScope(pool, async (client) => {
    const result = await client.query<{ org_id: string | null }>("SELECT org_id FROM projects WHERE project_id = $1", [
      projectId,
    ]);
    return result.rows[0]?.org_id ?? null;
  });
}

interface QueueEntryRow {
  queue_id: string;
  run_id: string;
  spec_id: string;
  pr_url: string;
  pr_number: string;
  depends_on: unknown;
  priority: unknown;
  rn: string | number;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * The pg-backed native-queue model. Resolves the project's org, then reads/writes
 * the `merge_queue` rows UNDER THAT ORG SCOPE (RLS). A read off the wrong scope
 * sees zero rows, so the snapshot is always exactly the project's own queue.
 */
export class PgMergeQueueModel implements MergeQueueModel {
  constructor(private readonly pool: pg.Pool) {}

  async enqueue(input: {
    projectId: string;
    runId: string;
    specId: string;
    prUrl: string;
    prNumber: number;
  }): Promise<{ queueId: string; created: boolean }> {
    const orgId = await resolveProjectOrg(this.pool, input.projectId);
    if (orgId === null) {
      throw new Error(`cannot enqueue run ${input.runId}: project ${input.projectId} has no resolvable org`);
    }
    return runWithOrgScope(this.pool, orgId, async (client) => {
      // Idempotency: a run already queued/merging keeps its existing entry. The
      // partial unique index (merge_queue_active_run_unique) is the hard guarantee;
      // we check first so we can report `created` (emit merge.queued only once).
      const existing = await client.query<{ queue_id: string }>(
        "SELECT queue_id FROM merge_queue WHERE run_id = $1 AND status IN ('queued','merging') LIMIT 1",
        [input.runId],
      );
      const found = existing.rows[0];
      if (found !== undefined) {
        return { queueId: found.queue_id, created: false };
      }
      const queueId = `mq_${randomUUID()}`;
      await client.query(
        `INSERT INTO merge_queue (queue_id, run_id, spec_id, project_id, org_id, status, pr_url, pr_number)
         VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7)`,
        [queueId, input.runId, input.specId, input.projectId, orgId, input.prUrl, String(input.prNumber)],
      );
      return { queueId, created: true };
    });
  }

  async loadSnapshot(projectId: string): Promise<MergeQueueSnapshot> {
    const orgId = await resolveProjectOrg(this.pool, projectId);
    if (orgId === null) {
      return { projectId, entries: [], mergedSpecIds: new Set(), mergingInFlight: false };
    }
    return runWithOrgScope(this.pool, orgId, async (client) => {
      // The QUEUED entries joined to each spec's DAG facts (depends_on + priority).
      // Ordered deterministically by enqueue time for a stable orderKey tiebreak.
      const entryRows = await client.query<QueueEntryRow>(
        `SELECT mq.queue_id, mq.run_id, mq.spec_id, mq.pr_url, mq.pr_number,
                s.depends_on, s.priority,
                row_number() OVER (ORDER BY mq.enqueued_at, mq.queue_id) AS rn
           FROM merge_queue mq
           JOIN specs s ON s.spec_id = mq.spec_id
          WHERE mq.project_id = $1 AND mq.status = 'queued'`,
        [projectId],
      );
      const entries: MergeQueueEntry[] = entryRows.rows.map((row) => ({
        queueId: row.queue_id,
        runId: row.run_id,
        specId: row.spec_id,
        prUrl: row.pr_url,
        prNumber: Number(row.pr_number),
        dependsOn: asStringArray(row.depends_on),
        priority: SpecPriority.parse(row.priority),
        orderKey: Number(row.rn),
      }));

      // Is another entry already merging (serialization signal)?
      const merging = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM merge_queue WHERE project_id = $1 AND status = 'merging'",
        [projectId],
      );
      const mergingInFlight = Number(merging.rows[0]?.count ?? "0") > 0;

      // The specs that have GENUINELY merged (done/merged) — satisfied ancestors.
      const mergedRows = await client.query<{ spec_id: string }>(
        "SELECT spec_id FROM specs WHERE project_id = $1 AND status IN ('done','merged')",
        [projectId],
      );
      const mergedSpecIds = new Set(mergedRows.rows.map((r) => r.spec_id));

      return { projectId, entries, mergedSpecIds, mergingInFlight };
    });
  }

  async claim(queueId: string): Promise<boolean> {
    const orgId = await this.resolveQueueOrg(queueId);
    if (orgId === null) return false;
    return runWithOrgScope(this.pool, orgId, async (client) => {
      // The atomic serialization lock: flip queued → merging only if STILL queued.
      // A concurrent pass that already claimed it updates 0 rows and loses.
      const result = await client.query(
        "UPDATE merge_queue SET status = 'merging', claimed_at = now() WHERE queue_id = $1 AND status = 'queued'",
        [queueId],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  async markMerged(queueId: string): Promise<void> {
    await this.settle(queueId, "UPDATE merge_queue SET status = 'merged', settled_at = now() WHERE queue_id = $1", []);
  }

  async markDequeued(queueId: string, reason: "conflict" | "blocked" | "failed"): Promise<void> {
    await this.settle(
      queueId,
      "UPDATE merge_queue SET status = 'dequeued', dequeue_reason = $2, settled_at = now() WHERE queue_id = $1",
      [reason],
    );
  }

  async recoverStaleClaims(projectId: string): Promise<number> {
    const orgId = await resolveProjectOrg(this.pool, projectId);
    if (orgId === null) return 0;
    return runWithOrgScope(this.pool, orgId, async (client) => {
      // A coordinator died mid-merge: return its `merging` rows to `queued` so the
      // queue is recoverable. The GitHub merge is idempotent (a re-driven
      // already-merged PR is a no-op), so re-queuing is safe.
      const result = await client.query(
        "UPDATE merge_queue SET status = 'queued', claimed_at = NULL WHERE project_id = $1 AND status = 'merging'",
        [projectId],
      );
      return result.rowCount ?? 0;
    });
  }

  private async settle(queueId: string, sql: string, extra: unknown[]): Promise<void> {
    const orgId = await this.resolveQueueOrg(queueId);
    if (orgId === null) return;
    await runWithOrgScope(this.pool, orgId, async (client) => {
      await client.query(sql, [queueId, ...extra]);
    });
  }

  /** Resolve a queue entry's org (system-scoped) so the scoped write hits its row. */
  private async resolveQueueOrg(queueId: string): Promise<string | null> {
    return runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM merge_queue WHERE queue_id = $1",
        [queueId],
      );
      return result.rows[0]?.org_id ?? null;
    });
  }
}

/**
 * The production merge runner: drives ONE queued run's merge through the EXISTING
 * per-run merge path (mergeForRun in `native_queue` DRIVE mode) — NOT a second
 * merge impl. The actual mergeForRun call (with its full P2a/P2b/P2c-1 wiring) is
 * injected as `drive` so this module does not import the heavy run-loop seam graph;
 * the worker boot supplies the same wiring the run loop uses.
 */
export class PgMergeRunner implements MergeRunner {
  constructor(private readonly drive: DriveMergeForQueuedRun) {}

  async driveMerge(input: { runId: string; projectId: string }): Promise<MergeDriveOutcome> {
    return this.drive(input);
  }
}
