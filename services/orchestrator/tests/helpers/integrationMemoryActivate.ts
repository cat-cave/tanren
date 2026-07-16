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
  if (sql.includes("FROM org_integration_connection_auth_generations") && sql.includes("credential_ref, auth_kind")) {
    const [orgId, providerKind, connectionId, generation] = params as [string, string, string, number];
    const ag = state.authGenerations.find(
      (row) =>
        row.org_id === orgId &&
        row.provider_kind === providerKind &&
        row.connection_id === connectionId &&
        row.generation === generation,
    );
    return rowsOf(
      ag
        ? [
            {
              credential_ref: ag.credential_ref,
              auth_kind: ag.auth_kind,
              expires_at: ag.expires_at,
              status: ag.status,
            },
          ]
        : [],
    );
  }
  if (sql.startsWith("UPDATE org_integration_connections") && sql.includes("current_auth_generation")) {
    const [orgId, providerKind, connectionId, displayName, metadataJson, generation, actorId, priorGeneration] =
      params as [string, string, string, string, string, number, string, number | null];
    const conn = state.connections.find(
      (row) => row.org_id === orgId && row.provider_kind === providerKind && row.id === connectionId,
    );
    if (
      conn !== undefined &&
      (conn.current_auth_generation === priorGeneration || conn.current_auth_generation === generation)
    ) {
      conn.display_name = displayName;
      conn.principal_metadata = JSON.parse(metadataJson) as Record<string, unknown>;
      conn.health = "healthy";
      conn.status = "active";
      conn.current_auth_generation = generation;
      conn.owner_id = actorId;
    }
    return rowsOf(conn ? [{ id: conn.id }] : []);
  }
  if (sql.startsWith("INSERT INTO org_integration_grants")) {
    const [orgId, grantId, providerKind, connectionId] = params as [string, string, string, string];
    const existing = state.grants.find((g) => g.org_id === orgId && g.id === grantId);
    if (existing !== undefined) return rowsOf([]);
    state.grants.push({
      id: grantId,
      org_id: orgId,
      provider_kind: providerKind,
      connection_id: connectionId,
      plane: "control",
      environment: "control",
      current_generation: null,
      status: "pending",
    });
    return rowsOf([]);
  }
  if (sql.startsWith("UPDATE org_integration_grants") && sql.includes("current_generation")) {
    const [orgId, providerKind, connectionId, grantId, generation, priorGeneration] = params as [
      string,
      string,
      string,
      string,
      number,
      number | null,
    ];
    const grant = state.grants.find(
      (row) =>
        row.org_id === orgId &&
        row.provider_kind === providerKind &&
        row.connection_id === connectionId &&
        row.id === grantId,
    );
    if (
      grant !== undefined &&
      (grant.current_generation === priorGeneration || grant.current_generation === generation)
    ) {
      grant.current_generation = generation;
      grant.status = "active";
      return rowsOf([{ id: grant.id }]);
    }
    return rowsOf([]);
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
      actorId,
      consentedAt,
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
      resource_constraints: {},
      policy_revision: policyRevision,
      consent_revision: consentRevision,
      consent_actor_id: actorId,
      consented_at: consentedAt,
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
              resource_constraints: gg.resource_constraints ?? {},
              policy_revision: gg.policy_revision,
              consent_revision: gg.consent_revision,
              consent_actor_id: gg.consent_actor_id,
              consented_at: gg.consented_at,
              expires_at: gg.expires_at,
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
