// MQ-6 in-memory proof-unit repository. It deliberately uses the shared
// conformance MemoryDb records, so its tenant/immutability assumptions stay visible.

import type {
  IntegrationProofUnit,
  IntegrationProofUnitRepository,
} from "../../../src/engine/repositories/integrationProofUnits.js";
import { MemoryDb } from "../conformanceMemoryDb.js";

export function createInMemoryIntegrationProofUnitStore(
  db = new MemoryDb(),
): IntegrationProofUnitRepository & { readonly db: MemoryDb } {
  let sequence = 0;
  return {
    db,
    async findReusable(input) {
      const row = db.integrationProofUnits.find(
        (unit) =>
          unit.org_id === input.orgId &&
          unit.project_id === input.projectId &&
          unit.kind === input.kind &&
          unit.subject_id === input.subjectId &&
          unit.input_hash === input.inputHash &&
          unit.quarantine_epoch === input.quarantineEpoch &&
          (unit.expires_at === null || unit.expires_at > new Date()),
      );
      return row === undefined ? undefined : fromRecord(row);
    },
    async record(input) {
      sequence += 1;
      const proofUnitId = `punit_fake_${sequence}`;
      db.integrationProofUnits.push({
        org_id: input.orgId,
        project_id: input.projectId,
        proof_unit_id: proofUnitId,
        kind: input.kind,
        subject_id: input.subjectId,
        input_hash: input.inputHash,
        verdict: input.verdict,
        artifact_hash: input.artifactHash ?? null,
        source_node_id: input.sourceNodeId ?? null,
        quarantine_epoch: input.quarantineEpoch,
        expires_at: input.expiresAt ?? null,
        created_at: new Date(),
      });
      return { ...input, proofUnitId };
    },
    async attachEvaluation(input) {
      for (const proofUnitId of input.proofUnitIds) {
        if (
          !db.integrationProofUnits.some(
            (unit) =>
              unit.org_id === input.orgId && unit.project_id === input.projectId && unit.proof_unit_id === proofUnitId,
          )
        ) {
          throw new Error(`fake proof unit ${proofUnitId} is not visible`);
        }
        if (
          !db.integrationEvaluationProofs.some(
            (row) =>
              row.org_id === input.orgId &&
              row.evaluation_id === input.evaluationId &&
              row.proof_unit_id === proofUnitId,
          )
        ) {
          db.integrationEvaluationProofs.push({
            org_id: input.orgId,
            project_id: input.projectId,
            evaluation_id: input.evaluationId,
            proof_unit_id: proofUnitId,
          });
        }
      }
    },
    async recordEdges(input) {
      for (const edge of input.edges) {
        const hasUnit = (proofUnitId: string): boolean =>
          db.integrationProofUnits.some(
            (unit) =>
              unit.org_id === input.orgId && unit.project_id === input.projectId && unit.proof_unit_id === proofUnitId,
          );
        if (!hasUnit(edge.parentUnitId) || !hasUnit(edge.childUnitId))
          throw new Error("fake proof edge crosses project scope");
        if (
          !db.integrationProofEdges.some(
            (row) =>
              row.org_id === input.orgId &&
              row.parent_unit_id === edge.parentUnitId &&
              row.child_unit_id === edge.childUnitId,
          )
        ) {
          db.integrationProofEdges.push({
            org_id: input.orgId,
            project_id: input.projectId,
            parent_unit_id: edge.parentUnitId,
            child_unit_id: edge.childUnitId,
          });
        }
      }
    },
    async evaluationGraph(input) {
      const ids = new Set(
        db.integrationEvaluationProofs
          .filter(
            (row) =>
              row.org_id === input.orgId &&
              row.project_id === input.projectId &&
              row.evaluation_id === input.evaluationId,
          )
          .map((row) => row.proof_unit_id),
      );
      return {
        units: db.integrationProofUnits
          .filter((row) => row.org_id === input.orgId && ids.has(row.proof_unit_id))
          .map((row) => fromRecord(row)),
        edges: db.integrationProofEdges
          .filter((row) => row.org_id === input.orgId && ids.has(row.parent_unit_id) && ids.has(row.child_unit_id))
          .map((row) => ({ parentUnitId: row.parent_unit_id, childUnitId: row.child_unit_id })),
      };
    },
    async nodeProofState(input) {
      const row = db.integrationNodes.find(
        (node) => node.org_id === input.orgId && node.project_id === input.projectId && node.node_id === input.nodeId,
      );
      return row === undefined
        ? undefined
        : {
            ...(row.proof_root !== null && { proofRoot: row.proof_root }),
            ...(row.quarantine_epoch !== null && { quarantineEpoch: row.quarantine_epoch }),
          };
    },
    async stampNodeProof(input) {
      const row = db.integrationNodes.find(
        (node) => node.org_id === input.orgId && node.project_id === input.projectId && node.node_id === input.nodeId,
      );
      if (row === undefined) throw new Error(`fake integration node ${input.nodeId} is not visible`);
      row.proof_root = input.proofRoot;
      row.quarantine_epoch = input.quarantineEpoch;
      row.toolchain_hash = input.toolchainHash;
      row.design_contract_version = input.designContractVersion;
      row.behavior_manifest_hash = input.behaviorManifestHash;
    },
  };
}

function fromRecord(row: MemoryDb["integrationProofUnits"][number]): IntegrationProofUnit {
  if (row.input_hash === null) throw new Error(`fake proof unit ${row.proof_unit_id} is not reusable`);
  return {
    orgId: row.org_id,
    projectId: row.project_id,
    proofUnitId: row.proof_unit_id,
    kind: row.kind,
    subjectId: row.subject_id,
    inputHash: row.input_hash,
    verdict: row.verdict as IntegrationProofUnit["verdict"],
    quarantineEpoch: row.quarantine_epoch,
    ...(row.artifact_hash !== null && { artifactHash: row.artifact_hash }),
    ...(row.source_node_id !== null && { sourceNodeId: row.source_node_id }),
    ...(row.expires_at !== null && { expiresAt: row.expires_at }),
  };
}
