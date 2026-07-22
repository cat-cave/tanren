/**
 * rv-6 A2 + rv-3: loads a behavior's executable acceptance plan from its STORED
 * revision. It reads `behavior_revisions.acceptance` under org scope (RLS denies
 * cross-org rows) and compiles each row through {@link compileAndBindAcceptancePlan}
 * — the rv-3 registry-backed compile that RESOLVES every cited verification-capability
 * fragment from the registry (or F2-authors it when an authoring seam is configured,
 * fail-closed) and binds the resolved refs into the plan. A missing revision or a
 * malformed stored spec fails loud — a run never proceeds on a fabricated or
 * silently-empty plan.
 */

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { parseBehaviorRevisionId, type BehaviorRevisionId } from "../../contracts/behaviorRevision.js";
import {
  PgVerificationFragmentStore,
  type VerificationFragmentStore,
} from "../../repositories/verificationFragmentStore.js";
import type { AcceptancePlan } from "./orchestrator.js";
import { PgAcceptanceEventSink, type AcceptanceEventSink } from "./eventSink.js";
import {
  compileAndBindAcceptancePlan,
  type PlanCapabilityAuthoring,
} from "./fragments/verificationFragmentRegistry.js";

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

/** Optional construction seam. Omit `authoring` (the common path) → a cited-but-missing
 * capability HALTS LOUD; supply it (the plan-production path with a real answerer) →
 * a missing capability is F2-authored (writer→validate convergent) then bound. */
export interface PgAcceptancePlanLoaderOptions {
  readonly store?: VerificationFragmentStore;
  readonly authoring?: PlanCapabilityAuthoring;
  /** The production loader always appends lifecycle facts through this canonical sink. */
  readonly events?: AcceptanceEventSink;
}

interface AcceptanceRow {
  readonly id: string;
  readonly project_id: string | null;
  readonly persona_revision_id: string;
  readonly content_digest: string;
  readonly acceptance: unknown;
}

export class PgAcceptancePlanLoader implements AcceptancePlanLoader {
  private readonly store: VerificationFragmentStore;
  private readonly authoring?: PlanCapabilityAuthoring;
  private readonly events: AcceptanceEventSink;

  public constructor(
    private readonly pool: pg.Pool,
    options: PgAcceptancePlanLoaderOptions = {},
  ) {
    this.store = options.store ?? new PgVerificationFragmentStore(pool);
    this.events = options.events ?? new PgAcceptanceEventSink(pool);
    if (options.authoring !== undefined) this.authoring = options.authoring;
  }

  public async loadPlans(input: {
    readonly orgId: string;
    readonly behaviorRevisionIds: readonly string[];
  }): Promise<readonly AcceptancePlan[]> {
    const rows = await runWithOrgScope(this.pool, input.orgId, async (client) => {
      const collected: AcceptanceRow[] = [];
      for (const rawId of input.behaviorRevisionIds) {
        const behaviorRevisionId: BehaviorRevisionId = parseBehaviorRevisionId(rawId);
        const result = await client.query<AcceptanceRow>(
          "SELECT id, project_id, persona_revision_id, content_digest, acceptance FROM behavior_revisions WHERE org_id = $1 AND id = $2",
          [input.orgId, behaviorRevisionId],
        );
        const row = result.rows[0];
        if (row === undefined) throw new BehaviorRevisionNotFoundError(input.orgId, rawId);
        collected.push(row);
      }
      return collected;
    });

    // Capability resolution + F2 authoring + durable binding run on their own
    // org-scoped transactions (the store opens them), so they are OUTSIDE the read
    // transaction above — a fragment the kernel commits is visible to a re-resolve.
    const plans: AcceptancePlan[] = [];
    for (const row of rows) {
      plans.push(
        await compileAndBindAcceptancePlan({
          revision: {
            id: row.id,
            personaRevisionId: row.persona_revision_id,
            behaviorRevisionHash: row.content_digest,
            acceptance: (row.acceptance ?? {}) as Readonly<Record<string, unknown>>,
          },
          orgId: input.orgId,
          projectId: row.project_id ?? "",
          store: this.store,
          events: this.events,
          ...(this.authoring === undefined ? {} : { authoring: this.authoring }),
        }),
      );
    }
    return plans;
  }
}
