// rv-premerge — resolve a run's DECLARED behavior ids to the ONE canonical ACTIVE
// `behavior_revision` each is verified against (org-scoped, RLS). The pre-merge behavior gate
// hydrates `context.behaviorIds` from `spec_behaviors` (behavior ids), but the rv-11 plan loader
// keys on `behavior_revisions.id` (revision ids). This resolver bridges them.
//
// EXACTLY ONE revision per behavior (SET coverage, not count): there is NO unique-active index,
// and a behavior can carry BOTH a project-scoped and a `project_id IS NULL` global active row.
// A raw list would let one behavior's TWO active rows pad the count while a peer with ZERO active
// rows is silently dropped. So this returns `DISTINCT ON (behavior_id)` — the deterministic
// canonical revision (project-scoped preferred over global, then highest revision_number) — and a
// behavior with no active revision is OMITTED, so the producer's SET-coverage check blocks it.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { parseBehaviorRevisionId } from "../contracts/behaviorRevision.js";
import type {
  BehaviorRevisionResolver,
  ResolvedBehaviorRevision,
} from "../verification/preMerge/preMergeBehaviorGateProducer.js";

/** Postgres resolver over the org-scoped, RLS-forced `behavior_revisions` table. */
export class PgBehaviorRevisionResolver implements BehaviorRevisionResolver {
  public constructor(private readonly pool: pg.Pool) {}

  public async resolveActive(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly behaviorIds: readonly string[];
  }): Promise<readonly ResolvedBehaviorRevision[]> {
    if (input.behaviorIds.length === 0) return [];
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<{ behavior_id: string; id: string }>(
        `SELECT DISTINCT ON (behavior_id) behavior_id, id
           FROM behavior_revisions
          WHERE org_id = $1
            AND status = 'active'
            AND behavior_id = ANY($2::text[])
            AND (project_id = $3 OR project_id IS NULL)
          ORDER BY behavior_id, (project_id IS NULL) ASC, revision_number DESC, id DESC`,
        [input.orgId, [...input.behaviorIds], input.projectId],
      );
      return result.rows.map((row) => ({ behaviorId: row.behavior_id, revisionId: parseBehaviorRevisionId(row.id) }));
    });
  }
}
