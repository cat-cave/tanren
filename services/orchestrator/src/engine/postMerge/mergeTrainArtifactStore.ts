// mq-15 durable store for the merge-train artifact projection. The write path is a
// single org-scoped transaction: INSERT ... ON CONFLICT (org_id, land_group_id) DO
// NOTHING (append-only idempotency — a duplicate watcher delivery is a clean no-op),
// and the frozen `merge.train.artifact.sealed` event is appended on the SAME client
// only when a fresh row was inserted. Reads take an already-scoped client so a route
// composes them inside its own `runWithOrgScope` + `assertProjectAccess` transaction.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { PgEventStore } from "../eventStore.js";
import { type MergeTrainArtifactV1, validateMergeTrainArtifact } from "../contracts/mergeTrainArtifact.js";
import type { MergeTrainPersistInput, MergeTrainSealSink } from "./mergeTrainArtifactGates.js";

/** One member's projected summary for the train list panel. */
export interface MergeTrainArtifactSummary {
  readonly id: string;
  readonly landGroupId: string;
  readonly authorityDecisionId: string;
  readonly integrationNodeId: string;
  readonly proofRoot: string;
  readonly receiptMainSha: string;
  readonly deployDeploymentId: string;
  readonly demoSurfaceKind: string;
  readonly demoBehaviorCount: number;
  readonly demoPassed: number;
  readonly bundleDigest: string;
  readonly contentHash: string;
  readonly createdAt: string;
}

interface ArtifactRow {
  readonly id: string;
  readonly land_group_id: string;
  readonly authority_decision_id: string;
  readonly integration_node_id: string;
  readonly proof_root: string;
  readonly receipt_main_sha: string;
  readonly deploy_deployment_id: string;
  readonly demo_surface_kind: string;
  readonly demo_behavior_count: number;
  readonly demo_passed: number;
  readonly bundle_digest: string;
  readonly content_hash: string;
  readonly created_at: Date | string;
  readonly manifest: unknown;
}

const SUMMARY_COLUMNS = `id, land_group_id, authority_decision_id, integration_node_id, proof_root,
   receipt_main_sha, deploy_deployment_id, demo_surface_kind, demo_behavior_count, demo_passed,
   bundle_digest, content_hash, created_at`;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toSummary(row: ArtifactRow): MergeTrainArtifactSummary {
  return {
    id: row.id,
    landGroupId: row.land_group_id,
    authorityDecisionId: row.authority_decision_id,
    integrationNodeId: row.integration_node_id,
    proofRoot: row.proof_root,
    receiptMainSha: row.receipt_main_sha,
    deployDeploymentId: row.deploy_deployment_id,
    demoSurfaceKind: row.demo_surface_kind,
    demoBehaviorCount: row.demo_behavior_count,
    demoPassed: row.demo_passed,
    bundleDigest: row.bundle_digest,
    contentHash: row.content_hash,
    createdAt: toIso(row.created_at),
  };
}

export class PgMergeTrainArtifactStore implements MergeTrainSealSink {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Idempotently persist ONE artifact row for a completed land group and, only on a
   * fresh insert, append the frozen seal event. Returns whether a row was created.
   */
  async persist(input: MergeTrainPersistInput): Promise<{ inserted: boolean }> {
    const id = `mta-${input.landGroupId}`;
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO merge_train_artifacts
           (org_id, id, project_id, land_group_id, authority_decision_id, integration_node_id,
            proof_root, receipt_audit_id, receipt_main_sha, deploy_provider, deploy_app_id,
            deploy_deployment_id, demo_surface_kind, demo_behavior_count, demo_passed,
            bundle_id, bundle_digest, bytes_digest, content_hash, manifest)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)
         ON CONFLICT (org_id, land_group_id) DO NOTHING
         RETURNING id`,
        [
          input.orgId,
          id,
          input.projectId,
          input.landGroupId,
          input.authorityDecisionId,
          input.integrationNodeId,
          input.proofRoot,
          input.receiptAuditId,
          input.receiptMainSha,
          input.deployProvider,
          input.deployAppId,
          input.deployDeploymentId,
          input.demoSurfaceKind,
          input.demoBehaviorCount,
          input.demoPassed,
          input.bundleId,
          input.bundleDigest,
          input.bytesDigest,
          input.contentHash,
          JSON.stringify(input.artifact),
        ],
      );
      if (inserted.rows[0] === undefined) return { inserted: false };
      await new PgEventStore(client).append({
        runId: input.runId,
        specId: input.specId,
        projectId: input.projectId,
        orgId: input.orgId,
        eventType: "merge.train.artifact.sealed",
        payload: {
          projectId: input.projectId,
          landGroupId: input.landGroupId,
          authorityDecisionId: input.authorityDecisionId,
          integrationNodeId: input.integrationNodeId,
          proofRoot: input.proofRoot,
          bundleId: input.bundleId,
          bundleDigest: input.bundleDigest,
          bytesDigest: input.bytesDigest,
          signingKeyId: input.artifact.sealedBundle.signingKeyId,
          contentHash: input.contentHash,
        },
      });
      return { inserted: true };
    });
  }

  /** List the project's sealed artifacts, newest first. Client is already org-scoped. */
  static async list(
    client: pg.PoolClient,
    orgId: string,
    projectId: string,
    limit: number,
  ): Promise<MergeTrainArtifactSummary[]> {
    const result = await client.query<ArtifactRow>(
      `SELECT ${SUMMARY_COLUMNS}
         FROM merge_train_artifacts
        WHERE org_id = $1 AND project_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [orgId, projectId, limit],
    );
    return result.rows.map(toSummary);
  }

  /** Load one artifact's re-validated strict manifest, or undefined. Client is org-scoped. */
  static async getByLandGroup(
    client: pg.PoolClient,
    orgId: string,
    projectId: string,
    landGroupId: string,
  ): Promise<MergeTrainArtifactV1 | undefined> {
    const result = await client.query<ArtifactRow>(
      `SELECT manifest FROM merge_train_artifacts
        WHERE org_id = $1 AND project_id = $2 AND land_group_id = $3
        LIMIT 1`,
      [orgId, projectId, landGroupId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return validateMergeTrainArtifact(row.manifest);
  }
}
