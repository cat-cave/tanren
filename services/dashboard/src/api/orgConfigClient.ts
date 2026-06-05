/**
 * org-config client surface, split out of `orchestrator.ts` so the
 * product client stays under the 500-line architecture cap (same split
 * rationale as `recoveryClient.ts` / `forgeConversationClient.ts`). Lands on
 * `OrchestratorClient` via inheritance.
 *
 * Reads the org's merged config (`GET /orgs/:orgId`) and persists it
 * (`PATCH /orgs/:orgId`). When the audit gate is ON and the change is Bucket-B,
 * the orchestrator returns 202 with `{ gated, pr }` instead of applying — that
 * is surfaced here as `gated: true` plus the opened PR ref.
 */

import { OrchestratorForgeConversationClient } from "./forgeConversationClient.js";
import type { OrgConfig, OrgDetail } from "./orgConfigTypes.js";

export interface PatchOrgConfigResult {
  ok: boolean;
  status: number;
  /** True when the write was routed through the audit gate (202, PR opened). */
  gated: boolean;
  pr?: { number: number; url: string };
}

export abstract class OrchestratorOrgConfigClient extends OrchestratorForgeConversationClient {
  /** Org with its merged config (`GET /orgs/:orgId`). */
  async getOrg(orgId: string): Promise<OrgDetail | undefined> {
    return this.getJson<OrgDetail>(`/orgs/${encodeURIComponent(orgId)}`);
  }

  /** Persist org config (PATCH); reports a gated outcome. */
  async patchOrgConfig(orgId: string, config: OrgConfig): Promise<PatchOrgConfigResult> {
    const result = await this.sendJson<{ gated?: boolean; pr?: { number: number; url: string } }>(
      "PATCH",
      `/orgs/${encodeURIComponent(orgId)}`,
      { config },
    );
    return {
      ok: result.ok,
      status: result.status,
      gated: result.body?.gated === true,
      pr: result.body?.pr,
    };
  }
}
