// rv-premerge — resolve a run's DECLARED behavior ids to their ACTIVE `behavior_revision` ids
// (org-scoped, RLS). The pre-merge behavior gate hydrates `context.behaviorIds` from
// `spec_behaviors` (behavior ids), but the rv-11 plan loader keys on `behavior_revisions.id`
// (revision ids). This resolver bridges them: the CURRENT revision of a behavior is its single
// `status = 'active'` row (migration 0034 keeps exactly one active revision per behavior). A
// behavior with no active revision is intentionally OMITTED — the producer treats a declared
// set that resolves to zero active revisions as fail-closed (unverifiable), never a pass.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { type BehaviorRevisionId, parseBehaviorRevisionId } from "../contracts/behaviorRevision.js";
import type { BehaviorRevisionResolver } from "../verification/preMerge/preMergeBehaviorGateProducer.js";

/** Postgres resolver over the org-scoped, RLS-forced `behavior_revisions` table. */
export class PgBehaviorRevisionResolver implements BehaviorRevisionResolver {
  public constructor(private readonly pool: pg.Pool) {}

  public async resolveActive(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly behaviorIds: readonly string[];
  }): Promise<readonly BehaviorRevisionId[]> {
    if (input.behaviorIds.length === 0) return [];
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id
           FROM behavior_revisions
          WHERE org_id = $1
            AND status = 'active'
            AND behavior_id = ANY($2::text[])
            AND (project_id = $3 OR project_id IS NULL)
          ORDER BY behavior_id, id`,
        [input.orgId, [...input.behaviorIds], input.projectId],
      );
      return result.rows.map((row) => parseBehaviorRevisionId(row.id));
    });
  }
}
