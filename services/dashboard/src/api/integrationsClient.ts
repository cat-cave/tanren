/**
 * Org integrations client. A STANDALONE client over the shared HTTP transport
 * (`OrchestratorHttpClient`) — not folded into the product `OrchestratorClient`
 * chain — so the integrations surface owns its own api module (the
 * screen-isolation lesson; `orchestrator.ts` is near the 500-line cap).
 *
 * Calls map 1:1 onto the orchestrator integration routes:
 *   list      → GET  /orgs/:orgId/integrations
 *   link      → POST /orgs/:orgId/integrations/:providerKind  (org-admin only)
 *   provision → POST /orgs/:orgId/projects/:projectId/integrations/provision
 *   discover  → GET  /orgs/:orgId/projects/:projectId/integrations/discover
 *
 * `not_linked` is a structured **200** — callers branch on `body.status`, never
 * on HTTP status alone. `list` yields `undefined` on read failure so the panel
 * degrades to "unavailable" (no fabricated empty).
 */

import { OrchestratorHttpClient } from "./httpClient.js";
import type {
  DiscoverOutcome,
  LinkOutcome,
  OrgIntegrationsList,
  ProvisionOutcome,
  SelectGrantOutcome,
} from "./integrations.js";

export class IntegrationsClient extends OrchestratorHttpClient {
  /** Org grants (Plane A). Undefined on network/HTTP failure — empty list is a real empty. */
  async list(orgId: string, projectId?: string): Promise<OrgIntegrationsList | undefined> {
    const query = projectId === undefined || projectId === "" ? "" : `?projectId=${encodeURIComponent(projectId)}`;
    return this.getJson<OrgIntegrationsList>(`/orgs/${encodeURIComponent(orgId)}/integrations${query}`);
  }

  /**
   * Link a provider at the org (Plane A write). Org-admin only on the server;
   * a non-admin gets 403. Token value is write-only — never echoed.
   */
  async link(
    orgId: string,
    providerKind: string,
    input: {
      token: string;
      upstreamAccountId: string;
      authKind: "api_key" | "oauth2" | "bot_token" | "webhook" | "workload_identity";
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ ok: boolean; status: number; body: LinkOutcome | undefined }> {
    const r = await this.sendJson<LinkOutcome>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(providerKind)}`,
      input,
    );
    return { ok: r.ok, status: r.status, body: r.body };
  }

  /**
   * Enable a capability for a project (Plane B). `not_linked` returns HTTP 200
   * with `body.status === "not_linked"` — treat as a structured outcome, not a
   * failure. Provisioned/bound land as 201.
   */
  async provision(
    orgId: string,
    projectId: string,
    input: {
      capability: string;
      providerKind?: string;
      mode: "greenfield" | "brownfield";
      chosenResourceId?: string;
      stack?: string;
      name?: string;
    },
  ): Promise<{ ok: boolean; status: number; body: ProvisionOutcome | undefined }> {
    const r = await this.sendJson<ProvisionOutcome>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/integrations/provision`,
      input,
    );
    return { ok: r.ok, status: r.status, body: r.body };
  }

  /** Persist the exact account/grant this project will use for one provider. */
  async selectGrant(
    orgId: string,
    projectId: string,
    providerKind: string,
    input: { connectionId: string; grantId: string },
  ): Promise<{ ok: boolean; status: number; body: SelectGrantOutcome | undefined }> {
    const r = await this.sendJson<SelectGrantOutcome>(
      "PUT",
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/integrations/${encodeURIComponent(providerKind)}/selection`,
      input,
    );
    return { ok: r.ok, status: r.status, body: r.body };
  }

  /**
   * Discover existing resources for a capability. `not_linked` is a 200 with
   * `body.status === "not_linked"` — branch on status, not HTTP code.
   */
  async discover(
    orgId: string,
    projectId: string,
    capability: string,
    providerKind?: string,
  ): Promise<DiscoverOutcome | undefined> {
    const qs = new URLSearchParams({ capability });
    if (providerKind !== undefined && providerKind !== "") {
      qs.set("providerKind", providerKind);
    }
    // getJson only returns on response.ok — and not_linked is 200, so it flows
    // through as a normal payload. Callers still branch on `status`.
    return this.getJson<DiscoverOutcome>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/integrations/discover?${qs.toString()}`,
    );
  }
}
