/**
 * spec-discovery client. A STANDALONE client over the shared HTTP
 * transport (`OrchestratorHttpClient`) — not folded into the product
 * `OrchestratorClient` inheritance chain — so the discovery surface owns its
 * own api module per the screen-isolation lesson (parallel client-touching
 * screens diverge when they all extend the same client). The discovery route
 * instantiates it directly with the forwarded cookie header.
 *
 * Two calls map 1:1 onto the orchestrator discovery routes:
 *   classify → POST /orgs/:orgId/projects/:projectId/discovery/classify
 *   accept   → POST /orgs/:orgId/projects/:projectId/discovery/accept
 */

import { OrchestratorHttpClient } from "./httpClient.js";
import type { AcceptResult, DiscoveryInsight, DiscoveryResult, PlacementKind, ProposedSpec } from "./discoveryTypes.js";
import { AcceptResultSchema, decodeWith, DiscoveryResultSchema } from "./writeResponseSchemas.js";

export class DiscoveryClient extends OrchestratorHttpClient {
  /** Classify an insight into proposed specs + placement options. */
  async classify(
    orgId: string,
    projectId: string,
    insight: DiscoveryInsight,
  ): Promise<{ ok: boolean; status: number; result: DiscoveryResult | undefined }> {
    const r = await this.sendJson<DiscoveryResult>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/discovery/classify`,
      insight,
      { expectBody: true, decode: (value) => decodeWith(DiscoveryResultSchema, value) },
    );
    return { ok: r.ok, status: r.status, result: r.ok ? r.body : undefined };
  }

  /** Accept proposals: create specs + persist provenance at the chosen placement. */
  async accept(
    orgId: string,
    projectId: string,
    input: {
      insight: DiscoveryInsight;
      proposals: ProposedSpec[];
      placementKind: PlacementKind;
      placementLabel: string;
    },
  ): Promise<{ ok: boolean; status: number; result: AcceptResult | undefined }> {
    const r = await this.sendJson<AcceptResult>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/discovery/accept`,
      input,
      { expectBody: true, decode: (value) => decodeWith(AcceptResultSchema, value) },
    );
    return { ok: r.ok, status: r.status, result: r.ok ? r.body : undefined };
  }
}
