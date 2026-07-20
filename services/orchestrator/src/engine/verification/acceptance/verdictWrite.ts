/**
 * rv-10/rv-11 verdict write path: the pre-transaction validation and the client-level
 * assert-then-insert used by {@link PgAcceptanceRunStore.recordVerdict} and the atomic
 * {@link PgAcceptanceRunStore.recordAttemptedVerdict}. Kept separate so the store module stays
 * within the per-file line cap; the traceability assertion runs on EVERY verdict (no skip path).
 */

import type pg from "pg";
import { assertVerdictAssertionCoverage } from "../../contracts/runtimeVerificationInvariants.js";
import type { BehaviorVerdictOutcome, FlakeState } from "../../contracts/runtimeVerificationAdapters.js";
import { assertVerdictTraceable } from "./attemptLifecycle.js";
import type { RecordAcceptanceVerdictInput } from "./verdictStore.js";

type QueryClient = Pick<pg.PoolClient, "query">;

export const VERDICT_OUTCOMES = new Set<BehaviorVerdictOutcome>([
  "passed",
  "failed_product",
  "failed_verification_contract",
  "failed_visual",
  "inconclusive_infrastructure",
  "inconclusive_external",
  "cancelled_superseded",
]);
export const VERDICT_FLAKE_STATES = new Set<FlakeState>(["stable", "suspected", "confirmed", "quarantined_fragment"]);

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
    if (!VERDICT_OUTCOMES.has(attempt.outcome)) throw new TypeError(`unknown attempt outcome: ${attempt.outcome}`);
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

/** All pre-transaction verdict validation: coverage floor, enum domains, and count evidence. */
export function validateVerdictInput(input: RecordAcceptanceVerdictInput): void {
  // The app-layer twin of the 0079 DB CHECKs — a passed verdict without full,
  // non-zero coverage fails loud here, before it can reach the ledger.
  assertVerdictAssertionCoverage(input);
  if (!VERDICT_OUTCOMES.has(input.outcome)) throw new TypeError(`unknown behavior verdict outcome: ${input.outcome}`);
  if (!VERDICT_FLAKE_STATES.has(input.flakeState)) throw new TypeError(`unknown flake state: ${input.flakeState}`);
  assertVerdictCountEvidence(input);
}

/**
 * Assert MANDATORY verdict→attempt traceability, then write the verdict + its count evidence +
 * durable capture links — all on the caller's transaction client. Traceability runs on EVERY
 * verdict (there is no skip path), BEFORE any row is written, so a fabricated or partial lifecycle
 * rolls back with the transaction.
 */
export async function assertAndInsertVerdict(
  client: QueryClient,
  input: RecordAcceptanceVerdictInput,
  id: string,
): Promise<void> {
  await assertVerdictTraceable(client, {
    orgId: input.orgId,
    runId: input.runId,
    behaviorRevisionId: input.behaviorRevisionId,
    exampleHash: input.exampleHash,
    matrixHash: input.matrixHash,
    attemptCount: input.attemptCount,
    trace: input.attemptTrace,
  });
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
  // rv-9: durably link each content-addressed capture to this verdict. The FK to
  // verification_artifacts rejects any link whose artifact row is absent (no orphan
  // linkage); identical captures within a verdict collapse via the PK (idempotent).
  let evidenceOrdinal = 0;
  for (const link of input.evidenceLinks ?? []) {
    await client.query(
      `INSERT INTO behavior_verdict_evidence
         (org_id, verdict_id, ordinal, verification_artifact_id, cas_digest, media_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (org_id, verdict_id, verification_artifact_id) DO NOTHING`,
      [input.orgId, id, evidenceOrdinal, link.verificationArtifactId, link.casDigest, link.mediaType],
    );
    evidenceOrdinal += 1;
  }
}
