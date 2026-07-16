/** Unit-fake activate-phase handlers — not SQL/RLS proof. */
import type { IntegrationQueryResult } from "../../src/engine/repositories/integrationQuery.js";
import type {
  MemoryAuthGeneration,
  MemoryConnection,
  MemoryGrant,
  MemoryGrantGeneration,
  MemoryOperation,
} from "./integrationMemoryTables.js";
import { rowsOf } from "./integrationMemoryQueries.js";

export interface MemoryActivateState {
  connections: MemoryConnection[];
  authGenerations: MemoryAuthGeneration[];
  grants: MemoryGrant[];
  grantGenerations: MemoryGrantGeneration[];
  operations: MemoryOperation[];
}

export function dispatchActivateSql(
  state: MemoryActivateState,
  sql: string,
  params: unknown[],
): IntegrationQueryResult | null {
  if (
    sql.includes("UPDATE org_integration_connection_auth_generations") &&
    sql.includes("status = 'superseded'") &&
    sql.includes("generation <")
  ) {
    const [orgId, providerKind, connectionId, generation] = params as [string, string, string, number];
    for (const ag of state.authGenerations) {
      if (
        ag.org_id === orgId &&
        ag.provider_kind === providerKind &&
        ag.connection_id === connectionId &&
        ag.generation < generation &&
        ag.status === "active"
      ) {
        ag.status = "superseded";
      }
    }
    return rowsOf([]);
  }
  if (sql.startsWith("INSERT INTO org_integration_connection_auth_generations")) {
    const [orgId, providerKind, connectionId, generation, credentialRef, authKind, expiresAt] = params as [
      string,
      string,
      string,
      number,
      string,
      string,
      string | null,
    ];
    const exists = state.authGenerations.find(
      (ag) =>
        ag.org_id === orgId &&
        ag.provider_kind === providerKind &&
        ag.connection_id === connectionId &&
        ag.generation === generation,
    );
    if (exists !== undefined) return rowsOf([]);
    state.authGenerations.push({
      org_id: orgId,
      provider_kind: providerKind,
      connection_id: connectionId,
      generation,
      credential_ref: credentialRef,
      auth_kind: authKind,
      expires_at: expiresAt,
      status: "active",
    });
    return rowsOf([{ generation, credential_ref: credentialRef, auth_kind: authKind, status: "active" }]);
  }
  if (
    sql.includes("FROM org_integration_connection_auth_generations") &&
    sql.includes("credential_ref, auth_kind, status")
  ) {
    const [orgId, providerKind, connectionId, generation] = params as [string, string, string, number];
    const ag = state.authGenerations.find(
      (row) =>
        row.org_id === orgId &&
        row.provider_kind === providerKind &&
        row.connection_id === connectionId &&
        row.generation === generation,
    );
    return rowsOf(ag ? [{ credential_ref: ag.credential_ref, auth_kind: ag.auth_kind, status: ag.status }] : []);
  }
  if (sql.startsWith("UPDATE org_integration_connections") && sql.includes("current_auth_generation")) {
    const [orgId, connectionId, displayName, metadataJson, generation, actorId] = params as [
      string,
      string,
      string,
      string,
      number,
      string,
    ];
    const conn = state.connections.find((row) => row.org_id === orgId && row.id === connectionId);
    if (conn !== undefined) {
      conn.display_name = displayName;
      conn.principal_metadata = JSON.parse(metadataJson) as Record<string, unknown>;
      conn.health = "healthy";
      conn.status = "active";
      conn.current_auth_generation = generation;
      conn.owner_id = actorId;
    }
    return rowsOf([]);
  }
  if (sql.startsWith("INSERT INTO org_integration_grants")) {
    const [orgId, grantId, providerKind, connectionId] = params as [string, string, string, string];
    const existing = state.grants.find(
      (g) =>
        g.org_id === orgId &&
        g.connection_id === connectionId &&
        g.plane === "control" &&
        g.environment === "control" &&
        g.status === "active",
    );
    if (existing !== undefined) {
      existing.current_generation = (existing.current_generation ?? 0) + 1;
      return rowsOf([{ id: existing.id, current_generation: existing.current_generation }]);
    }
    state.grants.push({
      id: grantId,
      org_id: orgId,
      provider_kind: providerKind,
      connection_id: connectionId,
      plane: "control",
      environment: "control",
      current_generation: 1,
      status: "active",
    });
    return rowsOf([{ id: grantId, current_generation: 1 }]);
  }
  if (
    sql.includes("UPDATE org_integration_grant_generations") &&
    sql.includes("status = 'superseded'") &&
    sql.includes("generation <")
  ) {
    const [orgId, providerKind, connectionId, grantId, generation] = params as [string, string, string, string, number];
    for (const gg of state.grantGenerations) {
      if (
        gg.org_id === orgId &&
        gg.provider_kind === providerKind &&
        gg.connection_id === connectionId &&
        gg.grant_id === grantId &&
        gg.generation < generation &&
        gg.status === "active"
      ) {
        gg.status = "superseded";
      }
    }
    return rowsOf([]);
  }
  if (sql.startsWith("INSERT INTO org_integration_grant_generations")) {
    const [
      orgId,
      providerKind,
      connectionId,
      grantId,
      generation,
      capabilities,
      operations,
      scopes,
      policyRevision,
      consentRevision,
      _actorId,
      _consentedAt,
      expiresAt,
    ] = params as [
      string,
      string,
      string,
      string,
      number,
      string[],
      string[],
      string[],
      string,
      string,
      string,
      string,
      string | null,
    ];
    const exists = state.grantGenerations.find(
      (gg) =>
        gg.org_id === orgId &&
        gg.provider_kind === providerKind &&
        gg.connection_id === connectionId &&
        gg.grant_id === grantId &&
        gg.generation === generation,
    );
    if (exists !== undefined) return rowsOf([]);
    state.grantGenerations.push({
      org_id: orgId,
      provider_kind: providerKind,
      connection_id: connectionId,
      grant_id: grantId,
      generation,
      capabilities,
      operations,
      provider_scopes: scopes,
      policy_revision: policyRevision,
      consent_revision: consentRevision,
      status: "active",
      expires_at: expiresAt,
    });
    return rowsOf([{ grant_id: grantId, generation }]);
  }
  if (
    sql.includes("FROM org_integration_grant_generations") &&
    sql.includes("capabilities, operations, provider_scopes")
  ) {
    const [orgId, providerKind, connectionId, grantId, generation] = params as [string, string, string, string, number];
    const gg = state.grantGenerations.find(
      (row) =>
        row.org_id === orgId &&
        row.provider_kind === providerKind &&
        row.connection_id === connectionId &&
        row.grant_id === grantId &&
        row.generation === generation,
    );
    return rowsOf(
      gg
        ? [
            {
              capabilities: gg.capabilities,
              operations: gg.operations,
              provider_scopes: gg.provider_scopes,
              policy_revision: gg.policy_revision,
              consent_revision: gg.consent_revision,
              status: gg.status,
            },
          ]
        : [],
    );
  }
  if (
    sql.includes("UPDATE org_integration_connection_operations") &&
    sql.includes("stage = 'completed'") &&
    sql.includes("status = 'completed'")
  ) {
    const [orgId, operationId, connectionId, generation, principalId] = params as [
      string,
      string,
      string,
      number,
      string,
    ];
    const op = state.operations.find((row) => row.org_id === orgId && row.id === operationId);
    if (op !== undefined) {
      op.stage = "completed";
      op.status = "completed";
      op.connection_id = connectionId;
      op.target_auth_generation = generation;
      op.selected_principal_id = principalId;
    }
    return rowsOf([]);
  }
  return null;
}
