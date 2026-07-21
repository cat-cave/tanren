// in-21 — typed, status-preserving client for in-20's GET-only integration read
// surface. Mirrors `governanceStudioClient.ts`'s status-preserving pattern:
// every read returns an `IntegrationReadResult<T>` so the UI can distinguish a
// legitimate empty (200 with `[]` rows) from an unavailable (network / non-200)
// or malformed (transport garble / scope mismatch) read — never fabricating a
// success panel from an unconfirmable state.
//
// Mounted on the orchestrator's `/v1/orgs/...` prefix; org+project-RLS guards
// live on the orchestrator side (each route runs `actorCanAccessOrg` +
// `assertProjectAccess` inside `runWithOrgScope`), so a cross-org caller gets
// 403 → this client surfaces `{ ok: false, failure: "unavailable", status: 403 }`
// → the UI renders the unavailable state. No client-side scope bypass is
// possible.

import { OrchestratorHttpClient } from "./httpClient.js";
import {
  decodeIntegrationReadResponse,
  type BaseIntegrationReadResponse,
  type CapabilityNodesResponse,
  type DeliveryDagStatusResponse,
  type IntegrationBindingsResponse,
  type IntegrationLifecycleInventoryResponse,
  type IntegrationReadResult,
  type IntegrationRequirementsResponse,
} from "./integrationReads.js";

/** Path prefix for the in-20 surface. */
function scopePath(orgId: string, projectId: string): string {
  return `/v1/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`;
}

/** Read-only, org+project-scoped client for the in-20 integration HTTP surface. */
export class IntegrationReadsClient extends OrchestratorHttpClient {
  /**
   * Wraps the underlying status-aware GET with the shallow shape check. The
   * check defends against transport garble and a leaky orchestrator returning
   * data for a different org/project than the caller requested: the version
   * tag must be the frozen `v1` AND `orgId`/`projectId` must match what the
   * caller asked for, else the response is rejected as malformed (the UI
   * surfaces an honest failure, never a fabricated success).
   */
  private async readScoped<T extends BaseIntegrationReadResponse>(
    path: string,
    expectedOrgId: string,
    expectedProjectId: string,
  ): Promise<IntegrationReadResult<T>> {
    const response = await this.getJsonResponse<unknown>(path);
    if (!response.ok) return { ok: false, failure: "unavailable", status: response.status };
    const checked = decodeIntegrationReadResponse<T>(response.body, expectedOrgId, expectedProjectId);
    if (!checked.ok) return { ok: false, failure: "malformed", status: response.status };
    return { ok: true, data: checked.data };
  }

  /** GET .../integrations/lifecycle — the in-3 inventory rollup, first-class. */
  async readLifecycle(
    orgId: string,
    projectId: string,
  ): Promise<IntegrationReadResult<IntegrationLifecycleInventoryResponse>> {
    return this.readScoped<IntegrationLifecycleInventoryResponse>(
      `${scopePath(orgId, projectId)}/integrations/lifecycle`,
      orgId,
      projectId,
    );
  }

  /** GET .../integration-requirements — the project's requirement lifecycle rows. */
  async listRequirements(
    orgId: string,
    projectId: string,
  ): Promise<IntegrationReadResult<IntegrationRequirementsResponse>> {
    return this.readScoped<IntegrationRequirementsResponse>(
      `${scopePath(orgId, projectId)}/integration-requirements`,
      orgId,
      projectId,
    );
  }

  /** GET .../capability-nodes — the project's capability_nodes lifecycle rows. */
  async listCapabilityNodes(orgId: string, projectId: string): Promise<IntegrationReadResult<CapabilityNodesResponse>> {
    return this.readScoped<CapabilityNodesResponse>(
      `${scopePath(orgId, projectId)}/capability-nodes`,
      orgId,
      projectId,
    );
  }

  /** GET .../integration-bindings — the project's bindings + the in-15 appEnvHash proof. */
  async listBindings(orgId: string, projectId: string): Promise<IntegrationReadResult<IntegrationBindingsResponse>> {
    return this.readScoped<IntegrationBindingsResponse>(
      `${scopePath(orgId, projectId)}/integration-bindings`,
      orgId,
      projectId,
    );
  }

  /** GET .../delivery — the project's delivery-DAG status (in-17/19 live state). */
  async readDelivery(orgId: string, projectId: string): Promise<IntegrationReadResult<DeliveryDagStatusResponse>> {
    return this.readScoped<DeliveryDagStatusResponse>(`${scopePath(orgId, projectId)}/delivery`, orgId, projectId);
  }
}
