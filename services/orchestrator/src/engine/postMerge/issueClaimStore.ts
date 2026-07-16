// The cross-process atomic "file once per merge" guard for the post-merge-failure
// watcher (tempering.md dim A). Postgres `NOTIFY` fans the run-activity wake out
// to EVERY LISTENing worker in the fleet, so the file-once guard CANNOT be an
// in-process read-then-write (two workers would both see "not filed" and both open
// an issue). This is the single atomic serialization point — a unique claim keyed
// on `run_id` — that exactly one process wins before it calls `createIssue`,
// mirroring `merge_queue.claim`'s conditional-write lock.
//
// Lifecycle: `claim()` performs `INSERT ... ON CONFLICT (run_id) DO NOTHING
// RETURNING` — only the process whose INSERT CREATED the row gets `true`; every
// other worker's INSERT touches 0 rows and gets `false` (it skips). The winner
// opens the issue, then `markFiled()` (the durable terminal idempotency marker).
// On a `createIssue` FAILURE the winner calls `release()` (DELETE the claim) so a
// later wake re-reads the still-failing CI and re-claims + retries — at-most-once
// issue, but a transient GitHub error never permanently suppresses it. A crashed
// winner that never filed nor released is reclaimable past a lease.

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";

/** How long a `claimed` (not-yet-`filed`) row is fresh before a crashed winner's claim is reclaimable. */
export const POST_MERGE_CLAIM_LEASE_MS = 15 * 60 * 1000;

export interface PostMergeIssueClaimInput {
  runId: string;
  specId: string;
  projectId: string;
  orgId: string;
}

/**
 * The atomic per-merge issue-claim store. `claim` is the cross-process lock; the
 * other methods settle/release it. An in-memory fake (tests/) implements the same
 * contract for the race test.
 */
export interface PostMergeIssueClaimStore {
  /**
   * Atomically claim the right to file the issue for `runId`. Returns `true` for
   * EXACTLY ONE caller across the fleet (the one whose INSERT created the row, or
   * the one that reclaimed a stale crashed claim); `false` for everyone else
   * (a row already exists — claimed-in-flight or already filed). Never throws on
   * contention.
   */
  claim(input: PostMergeIssueClaimInput): Promise<boolean>;
  /** Mark the claim `filed` (the durable terminal idempotency marker) after the issue opened. */
  markFiled(runId: string, issue: { url: string; number: number }): Promise<void>;
  /** Release the claim (DELETE) so a later wake can retry — used on a createIssue FAILURE. */
  release(runId: string): Promise<void>;
  /**
   * Cheap NON-atomic fast-path: is there ALREADY a claim row for this run (claimed
   * in-flight OR filed)? Lets a repeated wake skip the base-branch CI read once the
   * merge is handled. This is ONLY an optimization — the atomic {@link claim} is the
   * real guard, so a stale `false` here can never cause a duplicate issue.
   */
  exists(runId: string): Promise<boolean>;
}

/** The Postgres-backed claim store (org-scoped under RLS, like merge_queue). */
export class PgPostMergeIssueClaimStore implements PostMergeIssueClaimStore {
  constructor(private readonly pool: pg.Pool) {}

  async claim(input: PostMergeIssueClaimInput): Promise<boolean> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      // First reclaim a STALE crashed claim (claimed past the lease, never filed):
      // delete it so the INSERT below can re-create it. A FILED row is terminal and
      // never reclaimed; a FRESH claimed row (a live winner mid-file) survives.
      await client.query(
        `DELETE FROM post_merge_issue_claims
           WHERE run_id = $1
             AND status = 'claimed'
             AND claimed_at < now() - ($2::bigint * interval '1 millisecond')`,
        [input.runId, POST_MERGE_CLAIM_LEASE_MS],
      );
      // The atomic lock: only the INSERT that CREATES the row returns it. A row that
      // already exists (claimed-in-flight or filed) yields DO NOTHING → 0 rows → lose.
      const result = await client.query(
        `INSERT INTO post_merge_issue_claims (run_id, spec_id, project_id, org_id, status)
           VALUES ($1, $2, $3, $4, 'claimed')
         ON CONFLICT (run_id) DO NOTHING
         RETURNING run_id`,
        [input.runId, input.specId, input.projectId, input.orgId],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  async markFiled(runId: string, issue: { url: string; number: number }): Promise<void> {
    const orgId = await this.resolveRunOrg(runId);
    if (orgId === null) return;
    await runWithOrgScope(this.pool, orgId, async (client) => {
      await client.query(
        `UPDATE post_merge_issue_claims
            SET status = 'filed', issue_url = $2, issue_number = $3, filed_at = now()
          WHERE run_id = $1 AND status = 'claimed'`,
        [runId, issue.url, String(issue.number)],
      );
    });
  }

  async release(runId: string): Promise<void> {
    const orgId = await this.resolveRunOrg(runId);
    if (orgId === null) return;
    await runWithOrgScope(this.pool, orgId, async (client) => {
      // Only release a not-yet-filed claim — never undo a row that already filed.
      await client.query("DELETE FROM post_merge_issue_claims WHERE run_id = $1 AND status = 'claimed'", [runId]);
    });
  }

  async exists(runId: string): Promise<boolean> {
    // System-scoped existence probe (the bus payload is run-only; this is the cheap
    // pre-CI-read skip — a `claimed`-in-flight row past its lease is treated as
    // absent so a crashed winner does not block the fast-path's re-evaluation).
    return runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM post_merge_issue_claims c
             JOIN runs r
               ON r.run_id = c.run_id AND r.org_id = c.org_id
              AND r.project_id = c.project_id AND r.spec_id = c.spec_id
             JOIN projects p ON p.project_id = r.project_id AND p.org_id = r.org_id
             JOIN specs s ON s.spec_id = r.spec_id AND s.project_id = r.project_id AND s.org_id = r.org_id
            WHERE c.run_id = $1
              AND (c.status = 'filed'
                   OR c.claimed_at >= now() - ($2::bigint * interval '1 millisecond'))
         ) AS exists`,
        [runId, POST_MERGE_CLAIM_LEASE_MS],
      );
      return result.rows[0]?.exists ?? false;
    });
  }

  /** Resolve the claim row's org (the claim INSERT already stamped it), system-scoped. */
  private async resolveRunOrg(runId: string): Promise<string | null> {
    return runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{
        claim_org_id: string;
        claim_project_id: string;
        claim_spec_id: string;
        run_org_id: string | null;
        run_project_id: string | null;
        run_spec_id: string | null;
        project_org_id: string | null;
        spec_org_id: string | null;
        spec_project_id: string | null;
      }>(
        `SELECT c.org_id AS claim_org_id, c.project_id AS claim_project_id, c.spec_id AS claim_spec_id,
                r.org_id AS run_org_id, r.project_id AS run_project_id, r.spec_id AS run_spec_id,
                p.org_id AS project_org_id, s.org_id AS spec_org_id, s.project_id AS spec_project_id
           FROM post_merge_issue_claims c
           LEFT JOIN runs r ON r.run_id = c.run_id
           LEFT JOIN projects p ON p.project_id = r.project_id
           LEFT JOIN specs s ON s.spec_id = r.spec_id
          WHERE c.run_id = $1`,
        [runId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      if (
        row.run_org_id === null ||
        row.run_project_id === null ||
        row.run_spec_id === null ||
        row.project_org_id !== row.run_org_id ||
        row.spec_org_id !== row.run_org_id ||
        row.spec_project_id !== row.run_project_id ||
        row.claim_org_id !== row.run_org_id ||
        row.claim_project_id !== row.run_project_id ||
        row.claim_spec_id !== row.run_spec_id
      ) {
        throw new Error(`post-merge issue claim lineage mismatch for run '${runId}'`);
      }
      return row.run_org_id;
    });
  }
}
