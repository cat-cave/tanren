import type { FinalizeVerifiedLinkResult, LinkReservation } from "./integrationConnectionFinalize.js";
import type { IntegrationQueryClient } from "./integrationQuery.js";

/** Read the exact immutable rows owned by a completed durable reservation. */
export async function loadCompletedLinkResult(
  client: IntegrationQueryClient,
  reservation: LinkReservation,
): Promise<FinalizeVerifiedLinkResult> {
  const result = await client.query(
    `SELECT c.id AS connection_id, c.display_name, ag.generation AS auth_generation,
            g.id AS grant_id, gg.generation AS grant_generation
     FROM org_integration_connections c
     JOIN org_integration_grants g
       ON g.org_id = c.org_id AND g.connection_id = c.id AND g.id = $5
      AND g.plane = 'control' AND g.environment = 'control'
     JOIN org_integration_connection_auth_generations ag
       ON ag.org_id = c.org_id AND ag.provider_kind = c.provider_kind
      AND ag.connection_id = c.id AND ag.generation = $4
     JOIN org_integration_grant_generations gg
       ON gg.org_id = g.org_id AND gg.provider_kind = g.provider_kind
      AND gg.connection_id = g.connection_id AND gg.grant_id = g.id AND gg.generation = $6
     WHERE c.org_id = $1 AND c.id = $2 AND c.provider_kind = $3`,
    [
      reservation.permit.orgId,
      reservation.connectionId,
      reservation.permit.providerKind,
      reservation.nextGeneration,
      reservation.grantId,
      reservation.grantGeneration,
    ],
  );
  const row = result.rows[0] as
    | {
        connection_id: string;
        display_name: string;
        auth_generation: number;
        grant_id: string;
        grant_generation: number;
      }
    | undefined;
  if (row === undefined) throw new Error("completed_operation_missing_rows");
  return {
    connectionId: row.connection_id,
    grantId: row.grant_id,
    providerPrincipalId: reservation.principal.providerPrincipalId,
    authGeneration: row.auth_generation,
    grantGeneration: row.grant_generation,
    displayName: row.display_name,
  };
}
