// rv-17 — append-only persistence + read side for behavior flake quarantine governance
// (`behavior_flake_quarantines`, migration 0085).
//   • recordTransition: INSERT a sealed quarantine/release governance transition (who/why/when +
//     the conflicting-verdict evidence). A `quarantine` is asserted JUSTIFIED (classification must
//     be `flaky`) in-process BEFORE the write — the same invariant the 0085 shape CHECK enforces.
//   • readActiveQuarantinedBehaviors / isQuarantined: a behavior's CURRENT state is its LATEST
//     transition (created_at, id); it is quarantined iff that transition is `quarantine`.
//   • classifyBehaviorFlake: runs the rv-17 classifier off the RECORDED verdicts for a behavior +
//     artifact + verification PURPOSE — the classification is computed from real attempts, never
//     guessed. Keying by (behavior, artifact, purpose) is what separates a FLAKE (same code, same
//     purpose, conflicting outcomes — non-determinism) from an rv-16 REGRESSION (a cross-purpose
//     deterioration, e.g. pre_merge `passed` → post_merge `failed`, which is NOT a flake and must
//     never auto-quarantine). Only conflicts WITHIN one artifact+purpose count.
// Every query is org-scoped (RLS confines it to the caller's org; a cross-org read sees ZERO rows).

import { runWithOrgScope } from "@tanren/db";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { BehaviorVerdictOutcome } from "../contracts/runtimeVerificationAdapters.js";
import {
  assertQuarantineJustified,
  quarantineGateEffect,
  type BehaviorQuarantineReader,
  type QuarantineTransitionRecord,
} from "../verification/acceptance/behaviorQuarantineGovernance.js";
import {
  classifyFlake,
  type FlakeClassificationResult,
  type VerdictObservation,
} from "../verification/acceptance/flakeClassification.js";
import type { FlakeClassificationScope } from "../verification/acceptance/flakeQuarantineActuator.js";

type QueryClient = Pick<pg.PoolClient, "query">;
type OrgScope = <T>(orgId: string, operation: (client: QueryClient) => Promise<T>) => Promise<T>;

const OUTCOMES = new Set<BehaviorVerdictOutcome>([
  "passed",
  "failed_product",
  "failed_verification_contract",
  "failed_visual",
  "inconclusive_infrastructure",
  "inconclusive_external",
  "cancelled_superseded",
]);

// Decode a stored outcome through a Set guard (never `as Enum`): an unknown value fails loud
// rather than silently classifying a garbage row.
function decodeOutcome(value: unknown): BehaviorVerdictOutcome {
  if (typeof value === "string" && OUTCOMES.has(value as BehaviorVerdictOutcome)) {
    return value as BehaviorVerdictOutcome;
  }
  throw new TypeError(`behavior_verdicts row has an unknown outcome: ${String(value)}`);
}

export interface PgBehaviorQuarantineStoreDeps {
  /** Test seam; production always runs on `runWithOrgScope` over the control pool. */
  readonly withOrgScope?: OrgScope;
  readonly quarantineId?: () => string;
}

/** Append-only quarantine ledger + the read seam the LIVE rv-16 bisection (and the ready-but-not-yet-wired gate resolver) consult. */
export class PgBehaviorQuarantineStore implements BehaviorQuarantineReader {
  private readonly withOrgScope: OrgScope;
  private readonly newId: () => string;

  public constructor(pool: pg.Pool, deps: PgBehaviorQuarantineStoreDeps = {}) {
    this.withOrgScope = deps.withOrgScope ?? ((orgId, operation) => runWithOrgScope(pool, orgId, operation));
    this.newId = deps.quarantineId ?? (() => `behavior_quarantine_${randomUUID()}`);
  }

  /** Record a sealed quarantine/release transition. A `quarantine` must be justified by a flaky classification. */
  public async recordTransition(record: QuarantineTransitionRecord): Promise<string> {
    if (record.transition === "quarantine") assertQuarantineJustified(record.classification);
    const id = this.newId();
    const gateEffect = quarantineGateEffect(record.transition);
    await this.withOrgScope(record.orgId, (client) =>
      client.query(
        `INSERT INTO behavior_flake_quarantines
           (org_id, project_id, id, behavior_revision_id, transition, gate_effect, classification,
            reason, actor, evidence, context_hash, epoch)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
        [
          record.orgId,
          record.projectId,
          id,
          record.behaviorRevisionId,
          record.transition,
          gateEffect,
          record.classification,
          record.reason,
          record.actor,
          JSON.stringify(record.evidence),
          record.contextHash,
          record.epoch,
        ],
      ),
    );
    return id;
  }

  /**
   * mq-7 — the ACTIVE quarantine for one behavior (its LATEST transition), returning the epoch
   * (artifact_digest) it was proven in, or `undefined` when the behavior is not currently
   * quarantined (no rows, or the latest transition is a `release`). The epoch is what the
   * epoch re-evaluation compares against the newly-observed generation.
   */
  public async readActiveQuarantine(
    scope: { readonly orgId: string; readonly projectId: string },
    behaviorRevisionId: string,
  ): Promise<{ readonly epoch: string } | undefined> {
    return this.withOrgScope(scope.orgId, async (client) => {
      const result = await client.query<{ transition: string; epoch: string }>(
        `SELECT transition, epoch
           FROM behavior_flake_quarantines
          WHERE org_id = $1 AND project_id = $2 AND behavior_revision_id = $3
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [scope.orgId, scope.projectId, behaviorRevisionId],
      );
      const latest = result.rows[0];
      return latest !== undefined && latest.transition === "quarantine" ? { epoch: latest.epoch } : undefined;
    });
  }

  /**
   * mq-7 DURABLE ANTI-MASKING — whether ONE behavior is currently quarantined IN THE GIVEN EPOCH:
   * its LATEST transition is a `quarantine` AND that quarantine was proven in `epoch` (the
   * artifact_digest currently being observed). A quarantine masks a behavior's observations ONLY
   * within its OWN epoch; a quarantine proven in an OLDER generation (epoch ≠ the observed one)
   * returns FALSE here. This is what makes the anti-masking guarantee DURABLE at the CONSUMPTION
   * site: a new-generation regression is never suppressed by a stale quarantine, regardless of
   * whether the actuator managed to write a `release` row for the new epoch.
   */
  public async isQuarantinedInEpoch(
    scope: { readonly orgId: string; readonly projectId: string },
    behaviorRevisionId: string,
    epoch: string,
  ): Promise<boolean> {
    return this.withOrgScope(scope.orgId, async (client) => {
      const result = await client.query<{ transition: string; epoch: string }>(
        `SELECT transition, epoch
           FROM behavior_flake_quarantines
          WHERE org_id = $1 AND project_id = $2 AND behavior_revision_id = $3
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [scope.orgId, scope.projectId, behaviorRevisionId],
      );
      const latest = result.rows[0];
      return latest?.transition === "quarantine" && latest.epoch === epoch;
    });
  }

  /**
   * mq-7 DURABLE ANTI-MASKING (gate seam) — the behaviors whose LATEST transition is a `quarantine`
   * proven IN the given epoch. A stale quarantine from an older generation is EXCLUDED, so a gate
   * that consults this set never suppresses a new-generation failure behind an old-epoch quarantine.
   */
  public async readActiveQuarantinedBehaviorsInEpoch(
    scope: { readonly orgId: string; readonly projectId: string },
    epoch: string,
  ): Promise<ReadonlySet<string>> {
    return this.withOrgScope(scope.orgId, async (client) => {
      const result = await client.query<{ behavior_revision_id: string }>(
        `SELECT behavior_revision_id
           FROM (
             SELECT DISTINCT ON (behavior_revision_id) behavior_revision_id, transition, epoch
               FROM behavior_flake_quarantines
              WHERE org_id = $1 AND project_id = $2
              ORDER BY behavior_revision_id, created_at DESC, id DESC
           ) latest
          WHERE transition = 'quarantine' AND epoch = $3`,
        [scope.orgId, scope.projectId, epoch],
      );
      return new Set(result.rows.map((row) => row.behavior_revision_id));
    });
  }

  public async readActiveQuarantinedBehaviors(scope: {
    readonly orgId: string;
    readonly projectId: string;
  }): Promise<ReadonlySet<string>> {
    return this.withOrgScope(scope.orgId, async (client) => {
      const result = await client.query<{ behavior_revision_id: string }>(
        `SELECT behavior_revision_id
           FROM (
             SELECT DISTINCT ON (behavior_revision_id) behavior_revision_id, transition
               FROM behavior_flake_quarantines
              WHERE org_id = $1 AND project_id = $2
              ORDER BY behavior_revision_id, created_at DESC, id DESC
           ) latest
          WHERE transition = 'quarantine'`,
        [scope.orgId, scope.projectId],
      );
      return new Set(result.rows.map((row) => row.behavior_revision_id));
    });
  }

  public async isQuarantined(
    scope: { readonly orgId: string; readonly projectId: string },
    behaviorRevisionId: string,
  ): Promise<boolean> {
    return this.withOrgScope(scope.orgId, async (client) => {
      const result = await client.query<{ transition: string }>(
        `SELECT transition
           FROM behavior_flake_quarantines
          WHERE org_id = $1 AND project_id = $2 AND behavior_revision_id = $3
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [scope.orgId, scope.projectId, behaviorRevisionId],
      );
      return result.rows[0]?.transition === "quarantine";
    });
  }

  /**
   * Classify a behavior's flake state from its RECORDED verdicts for one artifact + verification
   * PURPOSE — the classification is a function of the real attempts, computed the same way whether
   * it feeds a quarantine decision or a surfaced signal. Scoping to a single purpose is what keeps
   * an rv-16 cross-purpose REGRESSION (pre_merge passed → post_merge failed) from being misread as
   * a flake.
   */
  public async classifyBehaviorFlake(scope: FlakeClassificationScope): Promise<FlakeClassificationResult> {
    const observations = await this.readVerdictObservations(scope);
    return classifyFlake(observations);
  }

  private async readVerdictObservations(scope: FlakeClassificationScope): Promise<readonly VerdictObservation[]> {
    return this.withOrgScope(scope.orgId, async (client) => {
      // purpose lives on behavior_verification_runs, so the flake window JOINs the run and pins a
      // single purpose: only conflicts WITHIN one artifact + purpose are non-determinism.
      const result = await client.query<{ id: string; outcome: unknown }>(
        `SELECT v.id, v.outcome
           FROM behavior_verdicts v
           JOIN behavior_verification_runs r ON r.org_id = v.org_id AND r.id = v.run_id
          WHERE v.org_id = $1 AND v.project_id = $2 AND v.behavior_revision_id = $3
            AND v.artifact_digest = $4 AND r.purpose = $5
          ORDER BY v.created_at ASC, v.id ASC`,
        [scope.orgId, scope.projectId, scope.behaviorRevisionId, scope.artifactDigest, scope.purpose],
      );
      return result.rows.map((row) => ({ verdictId: row.id, outcome: decodeOutcome(row.outcome) }));
    });
  }
}
