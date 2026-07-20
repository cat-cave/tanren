// mq-15 durable store for the merge-train artifact projection. The write path is a
// single org-scoped transaction: INSERT ... ON CONFLICT (org_id, land_group_id) DO
// NOTHING (append-only idempotency — a duplicate watcher delivery is a clean no-op),
// and the frozen `merge.train.artifact.sealed` event is appended on the SAME client
// only when a fresh row was inserted. Reads take an already-scoped client so a route
// composes them inside its own `runWithOrgScope` + `assertProjectAccess` transaction.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { PgEventStore } from "../eventStore.js";
import { parseDigest, type ProofBundleSealed, type ProofUnitKind, type ProofUnitVerdict } from "../contracts/cas.js";
import { type MergeTrainArtifactV1, validateMergeTrainArtifact } from "../contracts/mergeTrainArtifact.js";
import type { MergeTrainPersistInput, MergeTrainSealSink } from "./mergeTrainArtifactSeal.js";

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

  /**
   * Reconstruct the persisted `ProofBundleSealed` for a bundle id from `proof_bundles`
   * + its ordered `proof_bundle_units` + `proof_units`, so the export route can re-invoke
   * `ProofSubstrate.verify` on the served artifact. Undefined when any row is missing
   * (a dangling reference fails closed rather than serving an unverifiable artifact).
   */
  static async loadSealedBundle(
    client: pg.PoolClient,
    orgId: string,
    bundleId: string,
  ): Promise<ProofBundleSealed | undefined> {
    const bundle = (
      await client.query<BundleRow>(
        `SELECT bundle_digest, proof_root, bytes_digest, integration_node_id, member_set_hash,
                prepared_head_sha, jj_tree_id, artifact_digest, expected_main_sha, signing_key_id,
                root_signature, nonce, issued_at, expires_at
           FROM proof_bundles WHERE org_id = $1 AND id = $2`,
        [orgId, bundleId],
      )
    ).rows[0];
    if (bundle === undefined) return undefined;
    const units = (
      await client.query<BundleUnitRow>(
        `SELECT u.proof_unit_digest, u.ordinal, p.kind, p.verdict
           FROM proof_bundle_units u
           JOIN proof_units p ON p.org_id = u.org_id AND p.proof_unit_digest = u.proof_unit_digest
          WHERE u.org_id = $1 AND u.bundle_id = $2
          ORDER BY u.ordinal ASC`,
        [orgId, bundleId],
      )
    ).rows;
    if (units.length === 0) return undefined;
    return {
      bundleId,
      bundleDigest: parseDigest(bundle.bundle_digest),
      proofRoot: parseDigest(bundle.proof_root),
      members: units.map((unit) => ({
        bundleUnitId: `${bundleId}-${unit.ordinal}`,
        unitDigest: parseDigest(unit.proof_unit_digest),
        kind: unit.kind as ProofUnitKind,
        verdict: unit.verdict as ProofUnitVerdict,
        ordinal: unit.ordinal,
      })),
      bindings: {
        integrationNodeId: bundle.integration_node_id,
        memberSetHash: bundle.member_set_hash,
        preparedHeadSha: bundle.prepared_head_sha,
        jjTreeId: bundle.jj_tree_id,
        artifactDigest: parseDigest(bundle.artifact_digest),
        expectedMainSha: bundle.expected_main_sha,
        issuedAt: toIso(bundle.issued_at),
        expiresAt: toIso(bundle.expires_at),
        nonce: bundle.nonce,
      },
      bytesDigest: parseDigest(bundle.bytes_digest),
      signingKeyId: bundle.signing_key_id,
      rootSignature: new Uint8Array(bundle.root_signature),
    };
  }
}

interface BundleRow {
  readonly bundle_digest: string;
  readonly proof_root: string;
  readonly bytes_digest: string;
  readonly integration_node_id: string;
  readonly member_set_hash: string;
  readonly prepared_head_sha: string;
  readonly jj_tree_id: string;
  readonly artifact_digest: string;
  readonly expected_main_sha: string;
  readonly signing_key_id: string;
  readonly root_signature: Buffer;
  readonly nonce: string;
  readonly issued_at: Date | string;
  readonly expires_at: Date | string;
}

interface BundleUnitRow {
  readonly proof_unit_digest: string;
  readonly ordinal: number;
  readonly kind: string;
  readonly verdict: string;
}
