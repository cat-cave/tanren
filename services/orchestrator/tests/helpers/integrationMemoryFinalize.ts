import type {
  MemoryAuthGeneration,
  MemoryConnection,
  MemoryGrant,
  MemoryGrantGeneration,
  MemoryOperation,
} from "./integrationMemoryTables.js";

export function finalizeLinkInMemory(
  state: {
    connections: MemoryConnection[];
    authGenerations: MemoryAuthGeneration[];
    grants: MemoryGrant[];
    grantGenerations: MemoryGrantGeneration[];
    operations: MemoryOperation[];
  },
  params: unknown[],
): { rows: unknown[]; rowCount: number } {
  const [
    orgId,
    connectionId,
    providerKind,
    providerPrincipalId,
    principalKind,
    displayName,
    principalMetadataJson,
    nextGeneration,
    actorId,
    credentialRef,
    authKind,
    expiresAt,
    grantId,
    capabilities,
    operations,
    scopes,
    policyRevision,
    consentRevision,
    _c,
    operationId,
  ] = params as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    number,
    string,
    string,
    string,
    string | null,
    string,
    string[],
    string[],
    string[],
    string,
    string,
    string,
    string,
  ];
  const existingConn = state.connections.find(
    (c) => c.org_id === orgId && c.provider_kind === providerKind && c.provider_principal_id === providerPrincipalId,
  );
  const conn: MemoryConnection =
    existingConn === undefined
      ? {
          id: connectionId,
          org_id: orgId,
          provider_kind: providerKind,
          provider_principal_id: providerPrincipalId,
          principal_kind: principalKind,
          display_name: displayName,
          principal_metadata: JSON.parse(principalMetadataJson) as Record<string, unknown>,
          health: "healthy",
          status: "active",
          current_auth_generation: nextGeneration,
          owner_id: actorId,
        }
      : existingConn;
  if (existingConn === undefined) {
    state.connections.push(conn);
  } else {
    conn.current_auth_generation = nextGeneration;
    conn.health = "healthy";
    conn.status = "active";
    conn.display_name = displayName;
  }
  for (const ag of state.authGenerations) {
    if (ag.connection_id === conn.id && ag.status === "active") ag.status = "superseded";
  }
  state.authGenerations.push({
    org_id: orgId,
    provider_kind: providerKind,
    connection_id: conn.id,
    generation: nextGeneration,
    credential_ref: credentialRef,
    auth_kind: authKind,
    expires_at: expiresAt,
    status: "active",
  });
  const existingGrant = state.grants.find(
    (g) => g.org_id === orgId && g.connection_id === conn.id && g.plane === "control" && g.status === "active",
  );
  const grant: MemoryGrant =
    existingGrant === undefined
      ? {
          id: grantId,
          org_id: orgId,
          provider_kind: providerKind,
          connection_id: conn.id,
          plane: "control",
          environment: "control",
          current_generation: 1,
          status: "active",
        }
      : existingGrant;
  if (existingGrant === undefined) {
    state.grants.push(grant);
  } else {
    grant.current_generation = (grant.current_generation ?? 0) + 1;
  }
  for (const gg of state.grantGenerations) {
    if (gg.grant_id === grant.id && gg.status === "active") gg.status = "superseded";
  }
  state.grantGenerations.push({
    org_id: orgId,
    provider_kind: providerKind,
    connection_id: conn.id,
    grant_id: grant.id,
    generation: grant.current_generation!,
    capabilities,
    operations,
    provider_scopes: scopes,
    policy_revision: policyRevision,
    consent_revision: consentRevision,
    status: "active",
    expires_at: expiresAt,
  });
  const op = state.operations.find((o) => o.org_id === orgId && o.id === operationId);
  if (op !== undefined) {
    op.stage = "completed";
    op.status = "completed";
    op.connection_id = conn.id;
    op.target_auth_generation = nextGeneration;
    op.selected_principal_id = providerPrincipalId;
  }
  return {
    rows: [{ connection_id: conn.id, grant_id: grant.id, grant_generation: grant.current_generation }],
    rowCount: 1,
  };
}
