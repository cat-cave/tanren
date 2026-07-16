export const INTEGRATION_ELIGIBILITY_SQL = `
SELECT
  c.id AS connection_id, c.provider_kind, c.provider_principal_id, c.display_name,
  c.principal_metadata, c.health AS connection_health, c.status AS connection_status,
  c.current_auth_generation, g.id AS grant_id, g.current_generation AS grant_current_generation,
  g.status AS grant_status, g.plane, g.environment, ag.credential_ref,
  ag.expires_at AS auth_expires_at, ag.status AS auth_status, gg.capabilities,
  gg.operations, gg.provider_scopes, gg.resource_constraints, gg.policy_revision,
  gg.consent_revision, gg.expires_at AS grant_expires_at,
  gg.status AS grant_generation_status, s.auth_generation AS selected_auth_generation,
  s.grant_generation AS selected_grant_generation, s.connection_id AS selected_connection_id,
  s.grant_id AS selected_grant_id
FROM org_integration_connections c
JOIN org_integration_grants g
  ON g.org_id = c.org_id AND g.provider_kind = c.provider_kind AND g.connection_id = c.id
LEFT JOIN org_integration_connection_auth_generations ag
  ON ag.org_id = c.org_id AND ag.provider_kind = c.provider_kind
 AND ag.connection_id = c.id AND ag.generation = c.current_auth_generation
LEFT JOIN org_integration_grant_generations gg
  ON gg.org_id = g.org_id AND gg.provider_kind = g.provider_kind
 AND gg.connection_id = g.connection_id AND gg.grant_id = g.id
 AND gg.generation = g.current_generation
LEFT JOIN project_integration_grant_selections s
  ON s.org_id = c.org_id AND s.project_id = $2 AND s.provider_kind = c.provider_kind
WHERE c.org_id = $1 AND c.provider_kind = $3
  AND g.plane = 'control' AND g.environment = 'control'
ORDER BY c.provider_principal_id, g.id
`;

export type IntegrationEligibilityRow = {
  connection_id: string;
  provider_kind: string;
  provider_principal_id: string;
  display_name: string;
  principal_metadata: Record<string, unknown>;
  connection_health: string;
  connection_status: string;
  current_auth_generation: number | null;
  grant_id: string;
  grant_current_generation: number | null;
  grant_status: string;
  plane: string;
  environment: string;
  credential_ref: string | null;
  auth_expires_at: Date | string | null;
  auth_status: string | null;
  capabilities: string[] | null;
  operations: string[] | null;
  provider_scopes: string[] | null;
  resource_constraints: Record<string, unknown> | null;
  policy_revision: string | null;
  consent_revision: string | null;
  grant_expires_at: Date | string | null;
  grant_generation_status: string | null;
  selected_auth_generation: number | null;
  selected_grant_generation: number | null;
  selected_connection_id: string | null;
  selected_grant_id: string | null;
};
