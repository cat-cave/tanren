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
  type SettleQueryClient,
  type SupersededEntry,
} from "../contracts/mergeCoordinator.js";
import { PgEventStore } from "../eventStore.js";
import { ClientBoundMergeQueueEventEmitter } from "./coordinatorEvents.js";
import {
  type DriveMergeForQueuedRun,
  type MergeQueueEventEmitter,
  type MergeSettleTransaction,
} from "./coordinator.js";
import { MERGE_CLAIM_LEASE_MS } from "./mergeClaimLease.js";
import { parseSerializedRetryAfterMs } from "./mergeSerializedRetry.js";

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

const RECOVER_DEQUEUED_CANDIDATES_SQL = `
WITH candidates AS (
  SELECT mq.queue_id, mq.run_id, mq.dequeue_reason, mq.pr_url, mq.pr_number, anchor.ts AS anchor_ts, anchor.id AS anchor_id
  FROM merge_queue mq
  JOIN LATERAL (
    SELECT e.ts, e.id FROM events e
    WHERE e.project_id = mq.project_id AND e.org_id = mq.org_id
      AND (
        (e.event_type = 'merge.dequeued' AND e.payload ->> 'integration' = 'native_queue' AND e.payload ->> 'reason' = 'blocked')
        OR (e.event_type = 'merge.batch.infra_blocked' AND e.payload ->> 'terminal' = 'true'
          AND COALESCE(e.payload ->> 'kind', '') <> 'ambiguous_merge_state'
          AND COALESCE(e.payload ->> 'message', '') NOT LIKE '%ambiguous%'
          AND COALESCE(e.payload ->> 'message', '') NOT LIKE '%double-merge%'
          AND (NOT COALESCE((e.payload ->> 'kind' IN ('missing_required_credential', 'missing_github_credential')
            OR e.payload ->> 'cause' IN ('missing_required_credential', 'missing_github_credential')
            OR e.payload ->> 'reason' IN ('missing_required_credential', 'missing_github_credential')
            OR e.payload ->> 'message' LIKE '%missing GitHub credential ref:%'
            OR e.payload ->> 'message' LIKE '%missing % credential ref:%'
            OR e.payload ->> 'message' LIKE '%No GitHub credential configured%'), false)
            OR EXISTS (
              SELECT 1 FROM events repair
              CROSS JOIN LATERAL (SELECT COALESCE(NULLIF(e.payload ->> 'credentialRef', ''), NULLIF(e.payload ->> 'missingRef', ''), NULLIF(e.payload ->> 'requiredCredentialRef', ''), substring(e.payload ->> 'message' from 'missing [^:]* credential ref: ([^[:space:]]+)')) AS missing_ref) missing
              WHERE repair.project_id = mq.project_id AND repair.org_id = mq.org_id
                AND (repair.ts > e.ts OR (repair.ts = e.ts AND repair.id > e.id))
                AND ((repair.event_type = 'integration.provisioned' AND repair.payload ->> 'providerKind' = 'github')
                  OR repair.event_type IN ('org.github.connected', 'credential.github.configured')
                  OR repair.payload ->> 'provider' = 'github'
                  OR repair.payload ->> 'mode' = 'app'
                  OR repair.payload ->> 'credentialKind' IN ('github_app', 'github_token')
                  OR (missing.missing_ref ~ '^credential/(github|github_token|github_app)/' AND (repair.payload ->> 'credentialRef' = missing.missing_ref OR repair.payload ->> 'ref' = missing.missing_ref
                    OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(repair.payload -> 'secretRefNames') = 'array' THEN repair.payload -> 'secretRefNames' ELSE '[]'::jsonb END) AS secret_ref(ref) WHERE secret_ref.ref = missing.missing_ref))))
                AND (missing.missing_ref IS NULL OR repair.payload ->> 'mode' = 'app' OR repair.payload ->> 'credentialKind' = 'github_app'
                  OR repair.payload ->> 'credentialRef' = missing.missing_ref OR repair.payload ->> 'ref' = missing.missing_ref
                  OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(repair.payload -> 'secretRefNames') = 'array' THEN repair.payload -> 'secretRefNames' ELSE '[]'::jsonb END) AS secret_ref(ref) WHERE secret_ref.ref = missing.missing_ref)))))
      )
      AND ((e.run_id IS NOT NULL AND e.run_id = mq.run_id)
        OR (NULLIF(e.payload ->> 'runId', '') IS NOT NULL AND e.payload ->> 'runId' = mq.run_id)
        OR (NULLIF(e.payload ->> 'prUrl', '') IS NOT NULL AND e.payload ->> 'prUrl' = mq.pr_url)
        OR (NULLIF(e.payload ->> 'prNumber', '') IS NOT NULL AND e.payload ->> 'prNumber' = mq.pr_number)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload -> 'members') = 'array' THEN e.payload -> 'members' ELSE '[]'::jsonb END) AS member WHERE member ->> 'prNumber' = mq.pr_number OR member ->> 'specId' = mq.spec_id))
    ORDER BY e.ts DESC, e.id DESC LIMIT 1
  ) anchor ON TRUE
  WHERE mq.project_id = $1 AND mq.status = 'dequeued' AND mq.dequeue_reason = 'blocked'
    AND mq.pr_url IS NOT NULL AND mq.pr_url <> '' AND mq.pr_number IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM merge_queue active WHERE active.run_id = mq.run_id AND active.status IN ('queued', 'merging'))
    AND NOT EXISTS (
      SELECT 1 FROM events e
      WHERE e.project_id = mq.project_id AND e.org_id = mq.org_id
        AND (e.ts > anchor.ts OR (e.ts = anchor.ts AND e.id > anchor.id))
        AND (e.event_type IN ('merge.completed', 'merge.queue.infra_blocked', 'merge.batch.culprit', 'dag.spec.needs_attention', 'dag.spec.percolation_replan', 'merge.conflict.replan_routed', 'recovery.replan_queued')
          OR (e.event_type = 'merge.batch.infra_blocked' AND e.payload ->> 'terminal' = 'true'
            AND (e.payload ->> 'kind' = 'ambiguous_merge_state' OR e.payload ->> 'message' LIKE '%ambiguous%' OR e.payload ->> 'message' LIKE '%double-merge%'
              OR ((e.payload ->> 'kind' IN ('missing_required_credential', 'missing_github_credential')
                OR e.payload ->> 'cause' IN ('missing_required_credential', 'missing_github_credential')
                OR e.payload ->> 'reason' IN ('missing_required_credential', 'missing_github_credential')
                OR e.payload ->> 'message' LIKE '%missing GitHub credential ref:%'
                OR e.payload ->> 'message' LIKE '%missing % credential ref:%'
                OR e.payload ->> 'message' LIKE '%No GitHub credential configured%')
                AND NOT EXISTS (
                  SELECT 1 FROM events repair
                  CROSS JOIN LATERAL (SELECT COALESCE(NULLIF(e.payload ->> 'credentialRef', ''), NULLIF(e.payload ->> 'missingRef', ''), NULLIF(e.payload ->> 'requiredCredentialRef', ''), substring(e.payload ->> 'message' from 'missing [^:]* credential ref: ([^[:space:]]+)')) AS missing_ref) missing
                  WHERE repair.project_id = mq.project_id AND repair.org_id = mq.org_id
                    AND (repair.ts > e.ts OR (repair.ts = e.ts AND repair.id > e.id))
                    AND ((repair.event_type = 'integration.provisioned' AND repair.payload ->> 'providerKind' = 'github')
                      OR repair.event_type IN ('org.github.connected', 'credential.github.configured')
                      OR repair.payload ->> 'provider' = 'github'
                      OR repair.payload ->> 'mode' = 'app'
                      OR repair.payload ->> 'credentialKind' IN ('github_app', 'github_token')
                      OR (missing.missing_ref ~ '^credential/(github|github_token|github_app)/' AND (repair.payload ->> 'credentialRef' = missing.missing_ref OR repair.payload ->> 'ref' = missing.missing_ref
                        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(repair.payload -> 'secretRefNames') = 'array' THEN repair.payload -> 'secretRefNames' ELSE '[]'::jsonb END) AS secret_ref(ref) WHERE secret_ref.ref = missing.missing_ref))))
                    AND (missing.missing_ref IS NULL OR repair.payload ->> 'mode' = 'app' OR repair.payload ->> 'credentialKind' = 'github_app'
                      OR repair.payload ->> 'credentialRef' = missing.missing_ref OR repair.payload ->> 'ref' = missing.missing_ref
                      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(repair.payload -> 'secretRefNames') = 'array' THEN repair.payload -> 'secretRefNames' ELSE '[]'::jsonb END) AS secret_ref(ref) WHERE secret_ref.ref = missing.missing_ref)))))))
        AND ((e.run_id IS NOT NULL AND e.run_id = mq.run_id)
          OR (NULLIF(e.payload ->> 'runId', '') IS NOT NULL AND e.payload ->> 'runId' = mq.run_id)
          OR (NULLIF(e.payload ->> 'prUrl', '') IS NOT NULL AND e.payload ->> 'prUrl' = mq.pr_url)
          OR (NULLIF(e.payload ->> 'prNumber', '') IS NOT NULL AND e.payload ->> 'prNumber' = mq.pr_number)
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload -> 'members') = 'array' THEN e.payload -> 'members' ELSE '[]'::jsonb END) AS member WHERE member ->> 'prNumber' = mq.pr_number OR member ->> 'specId' = mq.spec_id)
          OR (e.event_type IN ('dag.spec.needs_attention', 'dag.spec.percolation_replan', 'merge.conflict.replan_routed', 'recovery.replan_queued') AND e.spec_id = mq.spec_id))
    )
  FOR UPDATE OF mq
), recoverable AS (
  SELECT c.queue_id, c.run_id, c.dequeue_reason, c.pr_url, c.pr_number FROM candidates c
  WHERE NOT EXISTS (SELECT 1 FROM merge_queue active WHERE active.run_id = c.run_id AND active.status IN ('queued', 'merging'))
)
UPDATE merge_queue mq SET status = 'queued', dequeue_reason = NULL, claimed_at = NULL, settled_at = NULL
FROM recoverable
WHERE mq.queue_id = recoverable.queue_id AND mq.status = 'dequeued'
  AND mq.dequeue_reason = recoverable.dequeue_reason AND mq.pr_url = recoverable.pr_url AND mq.pr_number = recoverable.pr_number
  AND NOT EXISTS (SELECT 1 FROM merge_queue active WHERE active.run_id = recoverable.run_id AND active.status IN ('queued', 'merging'))`;

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
    },
  ): Promise<{ queueId: string; created: boolean }> {
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

      const merging = await client.query<{ count: string; retry_after_ms: string | null }>(
        `SELECT count(*)::text AS count,
                ceil(greatest(0, extract(epoch from ((min(claimed_at) + ($2::bigint * interval '1 millisecond')) - now())) * 1000))::text AS retry_after_ms
           FROM merge_queue
          WHERE project_id = $1
            AND status = 'merging'`,
        [projectId, MERGE_CLAIM_LEASE_MS],
      );
      const mergingRow = merging.rows[0];
      const mergingInFlight = Number(mergingRow?.count ?? "0") > 0;
      const serializedRetryAfterMs = parseSerializedRetryAfterMs(mergingRow?.retry_after_ms);

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
        ...(mergingInFlight && serializedRetryAfterMs !== undefined && { serializedRetryAfterMs }),
      };
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

  async releaseClaim(queueId: string): Promise<void> {
    // Return a claimed entry to `queued` WITHOUT settling it (the entry stays in the
    // queue) — the transient-merge-drive hold path. Only flips a STILL-`merging` row
    // so it cannot resurrect a settled (merged/dequeued) entry.
    await this.settle(
      queueId,
      "UPDATE merge_queue SET status = 'queued', claimed_at = NULL WHERE queue_id = $1 AND status = 'merging'",
      [],
    );
  }


  async markDequeued(queueId: string, reason: DequeueReason): Promise<void> {
    await this.settle(
      queueId,
      "UPDATE merge_queue SET status = 'dequeued', dequeue_reason = $2, settled_at = now() WHERE queue_id = $1",
      [reason],
    );
  }

  // ATOMICITY (audit RC-4 #3): the same dequeue UPDATE as markDequeued but on a
  // CALLER-SUPPLIED already-scoped client, so it joins the settle transaction that
  // also appended the durable event — both commit or both roll back. The client must
  // already carry the entry's org scope (PgMergeSettleTransaction opens it).
  async markDequeuedOnClient(client: SettleQueryClient, queueId: string, reason: DequeueReason): Promise<void> {
    await client.query(
      "UPDATE merge_queue SET status = 'dequeued', dequeue_reason = $2, settled_at = now() WHERE queue_id = $1",
      [queueId, reason],
    );
  }

  async supersedePriorRunEntry(runId: string): Promise<SupersededEntry | undefined> {
    const orgId = await this.resolveRunOrg(runId);
    if (orgId === null) return undefined;
    return runWithOrgScope(this.pool, orgId, async (client): Promise<SupersededEntry | undefined> => {
      // Atomically retire the prior run's ACTIVE (queued/merging) entry — the partial
      // unique index guarantees at most one — so the spec stops having two live
      // entries (the percolation self-conflict). `RETURNING` carries the spec/PR facts
      // for the observable `merge.dequeued` event. Idempotent: a run with no active
      // entry (already superseded / never queued) matches no row ⇒ undefined.
      const result = await client.query<{
        queue_id: string;
        spec_id: string;
        pr_url: string;
        pr_number: string;
      }>(
        `UPDATE merge_queue
            SET status = 'dequeued', dequeue_reason = 'superseded', settled_at = now()
          WHERE run_id = $1 AND status IN ('queued', 'merging')
        RETURNING queue_id, spec_id, pr_url, pr_number`,
        [runId],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return {
        queueId: row.queue_id,
        runId,
        specId: row.spec_id,
        prUrl: row.pr_url,
        prNumber: Number(row.pr_number),
      };
    });
  }

  /** Resolve a run's org (system-scoped) so the superseding write hits its row. */
  private async resolveRunOrg(runId: string): Promise<string | null> {
    return runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>("SELECT org_id FROM runs WHERE run_id = $1", [
        runId,
      ]);
      return result.rows[0]?.org_id ?? null;
    });
  }

  async recoverStaleClaims(projectId: string): Promise<number> {
    const orgId = await resolveProjectOrg(this.pool, projectId);
    if (orgId === null) return 0;
    return runWithOrgScope(this.pool, orgId, async (client) => {
      // A coordinator died mid-merge: return its STALE `merging` rows to `queued` so
      // the queue is recoverable. ONLY a claim older than the lease is reclaimed — a
      // fresh, legitimately in-flight `merging` claim SURVIVES (a concurrent
      // coordinate pass must not reset + double-drive an active merge). A
      // never-claimed row (claimed_at NULL) is also reclaimed (an inconsistent
      // state). The GitHub merge is idempotent, so re-queuing a genuinely-dead
      // claim is safe.
      const result = await client.query(
        `UPDATE merge_queue
            SET status = 'queued', claimed_at = NULL
          WHERE project_id = $1
            AND status = 'merging'
            AND (claimed_at IS NULL OR claimed_at < now() - ($2::bigint * interval '1 millisecond'))`,
        [projectId, MERGE_CLAIM_LEASE_MS],
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
 * merge impl. The actual mergeForRun call (with its full up-to-date/conflict-resolution/retarget wiring) is
 * injected as `drive` so this module does not import the heavy run-loop seam graph;
 * the worker boot supplies the same wiring the run loop uses.
 */
export class PgMergeRunner implements MergeRunner {
  constructor(private readonly drive: DriveMergeForQueuedRun) {}

  async driveMerge(input: { runId: string; projectId: string }): Promise<MergeDriveOutcome> {
    return this.drive(input);
  }
}

/**
 * ATOMICITY SEAM (audit RC-4 #3): the pg-backed both-or-neither settle transaction.
 * Resolves the project's org, opens ONE `runWithOrgScope` transaction, and threads its
 * single client through BOTH the durable event append (a `ClientBoundMergeQueueEventEmitter`
 * over `PgEventStore(client)`) AND the `merge_queue` dequeue UPDATE
 * (`markDequeuedOnClient` on the SAME client). They therefore COMMIT together or ROLL
 * BACK together — closing the crash-between-writes split brain where the event bus said
 * "dequeued" while the row stayed `merging`. The event-first ordering inside `work` is
 * preserved by the caller (`markDequeuedAfterEvent`).
 *
 * Wire ONLY when the pool can INSERT `events` (Direct / `canCoTransactMergeSettle`).
 * Plane-split dataplane REVOKE INSERT on `events` makes co-tx throw 42501 on every
 * coordinate dequeue (apex v87); omit `tx` for sequential event-first via the writer.
 */
export class PgMergeSettleTransaction implements MergeSettleTransaction {
  constructor(
    private readonly pool: pg.Pool,
    private readonly model: PgMergeQueueModel,
  ) {}

  async run(
    projectId: string,
    work: (ctx: { events: MergeQueueEventEmitter; queue: MergeQueueModel }) => Promise<void>,
  ): Promise<void> {
    const orgId = await resolveProjectOrg(this.pool, projectId);
    if (orgId === null) {
      throw new Error(`cannot settle merge queue for project ${projectId}: no resolvable org`);
    }
    await runWithOrgScope(this.pool, orgId, async (client) => {
      const events = new ClientBoundMergeQueueEventEmitter(new PgEventStore(client), orgId);
      // A queue facade that delegates to the model but routes the ONE settle write
      // (`markDequeued`) onto THIS transaction's client. Every other method delegates
      // verbatim — none is invoked inside the settle unit, but delegating keeps the
      // facade a faithful MergeQueueModel.
      const queue = makeClientScopedSettleQueue(this.model, client);
      await work({ events, queue });
    });
  }
}

/**
 * Build a {@link MergeQueueModel} facade for the settle transaction: its `markDequeued`
 * writes on the supplied (already-scoped) `client` via `markDequeuedOnClient`, so it
 * shares the settle transaction; every other method delegates to `model` unchanged.
 */
function makeClientScopedSettleQueue(model: PgMergeQueueModel, client: SettleQueryClient): MergeQueueModel {
  return {
    enqueue: (input) => model.enqueue(input),
    loadSnapshot: (projectId) => model.loadSnapshot(projectId),
    claim: (queueId) => model.claim(queueId),
    markMerged: (queueId) => model.markMerged(queueId),
    releaseClaim: (queueId) => model.releaseClaim(queueId),
    markDequeued: (queueId, reason) => model.markDequeuedOnClient(client, queueId, reason),
    markDequeuedOnClient: (c, queueId, reason) => model.markDequeuedOnClient(c, queueId, reason),
    supersedePriorRunEntry: (runId) => model.supersedePriorRunEntry(runId),
    recoverStaleClaims: (projectId) => model.recoverStaleClaims(projectId),
  };
}
