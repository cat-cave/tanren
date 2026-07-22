import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type {
  ProductionResolutionStageResult,
  ResolutionJob,
  ResolutionStage,
  ResolutionStageResult,
} from "../../contracts/resolutionStage.js";
import { symptomContractHash, type SymptomContractV1 } from "../../contracts/symptomContract.js";
import { PgEventStore, type EventStore } from "../../eventStore.js";
import { HttpSymptomProbe } from "../../probes/httpSymptomProbe.js";
import { SymptomProbeAdapter } from "../../probes/symptomProbeAdapter.js";
import { ReleaseInstancesStore } from "../../repositories/releaseInstances.js";
import { SymptomContractStore, type SymptomContractRow } from "../../repositories/symptomContracts.js";
import {
  startBehaviorVerificationRunStage,
  type StartedBehaviorVerificationRunStage,
} from "../behaviorVerificationRunStage.js";
import { LockedBehaviorContextError, readRuntimeBehaviorContext } from "./resolutionBehaviorContext.js";

type QueryClient = Pick<pg.PoolClient, "query">;

interface RuntimeBindingRow {
  environment_id: unknown;
  jj_tree_id: unknown;
}

interface RuntimeBinding {
  readonly environmentId: string;
  readonly jjTreeId: string;
}

export class ProductionSymptomStageBindingError extends Error {
  public override readonly name = "ProductionSymptomStageBindingError";
}

export interface ProductionSymptomStageDeps {
  readonly pool: pg.Pool;
  readonly contracts?: Pick<SymptomContractStore, "get">;
  readonly probe?: Pick<SymptomProbeAdapter, "runVerification">;
  readonly eventsForClient?: (client: QueryClient) => EventStore;
}

/**
 * The post-deploy false-green catch. It binds the exact live release artifact
 * before running the locked contract's corrected observation against production.
 */
export class ProductionSymptomStage implements ResolutionStage {
  public readonly kind = "production" as const;
  private readonly contracts: Pick<SymptomContractStore, "get">;
  private readonly probe: Pick<SymptomProbeAdapter, "runVerification">;
  private readonly eventsForClient: (client: QueryClient) => EventStore;

  public constructor(private readonly deps: ProductionSymptomStageDeps) {
    this.contracts = deps.contracts ?? new SymptomContractStore(deps.pool);
    this.probe = deps.probe ?? new SymptomProbeAdapter(deps.pool, new HttpSymptomProbe());
    this.eventsForClient = deps.eventsForClient ?? ((client) => new PgEventStore(client));
  }

  public async run(job: ResolutionJob, ctx: unknown): Promise<ResolutionStageResult> {
    if (job.stage !== this.kind) {
      throw new ProductionSymptomStageBindingError(`production stage cannot run ${job.stage} job ${job.id}`);
    }
    // bh-15: the stage consumes ONLY the locked behavior-context digest — there is
    // no self-computed fallback. Fail closed FIRST, before any DB/probe work, so an
    // unlocked invocation never re-proves against an unbound/ad-hoc behavior identity.
    const locked = readRuntimeBehaviorContext(ctx);
    if (locked === undefined) {
      throw new LockedBehaviorContextError(
        "unlocked_context",
        `production stage ran without a locked behavior context for job ${job.id}`,
      );
    }
    const contextHash = locked.contextDigest;
    const contract = await this.requireContract(job);
    const { release, binding } = await this.requireLiveBinding(job);
    const productionContract = contractAtProductionRelease(contract.contract, release.url);
    const verificationRunId = `vrun_resolution_${job.id}`;
    const contractHash = symptomContractHash(contract.contract);

    const started = await runWithOrgScope(this.deps.pool, job.orgId, async (client) => {
      const receipt = await startBehaviorVerificationRunStage(client, {
        orgId: job.orgId,
        id: verificationRunId,
        projectId: job.projectId,
        purpose: "post_merge_production",
        environmentId: binding.environmentId,
        preparedHeadSha: release.sourceRef,
        jjTreeId: binding.jjTreeId,
        planSetHash: contractHash,
        runtimeBehaviorContextHash: contextHash,
        artifactDigest: release.artifactDigest,
        policy: {
          contractId: contract.id,
          contractHash,
          proofPolicy: contract.proofPolicy,
          releaseInstanceId: release.releaseInstanceId,
          artifactDigest: release.artifactDigest,
          productionUrl: productionContract.target["url"],
        },
        stage: this.kind,
        resolutionJobId: job.id,
        classification: "inconclusive",
      });
      if (!receipt.shouldRun) return receipt;
      const events = this.eventsForClient(client);
      await events.append({
        orgId: job.orgId,
        projectId: job.projectId,
        eventType: "deployment.artifact.bound",
        payload: {
          projectId: job.projectId,
          issueLoopId: job.issueLoopId,
          resolutionJobId: job.id,
          releaseInstanceId: release.releaseInstanceId,
          artifactDigest: release.artifactDigest,
        },
      });
      await events.append({
        orgId: job.orgId,
        projectId: job.projectId,
        eventType: "symptom.verification.started",
        payload: {
          projectId: job.projectId,
          issueLoopId: job.issueLoopId,
          resolutionJobId: job.id,
          contractId: contract.id,
          verificationRunId,
          stage: this.kind,
        },
      });
      return receipt;
    });
    if (!started.shouldRun) return recordedProductionResult(contract, started);

    const probeResult = await this.probe.runVerification({
      orgId: job.orgId,
      projectId: job.projectId,
      contractId: contract.id,
      contract: productionContract,
      verificationRunId,
      expectedObservation: contract.contract.expectedCorrectedObservation,
    });
    const result = resultForProbe(contract, probeResult);

    await runWithOrgScope(this.deps.pool, job.orgId, async (client) => {
      const updated = await client.query(
        `UPDATE behavior_verification_runs
            SET status = $4, classification = $5
          WHERE org_id = $1 AND id = $2 AND resolution_job_id = $3 AND stage = 'production'`,
        [
          job.orgId,
          started.id,
          job.id,
          result.outcome === "inconclusive" ? "failed" : "completed",
          result.classification,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new Error(`production verification run ${started.id} was not available to finalize`);
      }
      await this.appendFinalEvent(this.eventsForClient(client), job, result);
    });
    return result;
  }

  private async requireContract(job: ResolutionJob): Promise<SymptomContractRow> {
    const contract = await this.contracts.get(job.orgId, job.contractId);
    if (contract === undefined)
      throw new ProductionSymptomStageBindingError(`symptom contract ${job.contractId} not found`);
    if (contract.projectId !== job.projectId || contract.issueLoopId !== job.issueLoopId) {
      throw new ProductionSymptomStageBindingError(
        "production verification job does not match its locked symptom contract",
      );
    }
    return contract;
  }

  private async requireLiveBinding(job: ResolutionJob) {
    const releaseInstanceId = job.releaseInstanceId;
    if (releaseInstanceId === undefined) {
      throw new ProductionSymptomStageBindingError("production verification requires a release instance binding");
    }
    return runWithOrgScope(this.deps.pool, job.orgId, async (client) => {
      const release = await ReleaseInstancesStore.getById(client, job.orgId, releaseInstanceId);
      if (release === undefined) throw new ProductionSymptomStageBindingError(`release ${releaseInstanceId} not found`);
      if (release.projectId !== job.projectId || release.environment !== "production" || release.state !== "live") {
        throw new ProductionSymptomStageBindingError(
          "production verification requires the named live production release",
        );
      }
      if (release.url.length === 0) {
        throw new ProductionSymptomStageBindingError("production verification requires the live release URL");
      }
      const binding = await runtimeBinding(client, job, release.artifactDigest, release.integrationNodeId);
      return { release, binding };
    });
  }

  private async appendFinalEvent(
    events: EventStore,
    job: ResolutionJob,
    result: ProductionResolutionStageResult,
  ): Promise<void> {
    const payload = {
      projectId: job.projectId,
      issueLoopId: job.issueLoopId,
      resolutionJobId: job.id,
      verificationRunId: result.verificationRunId,
      assertionIds: result.assertionIds,
      evidenceRefs: result.evidenceRefs,
    };
    if (result.outcome === "passed") {
      await events.append({
        orgId: job.orgId,
        projectId: job.projectId,
        eventType: "symptom.verification.passed",
        payload: { ...payload, classification: result.classification },
      });
      return;
    }
    if (result.outcome === "failed") {
      await events.append({
        orgId: job.orgId,
        projectId: job.projectId,
        eventType: "symptom.verification.failed",
        payload: { ...payload, outcome: "failed", classification: result.classification },
      });
      return;
    }
    await events.append({
      orgId: job.orgId,
      projectId: job.projectId,
      eventType: "symptom.verification.inconclusive",
      payload: { ...payload, outcome: "inconclusive", classification: result.classification },
    });
  }
}

function recordedProductionResult(
  contract: SymptomContractRow,
  started: StartedBehaviorVerificationRunStage,
): ProductionResolutionStageResult {
  const shared = {
    proofGrade: contract.proofPolicy,
    verificationRunId: started.id,
    assertionIds: [],
    evidenceRefs: [],
  };
  if (started.classification === "product_resolved") {
    return { ...shared, outcome: "passed", classification: "product_resolved" };
  }
  if (started.classification === "product_failure") {
    return { ...shared, outcome: "failed", classification: "product_failure" };
  }
  if (started.classification === "inconclusive" || started.classification === "infra_failure") {
    return { ...shared, outcome: "inconclusive", classification: started.classification };
  }
  throw new Error(`production receipt ${started.id} has incompatible classification ${started.classification}`);
}

async function runtimeBinding(
  client: QueryClient,
  job: ResolutionJob,
  artifactDigest: string,
  integrationNodeId: string,
): Promise<RuntimeBinding> {
  const result = await client.query<RuntimeBindingRow>(
    `SELECT environment.id AS environment_id,
            node.tree_hash AS jj_tree_id
       FROM verification_environments AS environment
       JOIN integration_nodes AS node ON node.node_id = environment.integration_node_id
      WHERE environment.org_id = $1
        AND environment.project_id = $2
        AND environment.integration_node_id = $3
        AND environment.artifact_digest = $4
        AND environment.deployment_target = 'production'
        AND environment.lifecycle_status = 'ready'
      ORDER BY environment.id ASC
      LIMIT 1`,
    [job.orgId, job.projectId, integrationNodeId, artifactDigest],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ProductionSymptomStageBindingError("no ready runtime verification environment matches the live artifact");
  }
  return {
    environmentId: nonemptyText(row.environment_id, "verification environment id"),
    jjTreeId: nonemptyText(row.jj_tree_id, "integration node tree hash"),
  };
}

function resultForProbe(
  contract: SymptomContractRow,
  probe: Awaited<ReturnType<SymptomProbeAdapter["runVerification"]>>,
): ProductionResolutionStageResult {
  const shared = {
    proofGrade: contract.proofPolicy,
    verificationRunId: probe.verificationRunId,
    assertionIds: [probe.assertionId],
    evidenceRefs: probe.evidence.map((item) => item.id),
  };
  switch (probe.outcome) {
    case "passed":
      return { ...shared, outcome: "passed", classification: "product_resolved" };
    case "failed":
      return { ...shared, outcome: "failed", classification: "product_failure" };
    case "inconclusive":
      return { ...shared, outcome: "inconclusive", classification: "inconclusive" };
  }
  throw new Error(`unsupported symptom probe outcome: ${String(probe.outcome)}`);
}

/**
 * The stored symptom contract identifies the behavior, not the deployment to
 * probe. Production verification keeps its request shape but replaces its host
 * with the URL of the exact release row whose digest was bound above.
 */
function contractAtProductionRelease(contract: SymptomContractV1, releaseUrl: string): SymptomContractV1 {
  let productionUrl: URL;
  try {
    productionUrl = new URL(releaseUrl);
  } catch {
    throw new ProductionSymptomStageBindingError("live production release URL is invalid");
  }
  const configuredPath = pathFromTarget(contract.target);
  const target = {
    ...contract.target,
    url: new URL(configuredPath, productionUrl).toString(),
  };
  return { ...contract, target };
}

function pathFromTarget(target: SymptomContractV1["target"]): string {
  if (typeof target["path"] === "string") return target["path"];
  if (typeof target["url"] !== "string") return "";
  try {
    const configuredUrl = new URL(target["url"]);
    return `${configuredUrl.pathname}${configuredUrl.search}`;
  } catch {
    throw new ProductionSymptomStageBindingError("HTTP symptom target URL is invalid");
  }
}

function nonemptyText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ProductionSymptomStageBindingError(`invalid ${field}`);
  return value;
}
