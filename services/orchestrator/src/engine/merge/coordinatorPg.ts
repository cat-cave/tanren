// Pg-backed MergeCoordinator wiring (autonomy-engine.md §2d). Each method resolves
// the project's org, then reads/writes under that org scope so RLS keeps tenant queue
// and event recovery isolated.

import { randomUUID } from "node:crypto";
import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { SpecPriority } from "../state/spec.js";
import {
  type DequeueReason,
  type MergeDriveOutcome,
  type MergeQueueEntry,
  type MergeQueueModel,
  type MergeQueueSnapshot,
  type MergeRunner,
} from "../contracts/mergeCoordinator.js";
import type { WatchdogProgressSignal } from "../contracts/commandSubstrate.js";
import { type DriveMergeForQueuedRun, type MergeQueueEventEmitter } from "./coordinator.js";
import { PgMergeQueuePartitionStore } from "./mergeQueuePartitionStore.js";
import { MERGE_QUEUE_PROGRESS_RECHECK_MS } from "./mergeSerializedRetry.js";

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
  org_id: string;
  project_id: string;
  queue_id: string;
  run_id: string;
  spec_id: string;
  pr_url: string;
  pr_number: string;
  depends_on: unknown;
  priority: unknown;
  rn: string | number;
  partition_id: string | null;
  scope_fingerprint: string | null;
}

// Re-export so batchCoordinatorBuild can assemble queue + events from one module
// (stays under import/max-dependencies).
export { PgMergeQueueEventEmitter } from "./coordinatorEvents.js";

function requireNonBlankStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${field} must be an array of non-blank strings`);
  }
  return value;
}

/**
 * The pg-backed native-queue model. Resolves the project's org, then reads/writes
 * the `merge_queue` rows UNDER THAT ORG SCOPE (RLS). A read off the wrong scope
 * sees zero rows, so the snapshot is always exactly the project's own queue.
 */
export class PgMergeQueueModel implements MergeQueueModel {
  private readonly partitions: PgMergeQueuePartitionStore;
  private readonly leaseOwners = new Map<string, { leaseOwner: string; leaseEpoch: number }>();

  constructor(
    private readonly pool: pg.Pool,
    events?: MergeQueueEventEmitter,
  ) {
    this.partitions = new PgMergeQueuePartitionStore(events);
  }

  async enqueue(input: {
    projectId: string;
    runId: string;
    specId: string;
    prUrl: string;
    prNumber: number;
    targetBranch?: string;
    scopeFingerprint?: string;
  }): Promise<{ queueId: string; created: boolean }> {
    const orgId = await resolveProjectOrg(this.pool, input.projectId);
    if (orgId === null) {
      throw new Error(`cannot enqueue run ${input.runId}: project ${input.projectId} has no resolvable org`);
    }
    return runWithOrgScope(this.pool, orgId, async (client) => this.enqueueOnClient(client, orgId, input));
  }

  /**
   * ATOMICITY (PR #724 follow-up — apex v67/v69 root cause #2): the same SELECT-then-INSERT as
   * {@link enqueue} but on a CALLER-SUPPLIED already-scoped client + `orgId` — joins the
   * caller's `runWithOrgScope` so the merge_queue INSERT commits/rolls-back with the companion
   * `github.pr.created` + `merge.scheduled` event appends as ONE unit. Closes PR #724's
   * 3-separate-txn gap. Used by `mergeQueueEarlyEnqueueSeam` + `discoverOrphanedPrs`.
   * Idempotent via the partial unique index `merge_queue_active_run_unique`; the prefetch
   * SELECT reports `created: false` on a re-published PR so the seam skips a duplicate emit.
   */
  async enqueueOnClient(
    client: pg.PoolClient,
    orgId: string,
    input: {
      projectId: string;
      runId: string;
      specId: string;
      prUrl: string;
      prNumber: number;
      targetBranch?: string;
      scopeFingerprint?: string;
    },
  ): Promise<{ queueId: string; created: boolean }> {
    const existing = await client.query<{ queue_id: string }>(
      // in-18: `parked_grant` is a non-terminal active status (it shares the
      // `merge_queue_active_run_unique` partial index), so a re-published PR for a
      // parked run resolves to the existing parked entry — never a duplicate INSERT.
      "SELECT queue_id FROM merge_queue WHERE run_id = $1 AND status IN ('queued','merging','parked_grant') LIMIT 1",
      [input.runId],
    );
    const found = existing.rows[0];
    if (found !== undefined) {
      return { queueId: found.queue_id, created: false };
    }
    const partition = await this.partitions.ensureOnClient(client, {
      orgId,
      projectId: input.projectId,
      specId: input.specId,
      ...(input.targetBranch === undefined ? {} : { targetBranch: input.targetBranch }),
      ...(input.scopeFingerprint === undefined ? {} : { scopeFingerprint: input.scopeFingerprint }),
    });
    const queueId = `mq_${randomUUID()}`;
    await client.query(
      `INSERT INTO merge_queue
         (queue_id, run_id, spec_id, project_id, org_id, status, pr_url, pr_number, partition_id, scope_fingerprint)
       VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8, $9)`,
      [
        queueId,
        input.runId,
        input.specId,
        input.projectId,
        orgId,
        input.prUrl,
        String(input.prNumber),
        partition.id,
        input.scopeFingerprint ?? `spec:${input.specId}`,
      ],
    );
    return { queueId, created: true };
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
        `SELECT mq.org_id, mq.project_id, mq.queue_id, mq.run_id, mq.spec_id, mq.pr_url, mq.pr_number,
                s.depends_on, s.priority, mq.partition_id, mq.scope_fingerprint,
                row_number() OVER (ORDER BY mq.enqueued_at, mq.queue_id) AS rn
           FROM merge_queue mq
           JOIN specs s ON s.spec_id = mq.spec_id
          WHERE mq.project_id = $1 AND mq.status = 'queued'
            AND NOT EXISTS (
              SELECT 1
                FROM merge_queue held
               WHERE held.org_id = mq.org_id
                 AND held.partition_id IS NOT DISTINCT FROM mq.partition_id
                 AND held.status = 'merging'
                 AND held.lease_owner IS NOT NULL
            )
            -- in-18 fail-closed defense: a spec BLOCKED on an integration grant (a
            -- linked capability node is awaiting_grant) is NEVER a merge candidate,
            -- even if its parked_grant transition has not been persisted yet. This
            -- does not clog: independent ready specs still return here and proceed.
            AND NOT EXISTS (
              SELECT 1
                FROM spec_capability_dependencies scd
                JOIN capability_nodes cn
                  ON cn.org_id = scd.org_id AND cn.project_id = scd.project_id
                 AND cn.id = scd.capability_node_id
               WHERE scd.org_id = mq.org_id AND scd.project_id = mq.project_id
                 AND scd.spec_id = mq.spec_id
                 AND cn.status = 'awaiting_grant'
            )`,
        [projectId],
      );
      const entries: MergeQueueEntry[] = entryRows.rows.map((row) => ({
        orgId: row.org_id,
        projectId: row.project_id,
        queueId: row.queue_id,
        runId: row.run_id,
        specId: row.spec_id,
        prUrl: row.pr_url,
        prNumber: Number(row.pr_number),
        // Never coerce corrupt dependency data to an empty set: that would make a
        // malformed spec look dependency-free and let it enter a merge proposal.
        dependsOn: requireNonBlankStringArray(row.depends_on, `spec ${row.spec_id} depends_on`),
        priority: SpecPriority.parse(row.priority),
        orderKey: Number(row.rn),
        ...(row.partition_id === null ? {} : { partitionId: row.partition_id }),
        ...(row.scope_fingerprint === null ? {} : { scopeFingerprint: row.scope_fingerprint }),
      }));

      const merging = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM merge_queue
          WHERE project_id = $1
            AND status = 'merging'
            AND lease_owner IS NOT NULL`,
        [projectId],
      );
      const mergingRow = merging.rows[0];
      const mergingInFlight = entries.length === 0 && Number(mergingRow?.count ?? "0") > 0;

      // The specs that have GENUINELY merged — satisfied ancestors. An unresolved
      // speculative hold is not merged for dependency eligibility, even if a stale
      // status row says otherwise.
      const mergedRows = await client.query<{ spec_id: string }>(
        `SELECT s.spec_id
           FROM specs s
          WHERE s.project_id = $1
            AND s.status = 'merged'
            AND NOT EXISTS (
              SELECT 1
                FROM events held
               WHERE held.project_id = s.project_id
                 AND held.org_id = s.org_id
                 AND held.spec_id = s.spec_id
                 AND held.event_type = 'merge.speculative_held'
                 AND NOT EXISTS (
                   SELECT 1
                     FROM events done
                    WHERE done.project_id = held.project_id
                      AND done.org_id = held.org_id
                      AND done.spec_id = held.spec_id
                      AND done.event_type = 'merge.completed'
                      AND (done.ts > held.ts OR (done.ts = held.ts AND done.id > held.id))
                 )
            )`,
        [projectId],
      );
      const mergedSpecIds = new Set(mergedRows.rows.map((r) => r.spec_id));

      return {
        projectId,
        entries,
        mergedSpecIds,
        mergingInFlight,
      };
    });
  }

  async claim(queueId: string): Promise<boolean> {
    const orgId = await this.resolveQueueOrg(queueId);
    if (orgId === null) return false;
    const lease = await runWithOrgScope(this.pool, orgId, (client) => this.partitions.acquireOnClient(client, queueId));
    if (lease === null) return false;
    this.leaseOwners.set(queueId, { leaseOwner: lease.leaseOwner, leaseEpoch: lease.leaseEpoch });
    return true;
  }

  async renewClaim(queueId: string): Promise<boolean> {
    const held = this.leaseOwners.get(queueId);
    const orgId = await this.resolveQueueOrg(queueId);
    if (held === undefined || orgId === null) return false;
    const renewed = await runWithOrgScope(this.pool, orgId, async (client) => {
      return (
        (await this.partitions.renewOnClient(client, {
          queueId,
          leaseOwner: held.leaseOwner,
          leaseEpoch: held.leaseEpoch,
        })) !== null
      );
    });
    if (!renewed) this.releaseLocalClaim(queueId);
    return renewed;
  }

  async markMerged(queueId: string): Promise<boolean> {
    return this.release(queueId, { nextStatus: "merged" });
  }

  async releaseClaim(queueId: string): Promise<boolean> {
    // Return a claimed entry to `queued` WITHOUT settling it (the entry stays in the
    // queue) — the transient-merge-drive hold path. Only flips a STILL-`merging` row
    // so it cannot resurrect a settled (merged/dequeued) entry.
    return this.release(queueId, { nextStatus: "queued" });
  }

  async markDequeued(queueId: string, reason: DequeueReason): Promise<boolean> {
    return this.release(queueId, { nextStatus: "dequeued", reason });
  }

  async recoverStaleClaims(projectId: string): Promise<number> {
    const orgId = await resolveProjectOrg(this.pool, projectId);
    if (orgId === null) return 0;
    const candidates = await runWithOrgScope(this.pool, orgId, (client) =>
      this.partitions.claimedOnClient(client, projectId),
    );
    let recovered = 0;
    for (const candidate of candidates) {
      const reclaimed = await runWithOrgScope(this.pool, orgId, (client) =>
        this.partitions.reclaimStaleProgressOnClient(client, {
          ...candidate,
          progressStaleAfterMs: MERGE_QUEUE_PROGRESS_RECHECK_MS,
        }),
      );
      if (reclaimed) recovered += 1;
    }
    return recovered;
  }

  async isolateMember(input: {
    queueId: string;
    groupId: string;
    memberId: string;
    reason: "audit_policy" | "member_gate" | "behavior_proof" | "design_proof";
    findingIds: string[];
  }): Promise<boolean> {
    const orgId = await this.resolveQueueOrg(input.queueId);
    if (orgId === null) return false;
    const isolated = await runWithOrgScope(this.pool, orgId, (client) =>
      this.partitions.isolateOnClient(client, input),
    );
    if (isolated) this.releaseLocalClaim(input.queueId);
    return isolated;
  }

  /**
   * in-18 NON-CLOGGING PARK: move every `queued` entry whose spec is grant-blocked
   * (a linked capability node is `awaiting_grant`) to the non-terminal `parked_grant`
   * disposition, recording the blocking node id(s) + wait_reason(s) as `park_reason`.
   * A single UPDATE joining the derived set of grant-blocked specs — idempotent (only
   * `queued` rows move; an already-parked entry is untouched). Org-scoped under RLS.
   */
  async parkGrantBlocked(projectId: string): Promise<number> {
    const orgId = await resolveProjectOrg(this.pool, projectId);
    if (orgId === null) return 0;
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query(
        `UPDATE merge_queue mq
            SET status = 'parked_grant', park_reason = blocked.reason
           FROM (
             SELECT scd.spec_id,
                    'integration_grant_blocked:' ||
                      string_agg(cn.id || '=' || COALESCE(cn.wait_reason, 'awaiting_grant'), ';'
                                 ORDER BY cn.id) AS reason
               FROM spec_capability_dependencies scd
               JOIN capability_nodes cn
                 ON cn.org_id = scd.org_id AND cn.project_id = scd.project_id
                AND cn.id = scd.capability_node_id
              WHERE scd.org_id = $1 AND scd.project_id = $2 AND cn.status = 'awaiting_grant'
              GROUP BY scd.spec_id
           ) blocked
          WHERE mq.org_id = $1 AND mq.project_id = $2 AND mq.status = 'queued'
            AND mq.spec_id = blocked.spec_id`,
        [orgId, projectId],
      );
      return result.rowCount ?? 0;
    });
  }

  /**
   * in-18 FAIL-CLOSED RE-ADMISSION: return a `parked_grant` entry to `queued` (and
   * clear `park_reason`) ONLY on POSITIVE coverage evidence — the spec has at least
   * ONE covering capability node (`enqueued`/`ready`, a state set solely by in-9's
   * `grantCovers`-gated `evaluateAndApply`) AND no uncovered one remains. The
   * EXISTS-covering guard closes the empty-set false-positive (a parked row whose
   * capability rows were deleted has NO covering node → it stays parked, never
   * silently re-queued). A partial/expired/wrong-scope grant (node still
   * `awaiting_grant`) or a genuinely-failed grant (node `needs_attention`) leaves an
   * uncovered node → the entry stays parked. Never a fail-open re-admit. Org-scoped.
   */
  async reAdmitGrantCovered(projectId: string): Promise<number> {
    const orgId = await resolveProjectOrg(this.pool, projectId);
    if (orgId === null) return 0;
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query(
        `UPDATE merge_queue mq
            SET status = 'queued', park_reason = NULL
          WHERE mq.org_id = $1 AND mq.project_id = $2 AND mq.status = 'parked_grant'
            AND EXISTS (
              SELECT 1
                FROM spec_capability_dependencies scd
                JOIN capability_nodes cn
                  ON cn.org_id = scd.org_id AND cn.project_id = scd.project_id
                 AND cn.id = scd.capability_node_id
               WHERE scd.org_id = mq.org_id AND scd.project_id = mq.project_id
                 AND scd.spec_id = mq.spec_id
                 AND cn.status IN ('enqueued', 'ready')
            )
            AND NOT EXISTS (
              SELECT 1
                FROM spec_capability_dependencies scd
                JOIN capability_nodes cn
                  ON cn.org_id = scd.org_id AND cn.project_id = scd.project_id
                 AND cn.id = scd.capability_node_id
               WHERE scd.org_id = mq.org_id AND scd.project_id = mq.project_id
                 AND scd.spec_id = mq.spec_id
                 AND cn.status NOT IN ('enqueued', 'ready')
            )`,
        [orgId, projectId],
      );
      return result.rowCount ?? 0;
    });
  }

  /**
   * in-18 BACKSTOP SUPPORT: how many entries are currently grant-parked for a
   * project. The coordinator uses it to arm a sign-of-life recheck when the only
   * remaining work is parked (no `tanren_run` NOTIFY is guaranteed to re-drive it),
   * so re-admission self-heals even if the event-driven grant wake is missed.
   * Org-scoped under RLS.
   */
  async parkedGrantDepth(projectId: string): Promise<number> {
    const orgId = await resolveProjectOrg(this.pool, projectId);
    if (orgId === null) return 0;
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM merge_queue WHERE org_id = $1 AND project_id = $2 AND status = 'parked_grant'",
        [orgId, projectId],
      );
      return Number(result.rows[0]?.n ?? "0");
    });
  }

  private async release(
    queueId: string,
    input: { nextStatus: "queued" | "merged" | "dequeued"; reason?: DequeueReason },
  ): Promise<boolean> {
    const orgId = await this.resolveQueueOrg(queueId);
    const held = this.leaseOwners.get(queueId);
    if (orgId === null || held === undefined) return false;
    const released = await runWithOrgScope(this.pool, orgId, async (client) => {
      return this.partitions.releaseOnClient(client, { queueId, ...held, ...input });
    });
    this.releaseLocalClaim(queueId);
    return released;
  }

  private releaseLocalClaim(queueId: string): void {
    this.leaseOwners.delete(queueId);
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
 * merge impl. The actual mergeForRun call (with its full up-to-date/conflict-resolution/retarget wiring) is
 * injected as `drive` so this module does not import the heavy run-loop seam graph;
 * the worker boot supplies the same wiring the run loop uses.
 */
export class PgMergeRunner implements MergeRunner {
  constructor(private readonly drive: DriveMergeForQueuedRun) {}

  async driveMerge(input: {
    runId: string;
    projectId: string;
    onWatchdogProgress?: (signal: WatchdogProgressSignal) => void;
    claimSignal?: AbortSignal;
    confirmClaimBeforeLand?: () => Promise<boolean>;
  }): Promise<MergeDriveOutcome> {
    return this.drive(input);
  }
}
