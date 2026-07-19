/**
 * rv-11 A1 acceptance: the FIRST concrete per-behavior verdict store. It persists
 * acceptance runs (behavior_verification_runs) and the immutable per-behavior
 * verdicts (behavior_verdicts) the 0079-hardened substrate guards. `recordVerdict`
 * calls {@link assertVerdictAssertionCoverage} BEFORE any write, so a `passed`
 * verdict with executed < required (or required < 1) fails loud in-process rather
 * than only being caught by the DB CHECK — a passed verdict is impossible unless
 * executed_assertion_count >= required_assertion_count >= 1.
 */

import { runWithOrgScope } from "@tanren/db";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Digest } from "../../contracts/cas.js";
import { assertVerdictAssertionCoverage } from "../../contracts/runtimeVerificationInvariants.js";
import type {
  BehaviorVerdictOutcome,
  FlakeState,
  VerificationRunPurpose,
} from "../../contracts/runtimeVerificationAdapters.js";

type QueryClient = Pick<pg.PoolClient, "query">;
type OrgScope = <T>(orgId: string, operation: (client: QueryClient) => Promise<T>) => Promise<T>;

export interface RecordAcceptanceRunInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly purpose: VerificationRunPurpose;
  readonly environmentId: string;
  readonly preparedHeadSha: string;
  readonly jjTreeId: string;
  readonly planSetHash: Digest;
  readonly runtimeBehaviorContextHash: Digest;
  readonly artifactDigest: Digest;
  readonly runId?: string;
  readonly specId?: string;
  readonly integrationNodeId?: string;
  readonly policy?: Readonly<Record<string, unknown>>;
}

export interface CompleteAcceptanceRunInput {
  readonly orgId: string;
  readonly runId: string;
  readonly status: "completed" | "failed" | "cancelled";
}

/** One required assertion and, where it ran, its actual pass/fail observation. */
export interface VerdictAssertionEvidence {
  readonly assertionId: string;
  readonly executed: boolean;
  readonly passed?: boolean;
}

/** One real execution attempt contributing to a verdict's retry tally. */
export interface VerdictAttemptEvidence {
  readonly attemptOrdinal: number;
  readonly outcome: BehaviorVerdictOutcome;
}

export interface RecordAcceptanceVerdictInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly behaviorRevisionId: string;
  readonly exampleHash: string;
  readonly matrixHash: string;
  readonly requiredAssertionCount: number;
  readonly executedAssertionCount: number;
  readonly outcome: BehaviorVerdictOutcome;
  readonly attemptCount: number;
  readonly flakeState: FlakeState;
  readonly gateEffect: "blocking" | "advisory";
  readonly artifactDigest: Digest;
  readonly runtimeBehaviorContextHash: Digest;
  readonly proofUnitDigest?: Digest;
  /** Complete per-required-assertion evidence; this, not a caller scalar, backs the counts. */
  readonly assertionEvidence: readonly VerdictAssertionEvidence[];
  /** Every actual execution attempt; this, not a caller scalar, backs attemptCount. */
  readonly attemptEvidence: readonly VerdictAttemptEvidence[];
}

export interface StoredAcceptanceVerdict {
  readonly verdictId: string;
  readonly behaviorRevisionId: string;
  readonly outcome: BehaviorVerdictOutcome;
  readonly requiredAssertionCount: number;
  readonly executedAssertionCount: number;
  readonly flakeState: FlakeState;
}

/** The rv-11 run/verdict persistence seam. Swappable for a conformance fake. */
export interface AcceptanceRunStore {
  recordRun(input: RecordAcceptanceRunInput): Promise<string>;
  completeRun(input: CompleteAcceptanceRunInput): Promise<void>;
  recordVerdict(input: RecordAcceptanceVerdictInput): Promise<string>;
  listVerdicts(input: { readonly orgId: string; readonly runId: string }): Promise<readonly StoredAcceptanceVerdict[]>;
}

const OUTCOMES = new Set<BehaviorVerdictOutcome>([
  "passed",
  "failed_product",
  "failed_verification_contract",
  "failed_visual",
  "inconclusive_infrastructure",
  "inconclusive_external",
  "cancelled_superseded",
]);
const FLAKE_STATES = new Set<FlakeState>(["stable", "suspected", "confirmed", "quarantined_fragment"]);

function assertVerdictCountEvidence(input: RecordAcceptanceVerdictInput): void {
  const assertionIds = new Set<string>();
  let executed = 0;
  for (const assertion of input.assertionEvidence) {
    if (assertion.assertionId.length === 0 || assertionIds.has(assertion.assertionId)) {
      throw new TypeError(
        `verdict assertion evidence has a missing or duplicate assertion id: ${assertion.assertionId}`,
      );
    }
    assertionIds.add(assertion.assertionId);
    if (assertion.executed) {
      if (typeof assertion.passed !== "boolean") {
        throw new TypeError(`executed assertion ${assertion.assertionId} has no pass/fail observation`);
      }
      executed += 1;
    } else if (assertion.passed !== undefined) {
      throw new TypeError(`unexecuted assertion ${assertion.assertionId} cannot have a pass/fail observation`);
    }
  }
  const ordinals = new Set<number>();
  for (const attempt of input.attemptEvidence) {
    if (
      !Number.isInteger(attempt.attemptOrdinal) ||
      attempt.attemptOrdinal < 1 ||
      ordinals.has(attempt.attemptOrdinal)
    ) {
      throw new TypeError(`verdict attempt evidence has an invalid or duplicate ordinal: ${attempt.attemptOrdinal}`);
    }
    if (!OUTCOMES.has(attempt.outcome)) throw new TypeError(`unknown attempt outcome: ${attempt.outcome}`);
    ordinals.add(attempt.attemptOrdinal);
  }
  if (
    input.requiredAssertionCount !== input.assertionEvidence.length ||
    input.executedAssertionCount !== executed ||
    input.attemptCount !== input.attemptEvidence.length
  ) {
    throw new TypeError(
      `verdict count evidence mismatch: stored required/executed/attempt=${input.requiredAssertionCount}/` +
        `${input.executedAssertionCount}/${input.attemptCount}, evidence=${input.assertionEvidence.length}/` +
        `${executed}/${input.attemptEvidence.length}`,
    );
  }
}

export interface PgAcceptanceRunStoreDependencies {
  /** Test seam; production always runs on runWithOrgScope over the control pool. */
  readonly withOrgScope?: OrgScope;
  readonly runId?: () => string;
  readonly verdictId?: () => string;
}

/** Postgres AcceptanceRunStore over the org-scoped, RLS-forced verdict substrate. */
export class PgAcceptanceRunStore implements AcceptanceRunStore {
  private readonly withOrgScope: OrgScope;
  private readonly newRunId: () => string;
  private readonly newVerdictId: () => string;

  public constructor(pool: pg.Pool, dependencies: PgAcceptanceRunStoreDependencies = {}) {
    this.withOrgScope = dependencies.withOrgScope ?? ((orgId, operation) => runWithOrgScope(pool, orgId, operation));
    this.newRunId = dependencies.runId ?? (() => `verification_run_${randomUUID()}`);
    this.newVerdictId = dependencies.verdictId ?? (() => `verdict_${randomUUID()}`);
  }

  public async recordRun(input: RecordAcceptanceRunInput): Promise<string> {
    const id = this.newRunId();
    return this.withOrgScope(input.orgId, async (client) => {
      await client.query(
        `INSERT INTO behavior_verification_runs
           (org_id, id, project_id, purpose, run_id, spec_id, integration_node_id,
            environment_id, prepared_head_sha, jj_tree_id, plan_set_hash,
            runtime_behavior_context_hash, artifact_digest, status, policy)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'running', $14::jsonb)`,
        [
          input.orgId,
          id,
          input.projectId,
          input.purpose,
          input.runId ?? null,
          input.specId ?? null,
          input.integrationNodeId ?? null,
          input.environmentId,
          input.preparedHeadSha,
          input.jjTreeId,
          input.planSetHash,
          input.runtimeBehaviorContextHash,
          input.artifactDigest,
          JSON.stringify(input.policy ?? {}),
        ],
      );
      return id;
    });
  }

  public async completeRun(input: CompleteAcceptanceRunInput): Promise<void> {
    await this.withOrgScope(input.orgId, (client) =>
      client.query(`UPDATE behavior_verification_runs SET status = $3 WHERE org_id = $1 AND id = $2`, [
        input.orgId,
        input.runId,
        input.status,
      ]),
    );
  }

  public async recordVerdict(input: RecordAcceptanceVerdictInput): Promise<string> {
    // The app-layer twin of the 0079 DB CHECKs — a passed verdict without full,
    // non-zero coverage fails loud here, before it can reach the ledger.
    assertVerdictAssertionCoverage(input);
    if (!OUTCOMES.has(input.outcome)) throw new TypeError(`unknown behavior verdict outcome: ${input.outcome}`);
    if (!FLAKE_STATES.has(input.flakeState)) throw new TypeError(`unknown flake state: ${input.flakeState}`);
    assertVerdictCountEvidence(input);
    const id = this.newVerdictId();
    return this.withOrgScope(input.orgId, async (client) => {
      await client.query(
        `INSERT INTO behavior_verdicts
           (org_id, id, project_id, run_id, behavior_revision_id, example_hash, matrix_hash,
            required_assertion_count, executed_assertion_count, outcome, attempt_count,
            flake_state, gate_effect, artifact_digest, proof_unit_digest, runtime_behavior_context_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          input.orgId,
          id,
          input.projectId,
          input.runId,
          input.behaviorRevisionId,
          input.exampleHash,
          input.matrixHash,
          input.requiredAssertionCount,
          input.executedAssertionCount,
          input.outcome,
          input.attemptCount,
          input.flakeState,
          input.gateEffect,
          input.artifactDigest,
          input.proofUnitDigest ?? null,
          input.runtimeBehaviorContextHash,
        ],
      );
      for (const attempt of input.attemptEvidence) {
        await client.query(
          `INSERT INTO behavior_verdict_attempts (org_id, verdict_id, attempt_ordinal, outcome)
           VALUES ($1, $2, $3, $4)`,
          [input.orgId, id, attempt.attemptOrdinal, attempt.outcome],
        );
      }
      for (const assertion of input.assertionEvidence) {
        await client.query(
          `INSERT INTO behavior_verdict_assertions (org_id, verdict_id, assertion_id, executed, passed)
           VALUES ($1, $2, $3, $4, $5)`,
          [input.orgId, id, assertion.assertionId, assertion.executed, assertion.passed ?? null],
        );
      }
      return id;
    });
  }

  public async listVerdicts(input: {
    readonly orgId: string;
    readonly runId: string;
  }): Promise<readonly StoredAcceptanceVerdict[]> {
    return this.withOrgScope(input.orgId, async (client) => {
      const result = await client.query<{
        id: string;
        behavior_revision_id: string;
        outcome: string;
        required_assertion_count: number;
        executed_assertion_count: number;
        attempt_count: number;
        evidence_required_assertion_count: number;
        evidence_executed_assertion_count: number;
        evidence_attempt_count: number;
        flake_state: string;
      }>(
        `SELECT v.id, v.behavior_revision_id, v.outcome, v.required_assertion_count, v.executed_assertion_count,
                v.attempt_count, v.flake_state,
                (SELECT COUNT(*)::int FROM behavior_verdict_assertions a
                  WHERE a.org_id = v.org_id AND a.verdict_id = v.id) AS evidence_required_assertion_count,
                (SELECT (COUNT(*) FILTER (WHERE a.executed))::int FROM behavior_verdict_assertions a
                  WHERE a.org_id = v.org_id AND a.verdict_id = v.id) AS evidence_executed_assertion_count,
                (SELECT COUNT(*)::int FROM behavior_verdict_attempts a
                  WHERE a.org_id = v.org_id AND a.verdict_id = v.id) AS evidence_attempt_count
           FROM behavior_verdicts v
          WHERE org_id = $1 AND run_id = $2
          ORDER BY v.created_at ASC, v.id ASC`,
        [input.orgId, input.runId],
      );
      return result.rows.map((row) => {
        if (!OUTCOMES.has(row.outcome as BehaviorVerdictOutcome)) {
          throw new TypeError(`stored verdict has an unknown outcome: ${row.outcome}`);
        }
        if (!FLAKE_STATES.has(row.flake_state as FlakeState)) {
          throw new TypeError(`stored verdict has an unknown flake state: ${row.flake_state}`);
        }
        if (
          row.required_assertion_count !== row.evidence_required_assertion_count ||
          row.executed_assertion_count !== row.evidence_executed_assertion_count ||
          row.attempt_count !== row.evidence_attempt_count
        ) {
          throw new Error(`stored verdict ${row.id} has unverifiable count evidence`);
        }
        return {
          verdictId: row.id,
          behaviorRevisionId: row.behavior_revision_id,
          outcome: row.outcome as BehaviorVerdictOutcome,
          requiredAssertionCount: row.required_assertion_count,
          executedAssertionCount: row.executed_assertion_count,
          flakeState: row.flake_state as FlakeState,
        };
      });
    });
  }
}
