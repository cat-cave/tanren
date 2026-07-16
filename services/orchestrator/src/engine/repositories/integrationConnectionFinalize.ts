import { randomUUID } from "node:crypto";
import {
  catalogCapabilitiesForProvider,
  catalogEntry,
  integrationCatalogRevision,
} from "../contracts/integrationCatalog.js";
import { connectionCredentialBaseRef, type IntegrationSecretStore } from "../contracts/integrationSecretStore.js";
import type { PrincipalCandidate, PrincipalVerificationPermit } from "../contracts/integrationAuthority.js";
import type { StagedSecretHandle } from "../contracts/integrationSecretStore.js";
import type { IntegrationQueryClient } from "./integrationQuery.js";

export interface FinalizeVerifiedLinkInput {
  permit: PrincipalVerificationPermit;
  staged: StagedSecretHandle;
  principal: PrincipalCandidate;
  authKind: string;
  scopes: string[];
  expiresAt?: string;
  selectedPrincipalId?: string;
}
export interface FinalizeVerifiedLinkResult {
  connectionId: string;
  grantId: string;
  providerPrincipalId: string;
  authGeneration: number;
  grantGeneration: number;
  displayName: string;
}

function consentRevisionFor(actorId: string, at: Date): string {
  return `consent.${actorId}.${at.toISOString()}`;
}

/**
 * Convergent link/rotate finalization saga (no SQL+Vault atomicity claim):
 * 1. Reserve canonical connection id + next generation in DB (lock + durable op).
 * 2. Create-only secret write at exact generation.
 * 3. Atomically finalize auth/grant pointers only if the operation still owns the reservation.
 */
// eslint-disable-next-line max-lines-per-function -- convergent multi-phase saga must stay ordered
export async function finalizeVerifiedLinkSql(
  client: IntegrationQueryClient,
  input: FinalizeVerifiedLinkInput,
  secrets: IntegrationSecretStore,
): Promise<FinalizeVerifiedLinkResult> {
  const permit = input.permit;
  const principal = input.principal;

  // Best-effort serialization (real PG); unit fakes may no-op.
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
    `${permit.orgId}:${permit.providerKind}`,
    principal.providerPrincipalId,
  ]);

  const opResult = await client.query(
    `SELECT id, provider_kind, connection_id, operation_kind, stage, status,
            staged_secret_handle, candidate_principals, actor_id, target_auth_generation,
            compensation_state
     FROM org_integration_connection_operations
     WHERE org_id = $1 AND id = $2`,
    [permit.orgId, permit.operationId],
  );
  const op = opResult.rows[0] as
    | {
        id: string;
        operation_kind: string;
        connection_id: string | null;
        stage: string;
        status: string;
        target_auth_generation: number | null;
      }
    | undefined;
  if (op === undefined) throw new Error("operation missing at finalize");

  if (op.status === "completed" && op.stage === "completed") {
    return loadCompletedResult(client, permit, principal, op.connection_id);
  }
  if (op.status === "failed" || op.status === "compensated") {
    throw new Error(`operation_terminal_${op.status}`);
  }

  const existing = await client.query(
    `SELECT id, current_auth_generation, status FROM org_integration_connections
     WHERE org_id = $1 AND provider_kind = $2 AND provider_principal_id = $3`,
    [permit.orgId, permit.providerKind, principal.providerPrincipalId],
  );
  const existingRow = existing.rows[0] as
    | { id: string; current_auth_generation: number | null; status: string }
    | undefined;

  if (op.operation_kind === "link" && existingRow !== undefined && existingRow.status === "active") {
    throw new Error("principal_already_linked");
  }
  if (
    op.operation_kind === "rotate" &&
    (op.connection_id === null || existingRow === undefined || existingRow.id !== op.connection_id)
  ) {
    throw new Error("rotate_principal_mismatch");
  }

  const connectionId = existingRow?.id ?? randomUUID();
  const priorGeneration = existingRow?.current_auth_generation ?? 0;
  const nextGeneration =
    op.target_auth_generation !== null && op.target_auth_generation > priorGeneration
      ? op.target_auth_generation
      : priorGeneration + 1;
  const grantId = randomUUID();
  const baseRef = connectionCredentialBaseRef(permit.orgId, permit.providerKind, connectionId);

  // 1. Ensure stable connection row exists BEFORE operation.connection_id FK.
  if (existingRow === undefined) {
    await client.query(
      `INSERT INTO org_integration_connections
         (org_id, id, provider_kind, provider_principal_id, principal_kind, display_name,
          principal_metadata, health, status, current_auth_generation, owner_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'healthy', 'active', NULL, $8, now())
       ON CONFLICT (org_id, provider_kind, provider_principal_id) DO NOTHING`,
      [
        permit.orgId,
        connectionId,
        permit.providerKind,
        principal.providerPrincipalId,
        principal.principalKind,
        principal.displayName,
        JSON.stringify(principal.metadata),
        permit.actorId,
      ],
    );
  }

  // 2. Reserve generation on the durable operation before secret placement.
  await client.query(
    `UPDATE org_integration_connection_operations
     SET stage = 'finalizing', status = 'in_progress',
         connection_id = $3,
         target_auth_generation = $4,
         selected_principal_id = $5,
         compensation_state = COALESCE(compensation_state, '{}'::jsonb) || $6::jsonb,
         updated_at = now()
     WHERE org_id = $1 AND id = $2
       AND status IN ('pending','in_progress','awaiting_principal_selection')`,
    [
      permit.orgId,
      permit.operationId,
      connectionId,
      nextGeneration,
      principal.providerPrincipalId,
      JSON.stringify({ reservedConnectionId: connectionId, reservedAuthGeneration: nextGeneration }),
    ],
  );

  // 3. Create-only secret write (exact generation). Never delete ambiguous success.
  let credentialRef: string;
  try {
    const finalized = await secrets.finalize(input.staged, baseRef, nextGeneration);
    credentialRef = finalized.ref;
  } catch (error) {
    await client.query(
      `UPDATE org_integration_connection_operations
       SET failure_classification = 'secret_finalize_failed',
           compensation_state = compensation_state || $3::jsonb,
           updated_at = now()
       WHERE org_id = $1 AND id = $2`,
      [
        permit.orgId,
        permit.operationId,
        JSON.stringify({
          secretFinalizeError: error instanceof Error ? error.message : String(error),
          reservedCredentialBase: baseRef,
        }),
      ],
    );
    throw error;
  }

  // 4. Pointer flip only if this operation still owns the reservation.
  const owner = await client.query(
    `SELECT id FROM org_integration_connection_operations
     WHERE org_id = $1 AND id = $2
       AND target_auth_generation = $3
       AND status = 'in_progress'
       AND stage = 'finalizing'`,
    [permit.orgId, permit.operationId, nextGeneration],
  );
  if ((owner.rowCount ?? 0) === 0) {
    throw new Error("operation_lost_reservation");
  }

  const consentedAt = new Date();
  const capabilities = catalogCapabilitiesForProvider(permit.providerKind);
  const operations = [
    ...new Set(
      (catalogEntry(permit.providerKind)?.capabilities ?? []).flatMap((capability) =>
        capability.operations.map((operation) => operation.id),
      ),
    ),
  ];
  const policyRevision = integrationCatalogRevision();
  const consentRevision = consentRevisionFor(permit.actorId, consentedAt);

  const result = await client.query(
    `WITH supersede_auth AS (
       UPDATE org_integration_connection_auth_generations
       SET status = 'superseded'
       WHERE org_id = $1 AND provider_kind = $3 AND connection_id = $2
         AND generation < $8 AND status = 'active'
     ), auth_gen AS (
       INSERT INTO org_integration_connection_auth_generations
         (org_id, provider_kind, connection_id, generation, credential_ref, auth_kind, expires_at, status)
       VALUES ($1, $3, $2, $8, $10, $11, $12::timestamptz, 'active')
       ON CONFLICT (org_id, provider_kind, connection_id, generation) DO UPDATE SET
         credential_ref = EXCLUDED.credential_ref,
         auth_kind = EXCLUDED.auth_kind,
         expires_at = EXCLUDED.expires_at,
         status = 'active'
       RETURNING generation
     ), connection AS (
       UPDATE org_integration_connections
       SET display_name = $6,
           principal_metadata = $7::jsonb,
           health = 'healthy',
           status = 'active',
           current_auth_generation = $8,
           owner_id = $9,
           updated_at = now()
       WHERE org_id = $1 AND id = $2
       RETURNING id
     ), prior_grant AS (
       SELECT id FROM org_integration_grants
       WHERE org_id = $1 AND connection_id = $2 AND plane = 'control' AND environment = 'control'
         AND status = 'active'
       LIMIT 1
     ), grant_row AS (
       INSERT INTO org_integration_grants
         (org_id, id, provider_kind, connection_id, plane, environment, current_generation, status, updated_at)
       SELECT $1, COALESCE((SELECT id FROM prior_grant), $13::text), $3, $2, 'control', 'control', 1, 'active', now()
       ON CONFLICT (org_id, connection_id, plane, environment) WHERE status = 'active'
       DO UPDATE SET current_generation = org_integration_grants.current_generation + 1,
         status = 'active', updated_at = now()
       RETURNING id, current_generation
     ), supersede_grant AS (
       UPDATE org_integration_grant_generations gg
       SET status = 'superseded'
       FROM grant_row
       WHERE gg.org_id = $1 AND gg.provider_kind = $3 AND gg.connection_id = $2
         AND gg.grant_id = grant_row.id AND gg.generation < grant_row.current_generation
         AND gg.status = 'active'
     ), grant_gen AS (
       INSERT INTO org_integration_grant_generations
         (org_id, provider_kind, connection_id, grant_id, generation, capabilities, operations,
          provider_scopes, resource_constraints, policy_revision, consent_revision,
          consent_actor_id, consented_at, expires_at, status)
       SELECT $1, $3, $2, grant_row.id, grant_row.current_generation, $14::text[], $15::text[],
              $16::text[], '{}'::jsonb, $17, $18, $9, $19::timestamptz, $12::timestamptz, 'active'
       FROM grant_row
       ON CONFLICT (org_id, provider_kind, connection_id, grant_id, generation) DO UPDATE SET
         provider_scopes = EXCLUDED.provider_scopes,
         capabilities = EXCLUDED.capabilities,
         operations = EXCLUDED.operations,
         status = 'active'
       RETURNING grant_id, generation
     ), complete_op AS (
       UPDATE org_integration_connection_operations
       SET stage = 'completed', status = 'completed', connection_id = $2,
           target_auth_generation = $8, selected_principal_id = $4,
           completed_at = now(), updated_at = now(),
           failure_classification = NULL
       WHERE org_id = $1 AND id = $20 AND stage = 'finalizing' AND status = 'in_progress'
     )
     SELECT connection.id AS connection_id, grant_gen.grant_id, grant_gen.generation AS grant_generation
     FROM connection, grant_gen, auth_gen`,
    [
      permit.orgId,
      connectionId,
      permit.providerKind,
      principal.providerPrincipalId,
      principal.principalKind,
      principal.displayName,
      JSON.stringify(principal.metadata),
      nextGeneration,
      permit.actorId,
      credentialRef,
      input.authKind,
      input.expiresAt ?? null,
      grantId,
      capabilities,
      operations,
      input.scopes,
      policyRevision,
      consentRevision,
      consentedAt.toISOString(),
      permit.operationId,
    ],
  );
  const row = result.rows[0] as { connection_id: string; grant_id: string; grant_generation: number } | undefined;
  if (row === undefined) throw new Error("finalize returned no row");
  return {
    connectionId: row.connection_id,
    grantId: row.grant_id,
    providerPrincipalId: principal.providerPrincipalId,
    authGeneration: nextGeneration,
    grantGeneration: row.grant_generation,
    displayName: principal.displayName,
  };
}

async function loadCompletedResult(
  client: IntegrationQueryClient,
  permit: PrincipalVerificationPermit,
  principal: PrincipalCandidate,
  connectionId: string | null,
): Promise<FinalizeVerifiedLinkResult> {
  if (connectionId === null) throw new Error("completed_operation_missing_connection");
  const result = await client.query(
    `SELECT c.id AS connection_id, c.display_name, c.current_auth_generation,
            g.id AS grant_id, g.current_generation AS grant_generation
     FROM org_integration_connections c
     JOIN org_integration_grants g
       ON g.org_id = c.org_id AND g.connection_id = c.id
      AND g.plane = 'control' AND g.environment = 'control' AND g.status = 'active'
     WHERE c.org_id = $1 AND c.id = $2 AND c.provider_kind = $3`,
    [permit.orgId, connectionId, permit.providerKind],
  );
  const row = result.rows[0] as
    | {
        connection_id: string;
        display_name: string;
        current_auth_generation: number;
        grant_id: string;
        grant_generation: number;
      }
    | undefined;
  if (row === undefined) throw new Error("completed_operation_missing_rows");
  return {
    connectionId: row.connection_id,
    grantId: row.grant_id,
    providerPrincipalId: principal.providerPrincipalId,
    authGeneration: row.current_auth_generation,
    grantGeneration: row.grant_generation,
    displayName: row.display_name,
  };
}
