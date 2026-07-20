import type { StagedEagerBeamPlan } from "./eagerBeamPlanStager.js";
import type { EagerBeamCandidate, PgEagerBeamStore } from "./eagerBeamStore.js";
import type {
  IntegrationNodeMaterializationPersistence,
  MaterializationFailureRecord,
  MaterializedIntegrationNodeRecord,
} from "./integrationNodeMaterializer.js";

/** Atomically attaches the pre-frozen EAGER plan to materialized-node persistence. */
export class EagerBeamMaterializationPersistence implements IntegrationNodeMaterializationPersistence {
  public constructor(
    private readonly beams: PgEagerBeamStore,
    private readonly candidate: EagerBeamCandidate,
    private readonly rank: number,
    private readonly staged: () => StagedEagerBeamPlan | undefined,
  ) {}

  public async persistMaterialized(record: MaterializedIntegrationNodeRecord): Promise<string> {
    const plan = this.staged();
    if (plan === undefined) throw new Error("eager beam materialization missing a frozen plan");
    const persisted = await this.beams.persistMaterialized({ record, plan: plan.plan, planDigest: plan.planDigest });
    return persisted.nodeId;
  }

  public async recordMaterializationFailure(input: MaterializationFailureRecord): Promise<void> {
    await this.beams.hold({
      orgId: input.orgId,
      projectId: input.projectId,
      frontierRunId: this.candidate.runId,
      frontierSpecId: this.candidate.specId,
      rank: this.rank,
      reason: input.failureCode,
    });
    await this.beams.recordMaterializationFailure(input);
  }
}
