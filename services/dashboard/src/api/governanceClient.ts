/**
 * Canonical audit-posture client. This is a dashboard consumer only: reads and
 * writes map 1:1 to the existing org/project governance GET/PUT, with no local
 * store, generic project PATCH, or compatibility route.
 */

import { z } from "zod";
import { AuditPostureSchema, parseGovernanceView, type AuditPosture, type GovernanceView } from "./governance.js";
import { OrchestratorHttpClient } from "./httpClient.js";

const ErrorBodySchema = z.object({ error: z.string().optional() }).passthrough();

export type GovernanceWriteResult =
  | { ok: true; status: number; body: GovernanceView }
  | { ok: false; status: number; error: string | undefined };

export class GovernanceClient extends OrchestratorHttpClient {
  async getProjectGovernance(orgId: string, projectId: string): Promise<GovernanceView | undefined> {
    const value = await this.getJson<unknown>(governancePath(orgId, projectId));
    return value === undefined ? undefined : parseGovernanceView(value);
  }

  async putAuditPosture(orgId: string, projectId: string, auditPosture: AuditPosture): Promise<GovernanceWriteResult> {
    const posture = AuditPostureSchema.parse(auditPosture);
    const result = await this.sendJson("PUT", governancePath(orgId, projectId), { auditPosture: posture });
    if (!result.ok) {
      const error = ErrorBodySchema.safeParse(result.body);
      return {
        ok: false,
        status: result.status,
        error: error.success ? error.data.error : undefined,
      };
    }
    return { ok: true, status: result.status, body: parseGovernanceView(result.body) };
  }
}

function governancePath(orgId: string, projectId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/governance`;
}
