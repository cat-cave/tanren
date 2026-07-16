/**
 * Inventory/eligibility/selection query helpers for IntegrationMemoryDb unit fakes.
 * Not a SQL/transaction/RLS proof — structured table ops only.
 */
import type {
  MemoryAuthGeneration,
  MemoryConnection,
  MemoryGrant,
  MemoryGrantGeneration,
  MemoryOperation,
  MemorySelection,
} from "./integrationMemoryTables.js";
import type { IntegrationQueryResult } from "../../src/engine/repositories/integrationQuery.js";
import { defaultIntegrationResourceConstraints } from "../../src/engine/contracts/integrationAuthority.js";

export interface MemoryQueryState {
  connections: MemoryConnection[];
  authGenerations: MemoryAuthGeneration[];
  grants: MemoryGrant[];
  grantGenerations: MemoryGrantGeneration[];
  operations: MemoryOperation[];
  selections: MemorySelection[];
}

export function rowsOf(rows: unknown[]): IntegrationQueryResult {
  return { rows, rowCount: rows.length };
}

export function listInventory(state: MemoryQueryState, params: unknown[]): IntegrationQueryResult {
  const [orgId] = params as [string, string | null];
  const rows = state.connections
    .filter((c) => c.org_id === orgId && c.status === "active")
    .map((c) => {
      const grant = state.grants.find(
        (g) => g.org_id === c.org_id && g.connection_id === c.id && g.plane === "control" && g.status === "active",
      );
      const ag = state.authGenerations.find(
        (row) => row.org_id === c.org_id && row.connection_id === c.id && row.generation === c.current_auth_generation,
      );
      const gg =
        grant === undefined
          ? undefined
          : state.grantGenerations.find(
              (row) =>
                row.org_id === grant.org_id && row.grant_id === grant.id && row.generation === grant.current_generation,
            );
      const selection = state.selections.find(
        (s) => s.org_id === c.org_id && s.provider_kind === c.provider_kind && s.connection_id === c.id,
      );
      const pending = state.operations.find(
        (row) =>
          row.org_id === c.org_id &&
          row.provider_kind === c.provider_kind &&
          (row.connection_id === c.id || row.reserved_connection_id === c.id) &&
          ["pending", "in_progress", "awaiting_principal_selection"].includes(row.status),
      );
      return {
        connection_id: c.id,
        grant_id: grant?.id ?? null,
        org_id: c.org_id,
        provider_kind: c.provider_kind,
        provider_principal_id: c.provider_principal_id,
        principal_kind: c.principal_kind,
        display_name: c.display_name,
        health: c.health,
        connection_status: c.status,
        current_auth_generation: c.current_auth_generation,
        grant_generation: grant?.current_generation ?? null,
        grant_status: grant?.status ?? null,
        auth_expires_at: ag?.expires_at ?? null,
        provider_scopes: gg?.provider_scopes ?? [],
        operation_id: pending?.id ?? null,
        operation_stage: pending?.stage ?? null,
        operation_status: pending?.status ?? null,
        selected_for_project: selection !== undefined,
      };
    });
  return rowsOf(rows);
}

export function insertSelection(state: MemoryQueryState, params: unknown[]): IntegrationQueryResult {
  const [orgId, projectId, providerKind, connectionId, grantId, authGeneration, grantGeneration, selectedBy] =
    params as [string, string, string, string, string, number, number, string];
  const conn = state.connections.find(
    (c) =>
      c.org_id === orgId &&
      c.provider_kind === providerKind &&
      c.id === connectionId &&
      c.current_auth_generation === authGeneration,
  );
  const grant = state.grants.find(
    (g) =>
      g.org_id === orgId &&
      g.connection_id === connectionId &&
      g.id === grantId &&
      g.current_generation === grantGeneration,
  );
  if (conn === undefined || grant === undefined) return rowsOf([]);
  state.selections = state.selections.filter(
    (s) => !(s.org_id === orgId && s.project_id === projectId && s.provider_kind === providerKind),
  );
  state.selections.push({
    org_id: orgId,
    project_id: projectId,
    provider_kind: providerKind,
    connection_id: connectionId,
    auth_generation: authGeneration,
    grant_id: grantId,
    grant_generation: grantGeneration,
    selected_by: selectedBy,
  });
  return rowsOf([
    {
      connection_id: connectionId,
      grant_id: grantId,
      auth_generation: authGeneration,
      grant_generation: grantGeneration,
    },
  ]);
}

/** authorizeOperation eligibility join — inventory-only selection is separate. */
export function eligibilityQuery(state: MemoryQueryState, params: unknown[]): IntegrationQueryResult {
  const [orgId, projectId, providerKind] = params as [string, string, string];
  const rows = [];
  for (const c of state.connections.filter((row) => row.org_id === orgId && row.provider_kind === providerKind)) {
    for (const g of state.grants.filter(
      (row) => row.org_id === orgId && row.connection_id === c.id && row.plane === "control",
    )) {
      const ag = state.authGenerations.find(
        (row) => row.connection_id === c.id && row.generation === c.current_auth_generation,
      );
      const gg = state.grantGenerations.find((row) => row.grant_id === g.id && row.generation === g.current_generation);
      const s = state.selections.find(
        (row) => row.org_id === orgId && row.project_id === projectId && row.provider_kind === providerKind,
      );
      rows.push({
        connection_id: c.id,
        provider_kind: c.provider_kind,
        provider_principal_id: c.provider_principal_id,
        display_name: c.display_name,
        principal_metadata: c.principal_metadata,
        connection_health: c.health,
        connection_status: c.status,
        current_auth_generation: c.current_auth_generation,
        grant_id: g.id,
        grant_current_generation: g.current_generation,
        grant_status: g.status,
        plane: g.plane,
        environment: g.environment,
        credential_ref: ag?.credential_ref ?? null,
        auth_expires_at: ag?.expires_at ?? null,
        auth_status: ag?.status ?? null,
        capabilities: gg?.capabilities ?? null,
        operations: gg?.operations ?? null,
        provider_scopes: gg?.provider_scopes ?? null,
        resource_constraints: gg?.resource_constraints ?? defaultIntegrationResourceConstraints(),
        policy_revision: gg?.policy_revision ?? null,
        consent_revision: gg?.consent_revision ?? null,
        grant_expires_at: gg?.expires_at ?? null,
        grant_generation_status: gg?.status ?? null,
        selected_auth_generation: s?.auth_generation ?? null,
        selected_grant_generation: s?.grant_generation ?? null,
        selected_connection_id: s?.connection_id ?? null,
        selected_grant_id: s?.grant_id ?? null,
      });
    }
  }
  return rowsOf(rows);
}
