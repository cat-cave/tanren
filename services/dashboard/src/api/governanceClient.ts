/**
 * Canonical audit-posture client. This is a dashboard consumer only: reads and
 * writes map 1:1 to the existing org/project governance GET/PUT, with no local
 * store, generic project PATCH, or compatibility route.
 */

import { z } from "zod";
import { AuditPostureSchema, GovernanceViewSchema, type AuditPosture, type GovernanceView } from "./governance.js";
import { OrchestratorHttpClient } from "./httpClient.js";

const ErrorBodySchema = z.object({ error: z.string().optional() }).passthrough();

export type GovernanceReadResult =
  | { ok: true; status: number; body: GovernanceView }
  | { ok: false; status: number; failure: "unavailable" | "malformed" };

export type GovernanceWriteResult =
  | { ok: true; status: number; body: GovernanceView }
  | { ok: false; status: number; failure: "http" | "malformed"; error: string | undefined };

export class GovernanceClient extends OrchestratorHttpClient {
  async getProjectGovernance(orgId: string, projectId: string): Promise<GovernanceReadResult> {
    const result = await this.getJsonResponse<unknown>(governancePath(orgId, projectId));
    if (!result.ok) return { ok: false, status: result.status, failure: "unavailable" };
    const parsed = GovernanceViewSchema.safeParse(result.body);
    return parsed.success
      ? { ok: true, status: result.status, body: parsed.data }
      : { ok: false, status: result.status, failure: "malformed" };
  }

  async putAuditPosture(orgId: string, projectId: string, auditPosture: AuditPosture): Promise<GovernanceWriteResult> {
    const posture = AuditPostureSchema.parse(auditPosture);
    const result = await this.sendJson("PUT", governancePath(orgId, projectId), { auditPosture: posture });
    if (!result.ok) {
      const error = ErrorBodySchema.safeParse(result.body);
      return {
        ok: false,
        status: result.status,
        failure: "http",
        error: error.success ? error.data.error : undefined,
      };
    }
    const parsed = GovernanceViewSchema.safeParse(result.body);
    return parsed.success
      ? { ok: true, status: result.status, body: parsed.data }
      : {
          ok: false,
          status: result.status,
          failure: "malformed",
          error: "invalid_governance_response",
        };
  }
}

function governancePath(orgId: string, projectId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/governance`;
}
