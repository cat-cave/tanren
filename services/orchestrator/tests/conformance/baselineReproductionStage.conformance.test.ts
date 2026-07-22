// cspell:ignore scontract vassert vartifact
import { describe, expect, it } from "vitest";
import { AllowAllPeerVerifier } from "../../src/engine/contracts/mtlsChannel.js";
import type { ResolutionJob, ResolutionStageResult } from "../../src/engine/contracts/resolutionStage.js";
import type { ResolutionJobStore } from "../../src/engine/repositories/resolutionJobs.js";
import type { SymptomBaselineResult } from "../../src/engine/contracts/symptomProbe.js";
import { symptomContractHash, type SymptomContractV1 } from "../../src/engine/contracts/symptomContract.js";
import type { SymptomContractRow } from "../../src/engine/repositories/symptomContracts.js";
import { buildInternalApp } from "../../src/internalServer.js";
import {
  BaselineReproductionStage,
  finalizeBaselineVerificationRun,
} from "../../src/engine/verification/resolutionStages/baselineReproductionStage.js";
import { LockedBehaviorContextError } from "../../src/engine/verification/resolutionStages/resolutionBehaviorContext.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

const job: ResolutionJob = {
  id: "rjob_baseline",
  orgId: "org_baseline",
  projectId: "project_baseline",
  issueLoopId: "iloop_baseline",
  contractId: "scontract_baseline",
  stage: "baseline",
  state: "running",
  leaseOwner: "worker_baseline",
  leaseExpiry: "2026-01-01T00:01:00.000Z",
  idempotencyKey: "iloop_baseline:baseline",
  attempt: 2,
};

// bh-15: the stage now consumes ONLY a locked behavior context; supply a valid
// one so these conformance cases exercise settlement, not the lock itself.
const LOCKED_CONTEXT = {
  behaviorContext: {
    contractId: job.contractId,
    issueLoopId: job.issueLoopId,
    releaseInstanceId: "release_baseline",
    artifactDigest: DIGEST,
    behaviors: [],
    personaRevisionIds: [],
    contextDigest: DIGEST,
  },
};

const lockedContract: SymptomContractV1 = {
  version: 1,
  issueLoopId: job.issueLoopId,
  target: { url: "https://example.invalid/reproduce" },
  expectedFailingObservation: { status: 500 },
  expectedCorrectedObservation: { status: 200 },
  proofPolicy: "active_causal",
  sourceRevision: "revision_baseline",
  baselineRequired: true,
};

function contract(): SymptomContractRow {
  return {
    orgId: job.orgId,
    projectId: job.projectId,
    id: job.contractId,
    issueLoopId: job.issueLoopId,
    schemaVersion: 1,
    contract: lockedContract,
    canonicalHash: symptomContractHash(lockedContract),
    proofPolicy: "active_causal",
    target: { url: "https://example.invalid/reproduce" },
    sourceRevision: "revision_baseline",
    authorTaskId: null,
    state: "validated",
    baselineRequired: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function baseline(outcome: SymptomBaselineResult["baselineOutcome"]): SymptomBaselineResult {
  return {
    orgId: job.orgId,
    projectId: job.projectId,
    issueLoopId: job.issueLoopId,
    contractId: job.contractId,
    verificationRunId: "vrun_baseline",
    expectedHash: DIGEST,
    observedHash: outcome === "reproduced" ? DIGEST : `sha256:${"b".repeat(64)}`,
    outcome: outcome === "inconclusive" ? "inconclusive" : outcome === "reproduced" ? "passed" : "failed",
    baselineOutcome: outcome,
    timingMs: 4,
    evidence: [{ id: "vartifact_baseline", digest: DIGEST, byteSize: 1, mediaType: "application/json" }],
    assertionId: "vassert_baseline",
  };
}

function stageFor(outcome: SymptomBaselineResult["baselineOutcome"]) {
  const writes: Array<{ stage: string; classification: string }> = [];
  const finalizations: Array<{ classification: string; status: string }> = [];
  const loopStates: string[] = [];
  const stage = new BaselineReproductionStage({
    pool: {} as never,
    contracts: { get: async () => contract() },
    contextResolver: {
      resolve: async () => ({
        environmentId: "venv_baseline",
        preparedHeadSha: "a".repeat(40),
        jjTreeId: "tree_baseline",
        planSetHash: DIGEST,
        artifactDigest: DIGEST,
        policy: { proofPolicy: "active_causal" },
      }),
    },
    writeVerificationRun: async (input) => {
      writes.push({ stage: input.stage, classification: input.classification });
      return input.id;
    },
    probe: { runBaseline: async () => baseline(outcome) },
    finalizeVerificationRun: async (input) => {
      finalizations.push({ classification: input.classification, status: input.status });
    },
    transitionIssueLoop: async (input) => {
      loopStates.push(input.state);
    },
  });
  return { stage, writes, finalizations, loopStates };
}

class BaselineStageSqlMemoryPool {
  public readonly verificationRuns: Array<{
    id: string;
    stage: string;
    resolutionJobId: string;
    classification: string;
    status: string;
  }> = [];

  private readonly client = {
    query: async (rawSql: string, params: readonly unknown[] = []) => this.query(rawSql, params),
    release: () => {},
  };

  public async connect() {
    return this.client;
  }

  private async query(rawSql: string, params: readonly unknown[]) {
    const sql = rawSql.replaceAll(/\s+/gu, " ").trim();
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO behavior_verification_runs")) {
      const [
        _,
        id,
        _projectId,
        _purpose,
        _runId,
        _specId,
        _integrationNodeId,
        _environmentId,
        _head,
        _tree,
        _plan,
        _context,
        _artifact,
        status,
        _policy,
        stage,
        resolutionJobId,
        classification,
      ] = params as readonly [
        string,
        string,
        string,
        string,
        unknown,
        unknown,
        unknown,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      this.verificationRuns.push({ id, stage, resolutionJobId, classification, status });
      return { rows: [{ id, status, classification }], rowCount: 1 };
    }
    if (sql.includes("FROM symptom_contracts")) {
      const [orgId, contractId] = params as readonly [string, string];
      const row = contract();
      if (orgId !== row.orgId || contractId !== row.id) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            org_id: row.orgId,
            project_id: row.projectId,
            id: row.id,
            issue_loop_id: row.issueLoopId,
            schema_version: row.schemaVersion,
            contract_json: row.contract,
            canonical_hash: row.canonicalHash,
            proof_policy: row.proofPolicy,
            target: row.target,
            source_revision: row.sourceRevision,
            author_task_id: row.authorTaskId,
            state: row.state,
            baseline_required: row.baselineRequired,
            created_at: row.createdAt,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.startsWith("UPDATE behavior_verification_runs")) {
      const [orgId, id, classification, status, resolutionJobId] = params as readonly [
        string,
        string,
        string,
        string,
        string,
      ];
      if (orgId !== job.orgId) return { rows: [], rowCount: 0 };
      const row = this.verificationRuns.find(
        (run) => run.id === id && run.stage === "baseline" && run.resolutionJobId === resolutionJobId,
      );
      if (row === undefined) return { rows: [], rowCount: 0 };
      row.classification = classification;
      row.status = status;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`BaselineStageSqlMemoryPool: unrecognized SQL: ${sql}`);
  }
}

describe("BaselineReproductionStage conformance", () => {
  it("records a reproduced product failure as a successful baseline assertion", async () => {
    const harness = stageFor("reproduced");

    await expect(harness.stage.run(job, LOCKED_CONTEXT)).resolves.toMatchObject<Partial<ResolutionStageResult>>({
      outcome: "passed",
      classification: "product_failure",
      proofGrade: "active_causal",
      verificationRunId: "vrun_baseline",
      assertionIds: ["vassert_baseline"],
      evidenceRefs: ["vartifact_baseline"],
    });
    expect(harness.writes).toEqual([{ stage: "baseline", classification: "inconclusive" }]);
    expect(harness.finalizations).toEqual([{ classification: "product_failure", status: "completed" }]);
    expect(harness.loopStates).toEqual(["reproduced"]);
  });

  it("keeps an infrastructure failure inconclusive and awaits reproduction", async () => {
    const harness = stageFor("inconclusive");

    await expect(harness.stage.run(job, LOCKED_CONTEXT)).resolves.toMatchObject<Partial<ResolutionStageResult>>({
      outcome: "inconclusive",
      classification: "infra_failure",
      verificationRunId: "vrun_baseline",
    });
    expect(harness.finalizations).toEqual([{ classification: "infra_failure", status: "failed" }]);
    expect(harness.loopStates).toEqual(["awaiting_reproduction"]);
  });

  it("surfaces a product-failure finalization error without reclassifying it as infrastructure", async () => {
    const finalizationError = new Error("finalize unavailable");
    const finalizations: string[] = [];
    const loopStates: string[] = [];
    const stage = new BaselineReproductionStage({
      pool: {} as never,
      contracts: { get: async () => contract() },
      contextResolver: {
        resolve: async () => ({
          verificationRunId: "vrun_baseline",
          environmentId: "venv_baseline",
          preparedHeadSha: "a".repeat(40),
          jjTreeId: "tree_baseline",
          planSetHash: DIGEST,
          runtimeBehaviorContextHash: DIGEST,
          artifactDigest: DIGEST,
          policy: { proofPolicy: "active_causal" },
        }),
      },
      writeVerificationRun: async (input) => input.id,
      probe: { runBaseline: async () => baseline("reproduced") },
      finalizeVerificationRun: async (input) => {
        finalizations.push(input.classification);
        throw finalizationError;
      },
      transitionIssueLoop: async (input) => {
        loopStates.push(input.state);
      },
    });

    await expect(stage.run(job, LOCKED_CONTEXT)).rejects.toThrow(finalizationError);
    expect(finalizations).toEqual(["product_failure"]);
    expect(loopStates).toEqual([]);
  });

  it("uses the shared run writer and finalizes its classification through the SQL conformance fake", async () => {
    const pool = new BaselineStageSqlMemoryPool();
    const stage = new BaselineReproductionStage({
      pool: pool as never,
      contracts: { get: async () => contract() },
      contextResolver: {
        resolve: async () => ({
          environmentId: "venv_baseline",
          preparedHeadSha: "a".repeat(40),
          jjTreeId: "tree_baseline",
          planSetHash: DIGEST,
          artifactDigest: DIGEST,
          policy: { proofPolicy: "active_causal" },
        }),
      },
      probe: { runBaseline: async () => ({ ...baseline("reproduced"), verificationRunId: "vrun_sql_baseline" }) },
      transitionIssueLoop: async () => {},
      verificationRunId: () => "vrun_sql_baseline",
    });

    await expect(stage.run(job, LOCKED_CONTEXT)).resolves.toMatchObject({
      outcome: "passed",
      classification: "product_failure",
      verificationRunId: "vrun_sql_baseline",
    });
    expect(pool.verificationRuns).toEqual([
      {
        id: "vrun_sql_baseline",
        stage: "baseline",
        resolutionJobId: job.id,
        classification: "product_failure",
        status: "completed",
      },
    ]);
  });

  it("matches zero fake rows when the stage or resolution job predicate is wrong", async () => {
    const pool = new BaselineStageSqlMemoryPool();
    pool.verificationRuns.push(
      {
        id: "vrun_wrong_stage",
        stage: "production",
        resolutionJobId: job.id,
        classification: "inconclusive",
        status: "running",
      },
      {
        id: "vrun_wrong_job",
        stage: "baseline",
        resolutionJobId: "rjob_someone_else",
        classification: "inconclusive",
        status: "running",
      },
    );

    await expect(
      finalizeBaselineVerificationRun(pool as never, {
        orgId: job.orgId,
        verificationRunId: "vrun_wrong_stage",
        resolutionJobId: job.id,
        classification: "product_failure",
        status: "completed",
      }),
    ).resolves.toBe(0);
    await expect(
      finalizeBaselineVerificationRun(pool as never, {
        orgId: job.orgId,
        verificationRunId: "vrun_wrong_job",
        resolutionJobId: job.id,
        classification: "product_failure",
        status: "completed",
      }),
    ).resolves.toBe(0);
    expect(pool.verificationRuns.map(({ classification, status }) => ({ classification, status }))).toEqual([
      { classification: "inconclusive", status: "running" },
      { classification: "inconclusive", status: "running" },
    ]);
  });

  it("fails /reproduce CLOSED (terminal stale_contract) when the locked behavior context cannot be loaded — the baseline stage never runs", async () => {
    const pool = new BaselineStageSqlMemoryPool();
    const probeCalls: string[] = [];
    const completes: string[] = [];
    const releases: string[] = [];
    const app = buildInternalApp({
      pool: pool as never,
      verifier: new AllowAllPeerVerifier(),
      // The lock fails: no caller-supplied context can stand in, and a stale/absent
      // binding is TERMINAL — the endpoint settles stale_contract, never retryable.
      behaviorContextLoader: {
        load: () => Promise.reject(new LockedBehaviorContextError("empty_binding", "release binds no behaviors")),
      },
      baselineProbe: {
        runBaseline: async (input) => {
          probeCalls.push(input.verificationRunId);
          return { ...baseline("not_reproduced"), verificationRunId: input.verificationRunId };
        },
      },
      resolutionJobStore: {
        async verifyActiveLease() {
          return job;
        },
        async complete() {
          completes.push(job.id);
          return true;
        },
        async release() {
          releases.push(job.id);
          return true;
        },
      } as unknown as ResolutionJobStore,
    });

    const response = await app.request(
      `/internal/resolution-jobs/${job.id}/reproduce`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId: job.orgId, leaseOwner: job.leaseOwner }),
      },
      { incoming: { socket: {} } },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "stale_behavior_contract", reason: "empty_binding" });
    // The baseline stage never ran (no probe, no verification run row); the job was
    // COMPLETED (terminal), not returned to retryable.
    expect(probeCalls).toEqual([]);
    expect(pool.verificationRuns).toEqual([]);
    expect(completes).toEqual([job.id]);
    expect(releases).toEqual([]);
  });
});
