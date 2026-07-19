// rv-16b — persistence + candidate-window reader for the behavior-aware regression bisector.
//   • PgRegressionBisectionStore: append-only INSERT of the sealed bisection result (culprit +
//     probe trail, or inconclusive + reason) into `behavior_regression_bisections` (0083),
//     idempotent on the triggering verdict (ON CONFLICT DO NOTHING).
//   • PgCandidateChainReader: builds the ordered candidate window by walking the
//     `release_instances.previous_release_instance_id` supersession chain back from the failing
//     release, anchored at the most recent prior release whose behavior re-proved `passed`
//     (a real post_merge_production verdict). That anchor + the releases after it are what the
//     bisector re-proves over.

import { runWithOrgScope } from "@tanren/db";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { ReleaseInstancesStore } from "./releaseInstances.js";
import type { ReleaseInstanceRecord } from "../contracts/deployAdapter.js";
import type {
  BisectionResult,
  CandidateChain,
  CandidateChainReader,
  CandidateRelease,
  RegressionBisectionStore,
  RegressionBisectionTrigger,
} from "../verification/postMergeReproof/regressionBisection.js";

type QueryClient = Pick<pg.PoolClient, "query">;
type OrgScope = <T>(orgId: string, operation: (client: QueryClient) => Promise<T>) => Promise<T>;

function toCandidate(release: ReleaseInstanceRecord): CandidateRelease {
  return {
    releaseInstanceId: release.releaseInstanceId,
    integrationNodeId: release.integrationNodeId,
    artifactDigest: release.artifactDigest,
    sourceRef: release.sourceRef,
    url: release.url,
  };
}

export interface PgRegressionBisectionStoreDeps {
  /** Test seam; production always runs on `runWithOrgScope` over the control pool. */
  readonly withOrgScope?: OrgScope;
  readonly bisectionId?: () => string;
}

/** Append-only store for the sealed regression-bisection result + probe trail (0083). */
export class PgRegressionBisectionStore implements RegressionBisectionStore {
  private readonly withOrgScope: OrgScope;
  private readonly newId: () => string;

  public constructor(pool: pg.Pool, deps: PgRegressionBisectionStoreDeps = {}) {
    this.withOrgScope = deps.withOrgScope ?? ((orgId, operation) => runWithOrgScope(pool, orgId, operation));
    this.newId = deps.bisectionId ?? (() => `regression_bisection_${randomUUID()}`);
  }

  public async record(result: BisectionResult): Promise<void> {
    const probeTrail = result.probes.map((probe) => ({
      releaseInstanceId: probe.releaseInstanceId,
      integrationNodeId: probe.integrationNodeId,
      artifactDigest: probe.artifactDigest,
      role: probe.role,
      outcome: probe.outcome,
      classification: probe.classification,
      reachable: probe.reachable,
    }));
    await this.withOrgScope(result.trigger.orgId, (client) =>
      client.query(
        `INSERT INTO behavior_regression_bisections
           (org_id, project_id, id, behavior_revision_id, failing_release_instance_id, failing_verdict_id,
            baseline_release_instance_id, artifact_digest, integration_node_id, status,
            culprit_release_instance_id, culprit_integration_node_id, inconclusive_reason,
            candidate_count, probe_count, probe_trail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
         ON CONFLICT (org_id, failing_verdict_id) DO NOTHING`,
        [
          result.trigger.orgId,
          result.trigger.projectId,
          this.newId(),
          result.trigger.behaviorRevisionId,
          result.trigger.failingReleaseInstanceId,
          result.trigger.failingVerdictId,
          result.baselineReleaseInstanceId ?? null,
          // probes[0] is always the tip = the FAILING release, so these describe it faithfully.
          // The fallback only applies to the degenerate empty-window case (failing release gone).
          result.probes[0]?.artifactDigest ?? ZERO_DIGEST,
          result.probes[0]?.integrationNodeId ?? "unknown",
          result.status,
          result.culprit?.releaseInstanceId ?? null,
          result.culprit?.integrationNodeId ?? null,
          result.inconclusiveReason ?? null,
          result.candidateCount,
          result.probes.length,
          JSON.stringify(probeTrail),
        ],
      ),
    );
  }
}

// Schema-valid placeholder digest for the degenerate empty-window case (the failing release
// vanished so no probe ran): the honest inconclusive record still persists rather than
// violating the digest CHECK.
const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;

export interface PgCandidateChainReaderDeps {
  readonly withOrgScope?: OrgScope;
}

/** Reads the ordered candidate window by walking the release supersession chain + verdict history. */
export class PgCandidateChainReader implements CandidateChainReader {
  private readonly withOrgScope: OrgScope;

  public constructor(pool: pg.Pool, deps: PgCandidateChainReaderDeps = {}) {
    this.withOrgScope = deps.withOrgScope ?? ((orgId, operation) => runWithOrgScope(pool, orgId, operation));
  }

  public async read(trigger: RegressionBisectionTrigger): Promise<CandidateChain> {
    return this.withOrgScope(trigger.orgId, async (client) => {
      const failing = await ReleaseInstancesStore.getById(client, trigger.orgId, trigger.failingReleaseInstanceId);
      if (failing === undefined) return { candidates: [], baseline: undefined };

      // Walk the supersession chain from the failing release back through each release it
      // superseded, prepending so the result is oldest→newest (the failing release LAST).
      // Bounded by the finite set of releases (a visited guard rejects any cycle).
      const chainOldestFirst: ReleaseInstanceRecord[] = [failing];
      const visited = new Set<string>([failing.releaseInstanceId]);
      let cursor: string | null = failing.previousReleaseInstanceId;
      while (cursor !== null && !visited.has(cursor)) {
        visited.add(cursor);
        const prior = await ReleaseInstancesStore.getById(client, trigger.orgId, cursor);
        if (prior === undefined) break;
        chainOldestFirst.unshift(prior);
        cursor = prior.previousReleaseInstanceId;
      }

      // The baseline anchor is the most recent PRIOR release (excluding the failing release)
      // whose behavior re-proved `passed` in a real post_merge_production verdict.
      let baselineIndex = -1;
      let baselineRelease: ReleaseInstanceRecord | undefined;
      for (let i = chainOldestFirst.length - 2; i >= 0; i -= 1) {
        const release = chainOldestFirst[i]!;
        if (await this.behaviorPassedAt(client, trigger, release)) {
          baselineIndex = i;
          baselineRelease = release;
          break;
        }
      }

      if (baselineRelease === undefined) {
        return { candidates: chainOldestFirst.map((release) => toCandidate(release)), baseline: undefined };
      }
      return {
        candidates: chainOldestFirst.slice(baselineIndex + 1).map((release) => toCandidate(release)),
        baseline: toCandidate(baselineRelease),
      };
    });
  }

  private async behaviorPassedAt(
    client: QueryClient,
    trigger: RegressionBisectionTrigger,
    release: ReleaseInstanceRecord,
  ): Promise<boolean> {
    const result = await client.query<{ passed: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM behavior_verdicts v
           JOIN behavior_verification_runs r ON r.org_id = v.org_id AND r.id = v.run_id
          WHERE v.org_id = $1 AND v.behavior_revision_id = $2 AND v.outcome = 'passed'
            AND r.purpose = 'post_merge_production'
            AND r.integration_node_id = $3 AND r.artifact_digest = $4
            AND v.required_assertion_count = (
              SELECT COUNT(*)::int FROM behavior_verdict_assertions a
               WHERE a.org_id = v.org_id AND a.verdict_id = v.id
            )
            AND v.executed_assertion_count = (
              SELECT (COUNT(*) FILTER (WHERE a.executed))::int FROM behavior_verdict_assertions a
               WHERE a.org_id = v.org_id AND a.verdict_id = v.id
            )
            AND v.attempt_count = (
              SELECT COUNT(*)::int FROM behavior_verdict_attempts a
               WHERE a.org_id = v.org_id AND a.verdict_id = v.id
            )
       ) AS passed`,
      [trigger.orgId, trigger.behaviorRevisionId, release.integrationNodeId, release.artifactDigest],
    );
    return result.rows[0]?.passed ?? false;
  }
}
