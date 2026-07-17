// cspell:ignore vassert vartifact
import { runWithOrgScope } from "@tanren/db";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Digest } from "../contracts/cas.js";
import type { EventStore } from "../eventStore.js";
import { PgEventStore } from "../eventStore.js";
import type { RedactionClass } from "../contracts/runtimeVerificationPlan.js";
import type { SymptomAssertionOutcome } from "../contracts/symptomProbe.js";

interface RawVerificationArtifactRow {
  readonly org_id: string;
  readonly id: string;
  readonly project_id: string;
  readonly cas_digest: Digest;
  readonly proof_unit_digest: Digest | null;
  readonly kind: string;
  readonly media_type: string;
  readonly byte_size: number | string;
  readonly redaction_class: RedactionClass;
  readonly retention_class: string;
  readonly producing_attempt_id: string | null;
  readonly created_at: Date;
}

interface RawVerificationAssertionRow {
  readonly org_id: string;
  readonly id: string;
  readonly verification_run_id: string;
  readonly expected_hash: Digest;
  readonly observed_hash: Digest;
  readonly outcome: SymptomAssertionOutcome;
  readonly timing_ms: number;
  readonly sample_data: Record<string, unknown>;
  readonly created_at: Date;
}

export interface VerificationArtifactRow {
  readonly orgId: string;
  readonly id: string;
  readonly projectId: string;
  readonly casDigest: Digest;
  readonly proofUnitDigest: Digest | null;
  readonly kind: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly redactionClass: RedactionClass;
  readonly retentionClass: string;
  readonly producingAttemptId: string | null;
  readonly createdAt: Date;
}

export interface VerificationAssertionRow {
  readonly orgId: string;
  readonly id: string;
  readonly verificationRunId: string;
  readonly expectedHash: Digest;
  readonly observedHash: Digest;
  readonly outcome: SymptomAssertionOutcome;
  readonly timingMs: number;
  readonly sampleData: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface RecordVerificationArtifactInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly verificationRunId?: string;
  readonly casDigest: Digest;
  readonly kind: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly redactionClass: RedactionClass;
  readonly retentionClass?: string;
}

export interface RecordVerificationAssertionInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly issueLoopId: string;
  readonly verificationRunId: string;
  readonly expectedHash: Digest;
  readonly observedHash: Digest;
  readonly outcome: SymptomAssertionOutcome;
  readonly timingMs: number;
  readonly sampleData: Record<string, unknown>;
}

const ARTIFACT_COLUMNS = `org_id, id, project_id, cas_digest, proof_unit_digest, kind,
  media_type, byte_size, redaction_class, retention_class, producing_attempt_id, created_at`;
const ASSERTION_COLUMNS = `org_id, id, verification_run_id, expected_hash, observed_hash,
  outcome, timing_ms, sample_data, created_at`;

function mapArtifact(row: RawVerificationArtifactRow): VerificationArtifactRow {
  return {
    orgId: row.org_id,
    id: row.id,
    projectId: row.project_id,
    casDigest: row.cas_digest,
    proofUnitDigest: row.proof_unit_digest,
    kind: row.kind,
    mediaType: row.media_type,
    byteSize: Number(row.byte_size),
    redactionClass: row.redaction_class,
    retentionClass: row.retention_class,
    producingAttemptId: row.producing_attempt_id,
    createdAt: row.created_at,
  };
}

function mapAssertion(row: RawVerificationAssertionRow): VerificationAssertionRow {
  return {
    orgId: row.org_id,
    id: row.id,
    verificationRunId: row.verification_run_id,
    expectedHash: row.expected_hash,
    observedHash: row.observed_hash,
    outcome: row.outcome,
    timingMs: row.timing_ms,
    sampleData: row.sample_data,
    createdAt: row.created_at,
  };
}

/** Org-scoped links into the shared RV evidence substrate and assertion ledger. */
export class SymptomEvidenceStore {
  private readonly eventStore: EventStore;

  public constructor(
    private readonly pool: pg.Pool,
    eventStore?: EventStore,
  ) {
    this.eventStore = eventStore ?? new PgEventStore(pool);
  }

  public async recordArtifact(input: RecordVerificationArtifactInput): Promise<VerificationArtifactRow> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      await this.assertProject(client, input.orgId, input.projectId);
      if (input.verificationRunId !== undefined) {
        await this.assertRunProject(client, input.orgId, input.projectId, input.verificationRunId);
      }
      const result = await client.query<RawVerificationArtifactRow>(
        `INSERT INTO verification_artifacts
           (org_id, id, project_id, cas_digest, proof_unit_digest, kind, media_type,
            byte_size, redaction_class, retention_class, producing_attempt_id)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, NULL)
         RETURNING ${ARTIFACT_COLUMNS}`,
        [
          input.orgId,
          `vartifact_${randomUUID()}`,
          input.projectId,
          input.casDigest,
          input.kind,
          input.mediaType,
          input.byteSize,
          input.redactionClass,
          input.retentionClass ?? "standard",
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("verification artifact insert returned no row");
      return mapArtifact(row);
    });
  }

  public async recordAssertion(input: RecordVerificationAssertionInput): Promise<VerificationAssertionRow> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      await this.assertRunProject(client, input.orgId, input.projectId, input.verificationRunId);
      const id = `vassert_${randomUUID()}`;
      const result = await client.query<RawVerificationAssertionRow>(
        `INSERT INTO verification_assertions
           (org_id, id, verification_run_id, expected_hash, observed_hash, outcome, timing_ms, sample_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         RETURNING ${ASSERTION_COLUMNS}`,
        [
          input.orgId,
          id,
          input.verificationRunId,
          input.expectedHash,
          input.observedHash,
          input.outcome,
          input.timingMs,
          JSON.stringify(input.sampleData),
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("verification assertion insert returned no row");
      const assertion = mapAssertion(row);
      await this.eventStore.append({
        orgId: input.orgId,
        projectId: input.projectId,
        eventType: "symptom.assertion.recorded",
        payload: {
          projectId: input.projectId,
          issueLoopId: input.issueLoopId,
          verificationRunId: input.verificationRunId,
          assertionId: assertion.id,
          expectedHash: assertion.expectedHash,
          observedHash: assertion.observedHash,
          outcome: assertion.outcome,
          timingMs: assertion.timingMs,
        },
      });
      return assertion;
    });
  }

  public async listArtifacts(orgId: string, projectId: string): Promise<VerificationArtifactRow[]> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<RawVerificationArtifactRow>(
        `SELECT ${ARTIFACT_COLUMNS}
           FROM verification_artifacts
          WHERE org_id = $1 AND project_id = $2
          ORDER BY created_at, id`,
        [orgId, projectId],
      );
      return result.rows.map(mapArtifact);
    });
  }

  public async listAssertions(orgId: string, verificationRunId: string): Promise<VerificationAssertionRow[]> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<RawVerificationAssertionRow>(
        `SELECT ${ASSERTION_COLUMNS}
           FROM verification_assertions
          WHERE org_id = $1 AND verification_run_id = $2
          ORDER BY created_at, id`,
        [orgId, verificationRunId],
      );
      return result.rows.map(mapAssertion);
    });
  }

  private async assertProject(client: pg.PoolClient, orgId: string, projectId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM projects WHERE org_id = $1 AND project_id = $2", [
      orgId,
      projectId,
    ]);
    if (result.rowCount !== 1) throw new Error(`project ${projectId} does not belong to org ${orgId}`);
  }

  private async assertRunProject(
    client: pg.PoolClient,
    orgId: string,
    projectId: string,
    verificationRunId: string,
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1
         FROM behavior_verification_runs
        WHERE org_id = $1 AND id = $2 AND project_id = $3`,
      [orgId, verificationRunId, projectId],
    );
    if (result.rowCount !== 1) throw new Error(`verification run ${verificationRunId} is not in org/project scope`);
  }
}
