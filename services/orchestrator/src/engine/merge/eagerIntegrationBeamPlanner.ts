// mq-8 production EAGER beam planner. It prepares exact jj-local integrations
// before their dependency bases are merge-ready; it cannot call merge authority or
// mutate queue state, and a failed preparation is retained as held/stale evidence.

import { createHash } from "node:crypto";
import { buildLiveJjWorkspace } from "../providers/liveJjWorkspace.js";
import { createLogger } from "../observability/logger.js";
import { EagerBeamFactsResolver } from "./eagerBeamFacts.js";
import { EagerBeamMaterializationPersistence } from "./eagerBeamMaterializationPersistence.js";
import { EagerBeamPlanStager, type StagedEagerBeamPlan } from "./eagerBeamPlanStager.js";
import { type EagerBeamCandidate, type EagerBeamProject, PgEagerBeamStore } from "./eagerBeamStore.js";
import { IntegrationNodeMaterializer } from "./integrationNodeMaterializer.js";
import type { EagerBeamRuntimeDeps } from "./eagerBeamRuntime.js";

const log = createLogger("eager-integration-beam");
/** Resource bound only: normal merge-queue processing remains unbounded by this advisory beam. */
export const DEFAULT_EAGER_BEAM_WIDTH = 3;

export interface EagerIntegrationBeamPlannerDeps extends EagerBeamRuntimeDeps {
  readonly beamWidth?: number;
}

/** The one production entrypoint used by BatchMergeCoordinator.coordinate(). */
export class EagerIntegrationBeamPlanner {
  private readonly beams: PgEagerBeamStore;
  private readonly facts: EagerBeamFactsResolver;
  private readonly stager: EagerBeamPlanStager;
  private readonly beamWidth: number;

  public constructor(private readonly deps: EagerIntegrationBeamPlannerDeps) {
    this.beams = new PgEagerBeamStore(deps.pool);
    this.facts = new EagerBeamFactsResolver(deps);
    this.stager = new EagerBeamPlanStager(deps);
    this.beamWidth = assertBeamWidth(deps.beamWidth ?? DEFAULT_EAGER_BEAM_WIDTH);
  }

  public async planAndBuild(projectId: string): Promise<void> {
    try {
      const project = await this.beams.loadProject(projectId);
      if (project === undefined) return;
      const candidates = await this.beams.loadCandidates(project);
      const selected = selectEagerBeamCandidates(candidates, this.beamWidth);
      for (let index = 0; index < selected.length; index += 1) {
        const candidate = selected[index];
        if (candidate === undefined) continue;
        await this.buildOne(project, candidate, index + 1);
      }
    } catch (error) {
      // Beam work is advisory. An unobservable project-wide read must never fake a
      // prepared result or become a second merge gate; the normal coordinator keeps
      // its independent, authority-owned path.
      log.error("eager beam planning unavailable; no speculative result admitted", { projectId }, error);
    }
  }

  private async buildOne(project: EagerBeamProject, candidate: EagerBeamCandidate, rank: number): Promise<void> {
    try {
      const resolution = await this.facts.resolve(project, candidate);
      if (resolution.kind === "held") {
        await this.hold(project, candidate, rank, resolution.reason);
        return;
      }
      const { facts } = resolution;
      const live = await buildLiveJjWorkspace({
        facts: {
          orgId: project.orgId,
          projectId: project.projectId,
          repoUrl: facts.repoUrl,
          runnerImage: facts.runnerImage,
          ...(facts.installation === undefined ? {} : { installation: facts.installation }),
          githubCredentialRef: facts.staticRef ?? "",
          identitySecretRef: this.deps.identitySecretRef,
        },
        allocator: this.deps.allocator,
        ssh: this.deps.ssh,
        secrets: this.deps.secrets,
        githubHttp: this.deps.githubHttp,
        ...(this.deps.githubAppMinter === undefined ? {} : { githubAppMinter: this.deps.githubAppMinter }),
      });
      try {
        let staged: StagedEagerBeamPlan | undefined;
        const materializer = new IntegrationNodeMaterializer(
          live.core,
          new EagerBeamMaterializationPersistence(this.beams, candidate, rank, () => staged),
        );
        const materialized = await materializer.materialize({
          orgId: project.orgId,
          projectId: project.projectId,
          repoUrl: facts.repoUrl,
          baseBranch: facts.baseBranch,
          baseSha: facts.baseSha,
          members: facts.members,
          localRef: eagerLocalRef(candidate.runId),
          workspacePath: live.workspacePath,
          purpose: "eager_beam",
          beforePersist: async () => {
            staged = await this.stager.stage({
              beamWidth: this.beamWidth,
              rank,
              orgId: project.orgId,
              projectId: project.projectId,
              frontierRunId: candidate.runId,
              frontierSpecId: candidate.specId,
              facts,
              gateInput: { target: live.target, workspacePath: live.workspacePath },
            });
            return {
              gateConfigHash: staged.proofReuseInput.gateConfigHash,
              policyVersion: staged.proofReuseInput.policyVersion,
            };
          },
        });
        if (materialized.kind === "failed") return;
        const plan = staged;
        if (plan === undefined) throw new Error("eager materialization completed without a frozen plan");
        await this.stager.evaluateMaterialization({
          orgId: project.orgId,
          projectId: project.projectId,
          nodeId: materialized.nodeId,
          staged: plan,
        });
        await this.beams.markReady({
          orgId: project.orgId,
          projectId: project.projectId,
          planDigest: plan.planDigest,
          nodeId: materialized.nodeId,
        });
      } finally {
        await live.release();
      }
    } catch (error) {
      const reason = stableFailureReason(error);
      await this.beams
        .hold({
          orgId: project.orgId,
          projectId: project.projectId,
          frontierRunId: candidate.runId,
          frontierSpecId: candidate.specId,
          rank,
          reason,
        })
        .catch((holdError: unknown) =>
          log.error("failed to record eager beam hold", { projectId: project.projectId }, holdError),
        );
      log.warn(
        "eager beam held; normal merge queue remains authoritative",
        { projectId: project.projectId, reason },
        error,
      );
    }
  }

  private async hold(
    project: EagerBeamProject,
    candidate: EagerBeamCandidate,
    rank: number,
    reason: string,
  ): Promise<void> {
    await this.beams.hold({
      orgId: project.orgId,
      projectId: project.projectId,
      frontierRunId: candidate.runId,
      frontierSpecId: candidate.specId,
      rank,
      reason,
    });
  }
}

export function buildEagerIntegrationBeamPlanner(deps: EagerIntegrationBeamPlannerDeps): EagerIntegrationBeamPlanner {
  return new EagerIntegrationBeamPlanner(deps);
}

/** Pure deterministic top-K selection; a resource bound, never an eligibility gate. */
export function selectEagerBeamCandidates<T extends EagerBeamCandidate>(
  candidates: ReadonlyArray<T>,
  beamWidth: number,
): T[] {
  const width = assertBeamWidth(beamWidth);
  return [...candidates]
    .sort((left, right) => {
      const byPriority = priorityRank(left.priority) - priorityRank(right.priority);
      if (byPriority !== 0) return byPriority;
      const byCreated = creationKey(left.createdAt).localeCompare(creationKey(right.createdAt));
      if (byCreated !== 0) return byCreated;
      const bySpec = left.specId.localeCompare(right.specId);
      return bySpec === 0 ? left.runId.localeCompare(right.runId) : bySpec;
    })
    .slice(0, width);
}

function eagerLocalRef(runId: string): string {
  return `tanren-local-eager-${createHash("sha256").update(runId).digest("hex").slice(0, 20)}`;
}

function assertBeamWidth(value: number): number {
  if (!Number.isInteger(value) || value < 1)
    throw new RangeError(`eager beam width must be a positive integer, got ${value}`);
  return value;
}

function priorityRank(value: unknown): number {
  if (value === "P0") return 0;
  if (value === "P1") return 1;
  if (value === "P2") return 2;
  if (value === "tbd") return 3;
  throw new Error("eager beam candidate has an invalid priority");
}

function creationKey(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString();
  if (typeof value === "string" && value.trim() !== "") return value;
  throw new Error("eager beam candidate has an invalid creation order");
}

function stableFailureReason(error: unknown): string {
  if (error instanceof Error && error.message.includes("ancestor_stack")) return "malformed_ancestor_stack";
  if (error instanceof Error && error.message.includes("unresolved")) return "proof_identity_unresolved";
  return "materialization_held";
}
