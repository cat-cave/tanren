// rv-23 — the strict, exact-status boundary client for the runtime-verification
// proof DASHBOARD surfaces. Every read demands HTTP 200 + an exact Zod decode +
// an org/project-id match; anything else collapses to `undefined`, so a view can
// never mistake an unavailable endpoint or a malformed body for a real (and
// implicitly green) proof. All endpoints are the org-scoped, read-only `/v1/orgs`
// surfaces (rv-23 for the 5 aggregate/governance surfaces, rv-22 for the two
// reused run-detail + behavior-history surfaces).

import {
  BehaviorProofMatrixSchema,
  BehaviorVerdictHistorySchema,
  DesignRenderListSchema,
  EffectCausalitySchema,
  FlakeQuarantineListSchema,
  RegressionBisectionListSchema,
  RunDetailSchema,
  type BehaviorProofMatrix,
  type BehaviorVerdictHistory,
  type DesignRenderList,
  type EffectCausality,
  type FlakeQuarantineList,
  type RegressionBisectionList,
  type RunDetail,
} from "./proofDashboard.js";
import { OrchestratorHttpClient } from "./httpClient.js";

function scope(orgId: string, projectId: string): string {
  return `/v1/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`;
}

export class ProofDashboardClient extends OrchestratorHttpClient {
  private async read<T extends { orgId: string; projectId: string }>(
    path: string,
    schema: { safeParse(raw: unknown): { success: true; data: T } | { success: false } },
    orgId: string,
    projectId: string,
  ): Promise<T | undefined> {
    const response = await this.fetchImpl(`${this.orchestratorUrl}${path}`, { headers: this.headers() }).catch(
      () => {},
    );
    if (response === undefined || response.status !== 200) return undefined;
    const raw: unknown = await response.json().catch(() => {});
    const parsed = schema.safeParse(raw);
    if (!parsed.success || parsed.data.orgId !== orgId || parsed.data.projectId !== projectId) return undefined;
    return parsed.data;
  }

  async getMatrix(orgId: string, projectId: string): Promise<BehaviorProofMatrix | undefined> {
    return this.read(`${scope(orgId, projectId)}/behavior-proof-matrix`, BehaviorProofMatrixSchema, orgId, projectId);
  }

  async getEffectCausality(orgId: string, projectId: string): Promise<EffectCausality | undefined> {
    return this.read(`${scope(orgId, projectId)}/effect-causality`, EffectCausalitySchema, orgId, projectId);
  }

  async getDesignRender(orgId: string, projectId: string): Promise<DesignRenderList | undefined> {
    return this.read(`${scope(orgId, projectId)}/design-render-verdicts`, DesignRenderListSchema, orgId, projectId);
  }

  async getBisections(orgId: string, projectId: string): Promise<RegressionBisectionList | undefined> {
    return this.read(
      `${scope(orgId, projectId)}/regression-bisections`,
      RegressionBisectionListSchema,
      orgId,
      projectId,
    );
  }

  async getQuarantines(orgId: string, projectId: string): Promise<FlakeQuarantineList | undefined> {
    return this.read(`${scope(orgId, projectId)}/flake-quarantines`, FlakeQuarantineListSchema, orgId, projectId);
  }

  /** rv-22 run detail — the assertion-timeline source. */
  async getRunDetail(orgId: string, projectId: string, runId: string): Promise<RunDetail | undefined> {
    return this.read(
      `${scope(orgId, projectId)}/verification-runs/${encodeURIComponent(runId)}`,
      RunDetailSchema,
      orgId,
      projectId,
    );
  }

  /** rv-22 behavior verdict history — the Behavior-detail source. */
  async getBehaviorHistory(
    orgId: string,
    projectId: string,
    behaviorRevisionId: string,
  ): Promise<BehaviorVerdictHistory | undefined> {
    return this.read(
      `${scope(orgId, projectId)}/behaviors/${encodeURIComponent(behaviorRevisionId)}/verdicts`,
      BehaviorVerdictHistorySchema,
      orgId,
      projectId,
    );
  }
}
