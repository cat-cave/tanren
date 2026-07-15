/**
 * scheduled-audits client. A STANDALONE client over the shared HTTP
 * transport (`OrchestratorHttpClient`) — not folded into the product
 * `OrchestratorClient` chain — so the audits surface owns its own api module per
 * the screen-isolation lesson. The audits route instantiates it directly with
 * the forwarded cookie header.
 *
 * Calls map 1:1 onto the orchestrator audit routes:
 *   snapshot   → GET  /orgs/:orgId/audits
 *   create     → POST /orgs/:orgId/audits
 *   enable     → POST /orgs/:orgId/audits/:jobId/enable
 *   disable    → POST /orgs/:orgId/audits/:jobId/disable
 *   run        → POST /orgs/:orgId/audits/:jobId/run
 */

import { OrchestratorHttpClient } from "./httpClient.js";
import type { AuditJob, AuditsSnapshot, CreateAuditJobInput } from "./auditsTypes.js";
import { AuditJobResponseSchema, decodeWith } from "./writeResponseSchemas.js";

export class AuditsClient extends OrchestratorHttpClient {
  private base(orgId: string): string {
    return `/orgs/${encodeURIComponent(orgId)}/audits`;
  }

  /** The audit-job library + the forge-recommended coverage gaps. */
  async snapshot(orgId: string): Promise<AuditsSnapshot | undefined> {
    return this.getJson<AuditsSnapshot>(this.base(orgId));
  }

  /** Create an audit job (the composer / a recommended-gap one-click schedule). */
  async create(orgId: string, input: CreateAuditJobInput): Promise<{ ok: boolean; job?: AuditJob }> {
    const r = await this.sendJson<{ job: AuditJob }>("POST", this.base(orgId), input, {
      expectBody: true,
      decode: (value) => decodeWith(AuditJobResponseSchema, value),
    });
    return { ok: r.ok, ...(!r.ok || r.body?.job === undefined ? {} : { job: r.body.job }) };
  }

  /** Enable / disable — the per-job toggle. */
  async setEnabled(orgId: string, jobId: string, enabled: boolean): Promise<{ ok: boolean; job?: AuditJob }> {
    const verb = enabled ? "enable" : "disable";
    const r = await this.sendJson<{ job: AuditJob }>(
      "POST",
      `${this.base(orgId)}/${encodeURIComponent(jobId)}/${verb}`,
      undefined,
      { expectBody: true, decode: (value) => decodeWith(AuditJobResponseSchema, value) },
    );
    return { ok: r.ok, ...(!r.ok || r.body?.job === undefined ? {} : { job: r.body.job }) };
  }

  /** Run the read-only pass now → findings auto-route into the candidate inbox. */
  async run(orgId: string, jobId: string): Promise<{ ok: boolean }> {
    const r = await this.sendJson("POST", `${this.base(orgId)}/${encodeURIComponent(jobId)}/run`);
    return { ok: r.ok };
  }
}
