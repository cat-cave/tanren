/**
 * rv-6 A2: loads a behavior's executable acceptance plan from its STORED
 * revision. It reads `behavior_revisions.acceptance` under org scope (RLS
 * denies cross-org rows) and compiles each row through {@link compileAcceptancePlan}.
 * A missing revision or a malformed stored spec fails loud — a run never
 * proceeds on a fabricated or silently-empty plan.
 */

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { parseBehaviorRevisionId, type BehaviorRevisionId } from "../../contracts/behaviorRevision.js";
import type { AcceptancePlan } from "./orchestrator.js";
import { compileAcceptancePlan } from "./planLoader.js";

export class BehaviorRevisionNotFoundError extends Error {
  public override readonly name = "BehaviorRevisionNotFoundError";

  public constructor(
    public readonly orgId: string,
    public readonly behaviorRevisionId: string,
  ) {
    super(`behavior revision ${behaviorRevisionId} not found for org ${orgId}`);
  }
}

export interface AcceptancePlanLoader {
  loadPlans(input: {
    readonly orgId: string;
    readonly behaviorRevisionIds: readonly string[];
  }): Promise<readonly AcceptancePlan[]>;
}

interface AcceptanceRow {
  readonly id: string;
  readonly persona_revision_id: string;
  readonly content_digest: string;
  readonly acceptance: unknown;
}

export class PgAcceptancePlanLoader implements AcceptancePlanLoader {
  public constructor(private readonly pool: pg.Pool) {}

  public async loadPlans(input: {
    readonly orgId: string;
    readonly behaviorRevisionIds: readonly string[];
  }): Promise<readonly AcceptancePlan[]> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const plans: AcceptancePlan[] = [];
      for (const rawId of input.behaviorRevisionIds) {
        const behaviorRevisionId: BehaviorRevisionId = parseBehaviorRevisionId(rawId);
        const result = await client.query<AcceptanceRow>(
          "SELECT id, persona_revision_id, content_digest, acceptance FROM behavior_revisions WHERE org_id = $1 AND id = $2",
          [input.orgId, behaviorRevisionId],
        );
        const row = result.rows[0];
        if (row === undefined) throw new BehaviorRevisionNotFoundError(input.orgId, rawId);
        plans.push(
          compileAcceptancePlan({
            id: behaviorRevisionId,
            personaRevisionId: row.persona_revision_id,
            behaviorRevisionHash: row.content_digest,
            acceptance: (row.acceptance ?? {}) as Readonly<Record<string, unknown>>,
          }),
        );
      }
      return plans;
    });
  }
}
