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
import { parseDigest } from "../../contracts/cas.js";
import type { VerificationArtifactId } from "../../contracts/runtimeVerificationPlan.js";
import type {
  BehaviorVerdictOutcome,
  FlakeState,
  VerificationRunPurpose,
} from "../../contracts/runtimeVerificationAdapters.js";
import {
  backfillProducingAttempt,
  ensureVerificationPlanRow,
  recordAttemptRow,
  type EnsureVerificationPlanInput,
  type RecordAttemptInput,
  type VerdictAttemptTrace,
} from "./attemptLifecycle.js";
import {
  assertAndInsertVerdict,
  validateVerdictInput,
  VERDICT_FLAKE_STATES,
  VERDICT_OUTCOMES,
} from "./verdictWrite.js";

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

/**
 * rv-9: a DURABLE link from a verdict to a content-addressed capture artifact. Persisting
 * this onto the ledger (behavior_verdict_evidence) is what lets a later proof resolve the
 * capture's address from the verdict alone — the address no longer lives only on the
 * ephemeral run result. The FK to `verification_artifacts` guarantees no orphan link.
 */
export interface VerdictEvidenceLink {
  readonly verificationArtifactId: VerificationArtifactId;
  readonly casDigest: Digest;
  readonly mediaType: string;
}

/** A verdict evidence link read back from the durable ledger. */
export interface StoredVerdictEvidenceLink {
  readonly ordinal: number;
  readonly verificationArtifactId: VerificationArtifactId;
  readonly casDigest: Digest;
  readonly mediaType: string;
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
  /**
   * rv-9: content-addressed capture artifacts to DURABLY link to this verdict. Persisted in
   * the same org-scoped transaction as the verdict, so the capture's address is resolvable
   * from the ledger — not just the ephemeral run result. Absent/empty ⇒ no links written.
   */
  readonly evidenceLinks?: readonly VerdictEvidenceLink[];
  /**
   * rv-10: MANDATORY traceability trace — no silent skip path. {@link assertVerdictTraceable} runs
   * on EVERY verdict, BEFORE any row is written: `attempted` fails closed on an orphan / borrowed /
   * count-mismatch attempt; `attemptless` fails closed if the run DID attempt the behavior. The
   * live orchestrator always uses `attempted` via {@link AcceptanceRunStore.recordAttemptedVerdict}.
   */
  readonly attemptTrace: VerdictAttemptTrace;
}

/** The atomic {plan + attempt + verdict} recording unit (records all three in ONE transaction). */
export interface RecordAttemptedVerdictInput {
  /** The attempt's plan referent (idempotently materialized in the same transaction). */
  readonly plan: EnsureVerificationPlanInput;
  /** The real attempt to record (its id is generated and bound to the verdict's trace). */
  readonly attempt: RecordAttemptInput;
  /** The verdict fields; the `attempted` trace is bound internally to the recorded attempt id. */
  readonly verdict: Omit<RecordAcceptanceVerdictInput, "attemptTrace">;
}

export interface RecordAttemptedVerdictResult {
  readonly attemptId: string;
  readonly verdictId: string;
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
  /**
   * rv-10: materialize the attempt's plan referent (behavior_verification_plans),
   * the attempt.plan_id FK target the acceptance path never persisted. Idempotent.
   */
  ensureVerificationPlan(input: EnsureVerificationPlanInput): Promise<string>;
  /** rv-10: record a real attempt row a verdict + captured artifacts can trace to. */
  recordAttempt(input: RecordAttemptInput): Promise<string>;
  recordVerdict(input: RecordAcceptanceVerdictInput): Promise<string>;
  /**
   * rv-10 FINDING 2: record the real attempt AND the verdict it produced in ONE transaction. A
   * failed traceability assertion rolls the attempt back with the verdict, so no orphan attempt
   * survives. Also backfills each linked capture's `producing_attempt_id` to the recorded attempt
   * (guaranteeing a production capture ends non-NULL), atomically.
   */
  recordAttemptedVerdict(input: RecordAttemptedVerdictInput): Promise<RecordAttemptedVerdictResult>;
  listVerdicts(input: { readonly orgId: string; readonly runId: string }): Promise<readonly StoredAcceptanceVerdict[]>;
}

/**
 * Sequential {plan → attempt → verdict} composition for NON-transactional (in-memory / fake)
 * stores: it reuses the store's own `ensureVerificationPlan` / `recordAttempt` / `recordVerdict`
 * so their fail-closed mirrors still run. The Postgres store overrides this with a truly ATOMIC
 * single-transaction implementation (see {@link PgAcceptanceRunStore.recordAttemptedVerdict}).
 */
export async function recordAttemptedVerdictSequential(
  store: Pick<AcceptanceRunStore, "ensureVerificationPlan" | "recordAttempt" | "recordVerdict">,
  input: RecordAttemptedVerdictInput,
): Promise<RecordAttemptedVerdictResult> {
  await store.ensureVerificationPlan(input.plan);
  const attemptId = await store.recordAttempt(input.attempt);
  const verdictId = await store.recordVerdict({
    ...input.verdict,
    attemptTrace: { kind: "attempted", producingAttemptId: attemptId },
  });
  return { attemptId, verdictId };
}

export interface PgAcceptanceRunStoreDependencies {
  /** Test seam; production always runs on runWithOrgScope over the control pool. */
  readonly withOrgScope?: OrgScope;
  readonly runId?: () => string;
  readonly verdictId?: () => string;
  readonly attemptId?: () => string;
}

/** Postgres AcceptanceRunStore over the org-scoped, RLS-forced verdict substrate. */
export class PgAcceptanceRunStore implements AcceptanceRunStore {
  private readonly withOrgScope: OrgScope;
  private readonly newRunId: () => string;
  private readonly newVerdictId: () => string;
  private readonly newAttemptId: () => string;

  public constructor(pool: pg.Pool, dependencies: PgAcceptanceRunStoreDependencies = {}) {
    this.withOrgScope = dependencies.withOrgScope ?? ((orgId, operation) => runWithOrgScope(pool, orgId, operation));
    this.newRunId = dependencies.runId ?? (() => `verification_run_${randomUUID()}`);
    this.newVerdictId = dependencies.verdictId ?? (() => `verdict_${randomUUID()}`);
    this.newAttemptId = dependencies.attemptId ?? (() => `verification_attempt_${randomUUID()}`);
  }

  public async ensureVerificationPlan(input: EnsureVerificationPlanInput): Promise<string> {
    return this.withOrgScope(input.orgId, (client) => ensureVerificationPlanRow(client, input));
  }

  public async recordAttempt(input: RecordAttemptInput): Promise<string> {
    const id = this.newAttemptId();
    return this.withOrgScope(input.orgId, (client) => recordAttemptRow(client, id, input));
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
    validateVerdictInput(input);
    const id = this.newVerdictId();
    await this.withOrgScope(input.orgId, (client) => assertAndInsertVerdict(client, input, id));
    return id;
  }

  /**
   * rv-10 FINDING 2: record the real attempt AND the verdict it produced in ONE org-scoped
   * transaction. If {@link assertVerdictTraceable} throws (borrowed / count-mismatch / orphan), the
   * whole transaction rolls back — the attempt row never survives as an orphan. Any linked capture's
   * `producing_attempt_id` is backfilled to the recorded attempt in the SAME transaction, so a
   * production capture ends non-NULL atomically with the verdict.
   */
  public async recordAttemptedVerdict(input: RecordAttemptedVerdictInput): Promise<RecordAttemptedVerdictResult> {
    const attemptId = this.newAttemptId();
    const verdict: RecordAcceptanceVerdictInput = {
      ...input.verdict,
      attemptTrace: { kind: "attempted", producingAttemptId: attemptId },
    };
    // Pre-transaction validation fails loud before we open a transaction / write a row.
    validateVerdictInput(verdict);
    const verdictId = this.newVerdictId();
    await this.withOrgScope(verdict.orgId, async (client) => {
      await ensureVerificationPlanRow(client, input.plan);
      await recordAttemptRow(client, attemptId, input.attempt);
      await assertAndInsertVerdict(client, verdict, verdictId);
      await backfillProducingAttempt(
        client,
        verdict.orgId,
        attemptId,
        (verdict.evidenceLinks ?? []).map((link) => link.verificationArtifactId),
      );
    });
    return { attemptId, verdictId };
  }

  /**
   * rv-9: read a verdict's DURABLE capture-evidence links straight from the ledger. This is
   * the discovery path a later proof uses: given only the verdict id, it resolves each
   * content-addressed capture's artifact id + CAS address without the ephemeral run result.
   */
  public async listVerdictEvidence(input: {
    readonly orgId: string;
    readonly verdictId: string;
  }): Promise<readonly StoredVerdictEvidenceLink[]> {
    return this.withOrgScope(input.orgId, async (client) => {
      const result = await client.query<{
        ordinal: number;
        verification_artifact_id: string;
        cas_digest: string;
        media_type: string;
      }>(
        `SELECT ordinal, verification_artifact_id, cas_digest, media_type
           FROM behavior_verdict_evidence
          WHERE org_id = $1 AND verdict_id = $2
          ORDER BY ordinal ASC`,
        [input.orgId, input.verdictId],
      );
      return result.rows.map((row) => ({
        ordinal: row.ordinal,
        verificationArtifactId: row.verification_artifact_id as VerificationArtifactId,
        casDigest: parseDigest(row.cas_digest),
        mediaType: row.media_type,
      }));
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
        if (!VERDICT_OUTCOMES.has(row.outcome as BehaviorVerdictOutcome)) {
          throw new TypeError(`stored verdict has an unknown outcome: ${row.outcome}`);
        }
        if (!VERDICT_FLAKE_STATES.has(row.flake_state as FlakeState)) {
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
