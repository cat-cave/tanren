// MQ-6 durable storage for immutable integration proof units and their DAG.

import { randomUUID } from "node:crypto";
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";

export type ProofUnitVerdict = "pass" | "fail" | "skipped";

export interface IntegrationProofUnit {
  readonly orgId: string;
  readonly projectId: string;
  readonly proofUnitId: string;
  readonly kind: string;
  readonly subjectId: string;
  readonly inputHash: string;
  readonly verdict: ProofUnitVerdict;
  readonly artifactHash?: string;
  readonly sourceNodeId?: string;
  readonly quarantineEpoch: number;
  readonly expiresAt?: Date;
}

export interface IntegrationProofEdge {
  readonly parentUnitId: string;
  readonly childUnitId: string;
}

export interface IntegrationNodeProofState {
  readonly proofRoot?: string;
  readonly quarantineEpoch?: number;
}

export interface IntegrationProofUnitRepository {
  findReusable(
    input: Pick<IntegrationProofUnit, "orgId" | "projectId" | "kind" | "subjectId" | "inputHash" | "quarantineEpoch">,
  ): Promise<IntegrationProofUnit | undefined>;
  record(input: Omit<IntegrationProofUnit, "proofUnitId">): Promise<IntegrationProofUnit>;
  attachEvaluation(input: {
    orgId: string;
    projectId: string;
    evaluationId: string;
    proofUnitIds: readonly string[];
  }): Promise<void>;
  recordEdges(input: { orgId: string; projectId: string; edges: readonly IntegrationProofEdge[] }): Promise<void>;
  evaluationGraph(input: { orgId: string; projectId: string; evaluationId: string }): Promise<{
    units: readonly IntegrationProofUnit[];
    edges: readonly IntegrationProofEdge[];
  }>;
  nodeProofState(input: {
    orgId: string;
    projectId: string;
    nodeId: string;
  }): Promise<IntegrationNodeProofState | undefined>;
  stampNodeProof(input: {
    orgId: string;
    projectId: string;
    nodeId: string;
    proofRoot: string;
    quarantineEpoch: number;
    toolchainHash: string;
    designContractVersion: string;
    behaviorManifestHash: string;
  }): Promise<void>;
}

interface ProofUnitRow {
  org_id: string;
  project_id: string;
  proof_unit_id: string;
  kind: string;
  subject_id: string;
  input_hash: string | null;
  verdict: ProofUnitVerdict;
  artifact_hash: string | null;
  source_node_id: string | null;
  quarantine_epoch: number;
  expires_at: Date | null;
}

/** Postgres implementation. Every table is queried only within the owning org scope. */
export class PgIntegrationProofUnitRepository implements IntegrationProofUnitRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findReusable(
    input: Pick<IntegrationProofUnit, "orgId" | "projectId" | "kind" | "subjectId" | "inputHash" | "quarantineEpoch">,
  ): Promise<IntegrationProofUnit | undefined> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<ProofUnitRow>(
        `SELECT org_id, project_id, proof_unit_id, kind, subject_id, input_hash, verdict,
                artifact_hash, source_node_id, quarantine_epoch, expires_at
           FROM integration_proof_units
          WHERE project_id = $1 AND kind = $2 AND subject_id = $3
            AND input_hash = $4 AND quarantine_epoch = $5
            AND (expires_at IS NULL OR expires_at > now())
          ORDER BY created_at DESC, proof_unit_id DESC
          LIMIT 1`,
        [input.projectId, input.kind, input.subjectId, input.inputHash, input.quarantineEpoch],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : rowToUnit(row);
    });
  }

  async record(input: Omit<IntegrationProofUnit, "proofUnitId">): Promise<IntegrationProofUnit> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const proofUnitId = `punit_${randomUUID()}`;
      await client.query(
        `INSERT INTO integration_proof_units
           (org_id, project_id, proof_unit_id, kind, subject_id, input_hash, verdict,
            artifact_hash, source_node_id, quarantine_epoch, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          input.orgId,
          input.projectId,
          proofUnitId,
          input.kind,
          input.subjectId,
          input.inputHash,
          input.verdict,
          input.artifactHash ?? null,
          input.sourceNodeId ?? null,
          input.quarantineEpoch,
          input.expiresAt ?? null,
        ],
      );
      return { ...input, proofUnitId };
    });
  }

  async attachEvaluation(input: {
    orgId: string;
    projectId: string;
    evaluationId: string;
    proofUnitIds: readonly string[];
  }): Promise<void> {
    if (input.proofUnitIds.length === 0) return;
    await runWithOrgScope(this.pool, input.orgId, async (client) => {
      for (const proofUnitId of input.proofUnitIds) {
        const result = await client.query(
          `INSERT INTO integration_evaluation_proofs (org_id, project_id, evaluation_id, proof_unit_id)
           SELECT $1, $2, $3, $4
             FROM integration_proof_units
            WHERE project_id = $2 AND proof_unit_id = $4
           ON CONFLICT DO NOTHING`,
          [input.orgId, input.projectId, input.evaluationId, proofUnitId],
        );
        if (result.rowCount === 0) {
          const exists = await client.query(
            "SELECT 1 FROM integration_evaluation_proofs WHERE project_id = $1 AND evaluation_id = $2 AND proof_unit_id = $3",
            [input.projectId, input.evaluationId, proofUnitId],
          );
          if (exists.rowCount === 0)
            throw new Error(`proof unit ${proofUnitId} is not visible in project ${input.projectId}`);
        }
      }
    });
  }

  async recordEdges(input: {
    orgId: string;
    projectId: string;
    edges: readonly IntegrationProofEdge[];
  }): Promise<void> {
    if (input.edges.length === 0) return;
    await runWithOrgScope(this.pool, input.orgId, async (client) => {
      for (const edge of input.edges) {
        const result = await client.query(
          `INSERT INTO integration_proof_edges (org_id, project_id, parent_unit_id, child_unit_id)
           SELECT $1, $2, $3, $4
            WHERE EXISTS (SELECT 1 FROM integration_proof_units WHERE project_id = $2 AND proof_unit_id = $3)
              AND EXISTS (SELECT 1 FROM integration_proof_units WHERE project_id = $2 AND proof_unit_id = $4)
           ON CONFLICT DO NOTHING`,
          [input.orgId, input.projectId, edge.parentUnitId, edge.childUnitId],
        );
        if (result.rowCount === 0) {
          const exists = await client.query(
            `SELECT 1 FROM integration_proof_edges
              WHERE project_id = $1 AND parent_unit_id = $2 AND child_unit_id = $3`,
            [input.projectId, edge.parentUnitId, edge.childUnitId],
          );
          if (exists.rowCount === 0) throw new Error(`proof edge is not visible in project ${input.projectId}`);
        }
      }
    });
  }

  async evaluationGraph(input: {
    orgId: string;
    projectId: string;
    evaluationId: string;
  }): Promise<{ units: readonly IntegrationProofUnit[]; edges: readonly IntegrationProofEdge[] }> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const unitRows = await client.query<ProofUnitRow>(
        `SELECT u.org_id, u.project_id, u.proof_unit_id, u.kind, u.subject_id, u.input_hash,
                u.verdict, u.artifact_hash, u.source_node_id, u.quarantine_epoch, u.expires_at
           FROM integration_evaluation_proofs e
           JOIN integration_proof_units u ON u.org_id = e.org_id AND u.project_id = e.project_id AND u.proof_unit_id = e.proof_unit_id
          WHERE e.project_id = $1 AND e.evaluation_id = $2`,
        [input.projectId, input.evaluationId],
      );
      const units = unitRows.rows.map(rowToUnit);
      if (units.length === 0) return { units, edges: [] };
      const ids = units.map((unit) => unit.proofUnitId);
      const edgeRows = await client.query<IntegrationProofEdge>(
        `SELECT parent_unit_id AS "parentUnitId", child_unit_id AS "childUnitId"
           FROM integration_proof_edges
          WHERE project_id = $1
            AND parent_unit_id = ANY($2::text[]) AND child_unit_id = ANY($2::text[])`,
        [input.projectId, ids],
      );
      return { units, edges: edgeRows.rows };
    });
  }

  async nodeProofState(input: {
    orgId: string;
    projectId: string;
    nodeId: string;
  }): Promise<IntegrationNodeProofState | undefined> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<{ proof_root: string | null; quarantine_epoch: number | null }>(
        `SELECT proof_root, quarantine_epoch FROM integration_nodes WHERE project_id = $1 AND node_id = $2`,
        [input.projectId, input.nodeId],
      );
      const row = result.rows[0];
      const state: IntegrationNodeProofState | undefined =
        row === undefined
          ? undefined
          : {
              ...(row.proof_root !== null && { proofRoot: row.proof_root }),
              ...(row.quarantine_epoch !== null && { quarantineEpoch: row.quarantine_epoch }),
            };
      return state;
    });
  }

  async stampNodeProof(input: {
    orgId: string;
    projectId: string;
    nodeId: string;
    proofRoot: string;
    quarantineEpoch: number;
    toolchainHash: string;
    designContractVersion: string;
    behaviorManifestHash: string;
  }): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query(
        `UPDATE integration_nodes
            SET proof_root = $3, quarantine_epoch = $4, toolchain_hash = $5,
                design_contract_version = $6, behavior_manifest_hash = $7, updated_at = now()
          WHERE project_id = $1 AND node_id = $2`,
        [
          input.projectId,
          input.nodeId,
          input.proofRoot,
          input.quarantineEpoch,
          input.toolchainHash,
          input.designContractVersion,
          input.behaviorManifestHash,
        ],
      );
      if (result.rowCount !== 1)
        throw new Error(`integration node ${input.nodeId} was not visible in project ${input.projectId}`);
    });
  }
}

function rowToUnit(row: ProofUnitRow): IntegrationProofUnit {
  if (row.input_hash === null) throw new Error(`proof unit ${row.proof_unit_id} has no reusable input hash`);
  return {
    orgId: row.org_id,
    projectId: row.project_id,
    proofUnitId: row.proof_unit_id,
    kind: row.kind,
    subjectId: row.subject_id,
    inputHash: row.input_hash,
    verdict: row.verdict,
    quarantineEpoch: row.quarantine_epoch,
    ...(row.artifact_hash !== null && { artifactHash: row.artifact_hash }),
    ...(row.source_node_id !== null && { sourceNodeId: row.source_node_id }),
    ...(row.expires_at !== null && { expiresAt: row.expires_at }),
  };
}
