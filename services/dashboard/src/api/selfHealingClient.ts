/**
 * bh-14b — the strict boundary client for the Self-Healing surface. Reads the
 * org-scoped funnel and the bh-14a sealed-proof chain for a loop; both are pure
 * GETs against the orchestrator's real org-scoped surfaces. Malformed / absent /
 * mis-scoped responses degrade to `undefined` so the screen renders an honest
 * empty state rather than throwing.
 */

import { OrchestratorHttpClient } from "./httpClient.js";
import {
  LoopProofResponseSchema,
  SelfHealingFunnelSchema,
  type LoopProofResponse,
  type SelfHealingFunnel,
} from "./selfHealing.js";

export class SelfHealingClient extends OrchestratorHttpClient {
  async getFunnel(orgId: string): Promise<SelfHealingFunnel | undefined> {
    const path = `/v1/orgs/${encodeURIComponent(orgId)}/self-healing/funnel`;
    const response = await this.fetchImpl(`${this.orchestratorUrl}${path}`, {
      headers: this.headers(),
    }).catch(() => {});
    if (response === undefined || response.status !== 200) return undefined;
    const raw: unknown = await response.json().catch(() => {});
    const parsed = SelfHealingFunnelSchema.safeParse(raw);
    if (!parsed.success || parsed.data.orgId !== orgId) return undefined;
    return parsed.data;
  }

  async getLoopProof(orgId: string, projectId: string, loopId: string): Promise<LoopProofResponse | undefined> {
    const path =
      `/v1/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}` +
      `/issue-loops/${encodeURIComponent(loopId)}/proof`;
    const response = await this.fetchImpl(`${this.orchestratorUrl}${path}`, {
      headers: this.headers(),
    }).catch(() => {});
    if (response === undefined || response.status !== 200) return undefined;
    const raw: unknown = await response.json().catch(() => {});
    const parsed = LoopProofResponseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.orgId !== orgId || parsed.data.loopId !== loopId) return undefined;
    return parsed.data;
  }
}
