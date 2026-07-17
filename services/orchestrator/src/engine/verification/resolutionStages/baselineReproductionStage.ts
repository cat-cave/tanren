import { runWithOrgScope } from "@tanren/db";
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { ResolutionJob, ResolutionStage, ResolutionStageResult } from "../../contracts/resolutionStage.js";
import type { SymptomBaselineResult } from "../../contracts/symptomProbe.js";
import { HttpSymptomProbe } from "../../probes/httpSymptomProbe.js";
import { SymptomProbeAdapter } from "../../probes/symptomProbeAdapter.js";
import { IssueLoopStore } from "../../repositories/issueLoops.js";
import { SymptomContractStore, type SymptomContractRow } from "../../repositories/symptomContracts.js";
import {
  writeBehaviorVerificationRunStage,
  type BehaviorVerificationRunStatus,
  type WriteBehaviorVerificationRunStageInput,
} from "../behaviorVerificationRunStage.js";

export type BaselineProbe = Pick<SymptomProbeAdapter, "runBaseline">;
type ContractReader = Pick<SymptomContractStore, "get">;

export interface BaselineReproductionContext {
  readonly verificationRunId?: string;
  readonly environmentId: string;
  readonly preparedHeadSha: string;
  readonly jjTreeId: string;
  readonly planSetHash: string;
  readonly runtimeBehaviorContextHash: string;
  readonly artifactDigest: string;
  readonly integrationNodeId?: string;
  readonly policy: Readonly<Record<string, unknown>>;
}

export interface BaselineRuntimeContextResolver {
  resolve(input: {
    readonly job: ResolutionJob;
    readonly contract: SymptomContractRow;
  }): Promise<BaselineReproductionContext>;
}

export interface FinalizeVerificationRunInput {
  readonly orgId: string;
  readonly verificationRunId: string;
  readonly resolutionJobId: string;
  readonly classification: ResolutionStageResult["classification"];
  readonly status: BehaviorVerificationRunStatus;
}

export interface BaselineReproductionStageDependencies {
  readonly pool: pg.Pool;
  readonly probe?: BaselineProbe;
  readonly contracts?: ContractReader;
  readonly contextResolver?: BaselineRuntimeContextResolver;
  readonly writeVerificationRun?: (input: WriteBehaviorVerificationRunStageInput) => Promise<string>;
  readonly finalizeVerificationRun?: (input: FinalizeVerificationRunInput) => Promise<void>;
  readonly transitionIssueLoop?: (input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly issueLoopId: string;
    readonly state: "awaiting_reproduction" | "reproduced";
  }) => Promise<void>;
  readonly verificationRunId?: () => string;
}

type BaselineClassification =
  | {
      readonly outcome: "passed";
      readonly classification: "product_failure";
      readonly status: "completed";
      readonly loopState: "reproduced";
    }
  | {
      readonly outcome: "failed";
      readonly classification: "stale_contract";
      readonly status: "completed";
      readonly loopState?: undefined;
    }
  | {
      readonly outcome: "inconclusive";
      readonly classification: "infra_failure";
      readonly status: "failed";
      readonly loopState: "awaiting_reproduction";
    };

/**
 * Replays an immutable symptom contract against the currently live release.
 *
 * The shared run writer creates the row before the SP-5 adapter executes: its
 * evidence and assertion rows have a foreign key to that verification run. The
 * row starts as inconclusive, then the completed probe updates its classification.
 */
export class BaselineReproductionStage implements ResolutionStage {
  public readonly kind = "baseline" as const;

  private readonly probe: BaselineProbe;
  private readonly contracts: ContractReader;
  private readonly contextResolver: BaselineRuntimeContextResolver;
  private readonly writeVerificationRun: (input: WriteBehaviorVerificationRunStageInput) => Promise<string>;
  private readonly finalizeVerificationRun: (input: FinalizeVerificationRunInput) => Promise<void>;
  private readonly transitionIssueLoop: NonNullable<BaselineReproductionStageDependencies["transitionIssueLoop"]>;
  private readonly verificationRunId: () => string;

  public constructor(private readonly dependencies: BaselineReproductionStageDependencies) {
    this.probe = dependencies.probe ?? new SymptomProbeAdapter(dependencies.pool, new HttpSymptomProbe());
    this.contracts = dependencies.contracts ?? new SymptomContractStore(dependencies.pool);
    this.contextResolver = dependencies.contextResolver ?? new PgBaselineRuntimeContextResolver(dependencies.pool);
    this.writeVerificationRun = dependencies.writeVerificationRun ?? this.writeRunOnPool.bind(this);
    this.finalizeVerificationRun = dependencies.finalizeVerificationRun ?? this.finalizeRunOnPool.bind(this);
    this.transitionIssueLoop = dependencies.transitionIssueLoop ?? this.transitionLoopOnPool.bind(this);
    this.verificationRunId = dependencies.verificationRunId ?? (() => `vrun_baseline_${randomUUID()}`);
  }

  public async run(job: ResolutionJob, ctx: unknown): Promise<ResolutionStageResult> {
    if (job.stage !== this.kind) throw new Error(`baseline stage cannot run ${job.stage} job ${job.id}`);
    const contract = await this.contracts.get(job.orgId, job.contractId);
    if (contract === undefined)
      throw new Error(`resolution job ${job.id} references a missing symptom contract ${job.contractId}`);
    if (contract.projectId !== job.projectId || contract.issueLoopId !== job.issueLoopId) {
      throw new Error(`resolution job ${job.id} does not match its locked symptom contract`);
    }

    const runtime = await this.resolveRuntimeContext(ctx, job, contract);
    const verificationRunId = runtime.verificationRunId ?? this.verificationRunId();
    await this.writeVerificationRun({
      orgId: job.orgId,
      id: verificationRunId,
      projectId: job.projectId,
      purpose: "manual_canary",
      environmentId: runtime.environmentId,
      preparedHeadSha: runtime.preparedHeadSha,
      jjTreeId: runtime.jjTreeId,
      planSetHash: runtime.planSetHash,
      runtimeBehaviorContextHash: runtime.runtimeBehaviorContextHash,
      artifactDigest: runtime.artifactDigest,
      policy: runtime.policy,
      stage: this.kind,
      resolutionJobId: job.id,
      classification: "inconclusive",
      status: "running",
      ...(runtime.integrationNodeId === undefined ? {} : { integrationNodeId: runtime.integrationNodeId }),
    });

    let baseline: SymptomBaselineResult;
    try {
      baseline = await this.probe.runBaseline({
        orgId: job.orgId,
        projectId: job.projectId,
        contractId: contract.id,
        contract: contract.contract,
        verificationRunId,
      });
    } catch {
      return this.recordProbeFailure(job, contract, verificationRunId);
    }
    // Deliberately outside the probe catch: after a determined baseline outcome,
    // a finalize/transition failure must surface rather than reclassifying a real
    // product failure as infrastructure noise.
    return this.complete(job, contract, baseline);
  }

  private async recordProbeFailure(
    job: ResolutionJob,
    contract: SymptomContractRow,
    verificationRunId: string,
  ): Promise<ResolutionStageResult> {
    const failure: BaselineClassification = {
      outcome: "inconclusive",
      classification: "infra_failure",
      status: "failed",
      loopState: "awaiting_reproduction",
    };
    await this.finalizeVerificationRun({
      orgId: job.orgId,
      verificationRunId,
      resolutionJobId: job.id,
      classification: failure.classification,
      status: failure.status,
    });
    await this.transitionIssueLoop({
      orgId: job.orgId,
      projectId: job.projectId,
      issueLoopId: job.issueLoopId,
      state: "awaiting_reproduction",
    });
    return {
      ...failure,
      proofGrade: contract.proofPolicy,
      verificationRunId,
      assertionIds: [],
      evidenceRefs: [],
    };
  }

  private async complete(
    job: ResolutionJob,
    contract: SymptomContractRow,
    baseline: SymptomBaselineResult,
  ): Promise<ResolutionStageResult> {
    const classification = classifyBaseline(baseline);
    await this.finalizeVerificationRun({
      orgId: job.orgId,
      verificationRunId: baseline.verificationRunId,
      resolutionJobId: job.id,
      classification: classification.classification,
      status: classification.status,
    });
    if (classification.loopState !== undefined) {
      await this.transitionIssueLoop({
        orgId: job.orgId,
        projectId: job.projectId,
        issueLoopId: job.issueLoopId,
        state: classification.loopState,
      });
    }
    return {
      ...classification,
      proofGrade: contract.proofPolicy,
      verificationRunId: baseline.verificationRunId,
      assertionIds: [baseline.assertionId],
      evidenceRefs: baseline.evidence.map((evidence) => evidence.id),
    };
  }

  private async resolveRuntimeContext(
    ctx: unknown,
    job: ResolutionJob,
    contract: SymptomContractRow,
  ): Promise<BaselineReproductionContext> {
    if (ctx === undefined || ctx === null || (isRecord(ctx) && Object.keys(ctx).length === 0)) {
      return this.contextResolver.resolve({ job, contract });
    }
    return parseBaselineReproductionContext(ctx);
  }

  private async writeRunOnPool(input: WriteBehaviorVerificationRunStageInput): Promise<string> {
    return runWithOrgScope(this.dependencies.pool, input.orgId, (client) =>
      writeBehaviorVerificationRunStage(client, input),
    );
  }

  private async finalizeRunOnPool(input: FinalizeVerificationRunInput): Promise<void> {
    const rowCount = await finalizeBaselineVerificationRun(this.dependencies.pool, input);
    if (rowCount !== 1) throw new Error(`baseline verification run ${input.verificationRunId} was not finalized`);
  }

  private async transitionLoopOnPool(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly issueLoopId: string;
    readonly state: "awaiting_reproduction" | "reproduced";
  }): Promise<void> {
    await runWithOrgScope(this.dependencies.pool, input.orgId, async (client) => {
      const transitioned = await IssueLoopStore.transition(client, {
        orgId: input.orgId,
        projectId: input.projectId,
        issueLoopId: input.issueLoopId,
        toState: input.state,
      });
      if (transitioned === undefined) throw new Error(`baseline issue loop ${input.issueLoopId} was not found`);
    });
  }
}

/**
 * Update exactly the baseline verification row owned by this resolution job.
 *
 * Returning the row count keeps the production predicate directly testable by
 * both the SQL conformance fake and the restricted-role Postgres suite.
 */
export async function finalizeBaselineVerificationRun(
  pool: pg.Pool,
  input: FinalizeVerificationRunInput,
): Promise<number> {
  return runWithOrgScope(pool, input.orgId, async (client) => {
    const updated = await client.query(
      `UPDATE behavior_verification_runs
          SET classification = $3,
              status = $4
        WHERE org_id = $1
          AND id = $2
          AND stage = 'baseline'
          AND resolution_job_id = $5`,
      [input.orgId, input.verificationRunId, input.classification, input.status, input.resolutionJobId],
    );
    return updated.rowCount ?? 0;
  });
}

function classifyBaseline(baseline: SymptomBaselineResult): BaselineClassification {
  if (baseline.baselineOutcome === "reproduced") {
    return { outcome: "passed", classification: "product_failure", status: "completed", loopState: "reproduced" };
  }
  if (baseline.baselineOutcome === "not_reproduced") {
    return { outcome: "failed", classification: "stale_contract", status: "completed" };
  }
  return {
    outcome: "inconclusive",
    classification: "infra_failure",
    status: "failed",
    loopState: "awaiting_reproduction",
  };
}

class PgBaselineRuntimeContextResolver implements BaselineRuntimeContextResolver {
  public constructor(private readonly pool: pg.Pool) {}

  public async resolve(input: { readonly job: ResolutionJob; readonly contract: SymptomContractRow }) {
    return runWithOrgScope(this.pool, input.job.orgId, async (client) => {
      const result = await client.query<{
        environment_id: unknown;
        prepared_head_sha: unknown;
        jj_tree_id: unknown;
        artifact_digest: unknown;
        integration_node_id: unknown;
        release_instance_id: unknown;
      }>(
        `SELECT ve.id AS environment_id,
                inode.head_sha AS prepared_head_sha,
                inode.tree_hash AS jj_tree_id,
                ri.artifact_digest,
                ri.integration_node_id,
                ri.id AS release_instance_id
           FROM release_instances AS ri
           JOIN verification_environments AS ve
             ON ve.org_id = ri.org_id
            AND ve.project_id = ri.project_id
            AND ve.integration_node_id = ri.integration_node_id
            AND ve.artifact_digest = ri.artifact_digest
            AND ve.lifecycle_status = 'ready'
           JOIN integration_nodes AS inode
             ON inode.org_id = ri.org_id
            AND inode.project_id = ri.project_id
            AND inode.node_id = ri.integration_node_id
          WHERE ri.org_id = $1
            AND ri.project_id = $2
            AND ri.environment = 'production'
            AND ri.state = 'live'
            AND ($3::text IS NULL OR ri.id = $3)
          ORDER BY ri.created_at DESC, ri.id DESC
          LIMIT 1`,
        [input.job.orgId, input.job.projectId, input.job.releaseInstanceId ?? null],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error(`no current live release is available for baseline job ${input.job.id}`);
      const releaseInstanceId = requiredText(row.release_instance_id, "release_instance_id");
      return {
        environmentId: requiredText(row.environment_id, "environment_id"),
        preparedHeadSha: requiredText(row.prepared_head_sha, "prepared_head_sha"),
        jjTreeId: requiredText(row.jj_tree_id, "jj_tree_id"),
        planSetHash: input.contract.canonicalHash,
        runtimeBehaviorContextHash: runtimeContextHash({
          contractId: input.contract.id,
          releaseInstanceId,
          artifactDigest: requiredText(row.artifact_digest, "artifact_digest"),
        }),
        artifactDigest: requiredText(row.artifact_digest, "artifact_digest"),
        integrationNodeId: requiredText(row.integration_node_id, "integration_node_id"),
        policy: {
          proofPolicy: input.contract.proofPolicy,
          baselineRequired: input.contract.baselineRequired,
          releaseInstanceId,
        },
      } satisfies BaselineReproductionContext;
    });
  }
}

function parseBaselineReproductionContext(value: unknown): BaselineReproductionContext {
  if (!isRecord(value)) throw new TypeError("baseline reproduction context must be an object");
  const policy = value["policy"];
  if (!isRecord(policy)) throw new TypeError("baseline reproduction context policy must be an object");
  const verificationRunId = optionalText(value["verificationRunId"], "verificationRunId");
  const integrationNodeId = optionalText(value["integrationNodeId"], "integrationNodeId");
  return {
    ...(verificationRunId === undefined ? {} : { verificationRunId }),
    environmentId: requiredText(value["environmentId"], "environmentId"),
    preparedHeadSha: requiredText(value["preparedHeadSha"], "preparedHeadSha"),
    jjTreeId: requiredText(value["jjTreeId"], "jjTreeId"),
    planSetHash: requiredText(value["planSetHash"], "planSetHash"),
    runtimeBehaviorContextHash: requiredText(value["runtimeBehaviorContextHash"], "runtimeBehaviorContextHash"),
    artifactDigest: requiredText(value["artifactDigest"], "artifactDigest"),
    ...(integrationNodeId === undefined ? {} : { integrationNodeId }),
    policy,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`baseline ${field} must be a non-empty string`);
  return value;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, field);
}

function runtimeContextHash(value: Record<string, string>): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
