import { OrchestratorHttpClient } from "./httpClient.js";

export type RepairRouteDisposition = "repair_in_place" | "respec" | "blocked_needs_attention";

/** One durable mq-10 autonomous-repair routing decision (repair / respec / blocked). */
export interface MergeQueueRepairRoute {
  readonly routeId: string;
  readonly sourceSpecId: string;
  readonly groupId: string;
  readonly evaluationId: string;
  readonly disposition: RepairRouteDisposition;
  readonly failureClass: string;
  readonly failureSignature: string;
  readonly magnitude: number;
  readonly findingIds: string[];
  readonly reasonCodes: string[];
  readonly respecGeneration: number;
  readonly priorAgentRoute: string | null;
  readonly nextAgentRoute: string | null;
  readonly packetHash: string | null;
  readonly replacementSpecIds: string[];
  readonly observedAt: string;
}

export interface MergeQueueRepairRoutesListResponse {
  readonly repairRoutes: MergeQueueRepairRoute[];
}

/** Typed client for the durable mq-10 repair/respec lineage projection. */
export class MergeQueueRepairRoutesClient extends OrchestratorHttpClient {
  async listRepairRoutes(
    orgId: string,
    projectId: string,
    limit = 50,
  ): Promise<MergeQueueRepairRoutesListResponse | undefined> {
    return await this.getJson<MergeQueueRepairRoutesListResponse>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}` +
        `/merge-queue/repair-routes?limit=${encodeURIComponent(String(limit))}`,
    );
  }
}
