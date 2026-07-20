import { describe, expect, it } from "vitest";
import { PgIntegrationProofUnitRepository } from "../src/engine/repositories/integrationProofUnits.js";

class ProofRepositoryPool {
  public evaluationRows: unknown[] = [];
  public edgeRows: unknown[] = [];
  public async connect(): Promise<this> {
    return this;
  }

  public release(): void {}

  public async query(sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.includes("INSERT INTO integration_evaluation_proofs")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT 1 FROM integration_evaluation_proofs")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO integration_proof_edges")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT 1 FROM integration_proof_edges")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM integration_evaluation_proofs e"))
      return { rows: this.evaluationRows, rowCount: this.evaluationRows.length };
    if (sql.includes("FROM integration_proof_edges\n")) return { rows: this.edgeRows, rowCount: this.edgeRows.length };
    if (sql.includes("UPDATE integration_nodes")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  }

  public asPgPool(): never {
    return this as never;
  }
}

const exactNode = {
  orgId: "org_eager",
  projectId: "project_eager",
  nodeId: "inode_eager",
  proofRoot: `sha256:${"a".repeat(64)}`,
  quarantineEpoch: 1,
  toolchainHash: `sha256:${"b".repeat(64)}`,
  designContractVersion: "policy.v1",
  behaviorManifestHash: `sha256:${"c".repeat(64)}`,
};

describe("EAGER proof repository fail-closed persistence", () => {
  it("rejects an evaluation attachment when its exact proof unit is not visible", async () => {
    const repository = new PgIntegrationProofUnitRepository(new ProofRepositoryPool().asPgPool());

    await expect(
      repository.attachEvaluation({
        orgId: "org_eager",
        projectId: "project_eager",
        evaluationId: "eval_eager",
        proofUnitIds: ["punit_missing"],
      }),
    ).rejects.toThrow("proof unit punit_missing is not visible in project project_eager");
  });

  it("rejects an evidence edge when either exact endpoint is not visible", async () => {
    const repository = new PgIntegrationProofUnitRepository(new ProofRepositoryPool().asPgPool());

    await expect(
      repository.recordEdges({
        orgId: "org_eager",
        projectId: "project_eager",
        edges: [{ parentUnitId: "punit_parent", childUnitId: "punit_child" }],
      }),
    ).rejects.toThrow("proof edge is not visible in project project_eager");
  });

  it("does not fabricate an empty proof graph or stamp an unavailable node", async () => {
    const repository = new PgIntegrationProofUnitRepository(new ProofRepositoryPool().asPgPool());

    await expect(
      repository.evaluationGraph({ orgId: "org_eager", projectId: "project_eager", evaluationId: "eval_empty" }),
    ).resolves.toEqual({ units: [], edges: [] });
    await expect(repository.stampNodeProof(exactNode)).rejects.toThrow(
      "integration node inode_eager was not visible in project project_eager",
    );
  });

  it("rejects malformed persisted proof units instead of projecting reusable evidence", async () => {
    const pool = new ProofRepositoryPool();
    const repository = new PgIntegrationProofUnitRepository(pool.asPgPool());
    const validEvaluationRow = {
      org_id: "org_eager",
      project_id: "project_eager",
      proof_unit_id: "punit_eager",
      kind: "eager_materialization",
      subject_id: "frontier",
      input_hash: `sha256:${"d".repeat(64)}`,
      verdict: "pass",
      artifact_hash: null,
      source_node_id: null,
      quarantine_epoch: 1,
      expires_at: null,
    };
    pool.evaluationRows = [validEvaluationRow];

    await expect(
      repository.evaluationGraph({ orgId: "org_eager", projectId: "project_eager", evaluationId: "eval_exact" }),
    ).resolves.toEqual({
      units: [expect.objectContaining({ proofUnitId: "punit_eager", inputHash: `sha256:${"d".repeat(64)}` })],
      edges: [],
    });
    pool.evaluationRows = [{ ...validEvaluationRow, input_hash: null }];
    await expect(
      repository.evaluationGraph({ orgId: "org_eager", projectId: "project_eager", evaluationId: "eval_corrupt" }),
    ).rejects.toThrow("has no reusable input hash");
  });
});
