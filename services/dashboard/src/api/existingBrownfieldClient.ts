/**
 * P3-0016 brownfield full-track client. A STANDALONE client over the shared
 * HTTP transport (`OrchestratorHttpClient`) — not folded into the product
 * `OrchestratorClient` chain — so the brownfield full-track surface owns its
 * own api module (the P3-0014/0015 isolation lesson). Four calls map 1:1 onto
 * the orchestrator brownfield full-track routes:
 *   recon           → POST .../recon
 *   configInjection → POST .../config-injection
 *   seedDag         → POST .../seed-dag
 *   governance      → POST .../governance
 */

import { OrchestratorHttpClient } from "./httpClient.js";
import type {
  ConfigInjectionResult,
  GovernancePosture,
  GovernanceResult,
  ReconReport,
  ReconResult,
  SeedDagResult
} from "./existingBrownfieldTypes.js";

function projectBase(orgId: string, projectId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`;
}

export class ExistingBrownfieldClient extends OrchestratorHttpClient {
  /** Read-only recon: index the linked repo + pre-fill chapters/gaps. */
  async recon(
    orgId: string,
    projectId: string,
    repoUrl: string
  ): Promise<{ ok: boolean; status: number; result: ReconResult | undefined }> {
    const r = await this.sendJson<ReconResult>("POST", `${projectBase(orgId, projectId)}/recon`, { repoUrl });
    return { ok: r.ok, status: r.status, result: r.body };
  }

  /** Open the config-injection PR with the kept files (excludePaths removed). */
  async configInjection(
    orgId: string,
    projectId: string,
    input: { repoUrl: string; baseBranch: string; report: ReconReport; posture: GovernancePosture; excludePaths: string[] }
  ): Promise<{ ok: boolean; status: number; result: ConfigInjectionResult | undefined; error?: string }> {
    const r = await this.sendJson<ConfigInjectionResult>("POST", `${projectBase(orgId, projectId)}/config-injection`, input);
    if (!r.ok) {
      const body = r.body as { error?: string; message?: string } | undefined;
      return { ok: false, status: r.status, result: undefined, error: body?.message ?? body?.error };
    }
    return { ok: true, status: r.status, result: r.body };
  }

  /** Seed the DAG from recon gaps + GitHub issues. */
  async seedDag(
    orgId: string,
    projectId: string,
    input: { repoUrl: string; report: ReconReport; includeIssues: boolean }
  ): Promise<{ ok: boolean; status: number; result: SeedDagResult | undefined }> {
    const r = await this.sendJson<SeedDagResult>("POST", `${projectBase(orgId, projectId)}/seed-dag`, input);
    return { ok: r.ok, status: r.status, result: r.body };
  }

  /** Persist the chosen governance posture (P3-0023). */
  async governance(
    orgId: string,
    projectId: string,
    posture: GovernancePosture
  ): Promise<{ ok: boolean; status: number; result: GovernanceResult | undefined }> {
    const r = await this.sendJson<GovernanceResult>("POST", `${projectBase(orgId, projectId)}/governance`, { posture });
    return { ok: r.ok, status: r.status, result: r.body };
  }
}
