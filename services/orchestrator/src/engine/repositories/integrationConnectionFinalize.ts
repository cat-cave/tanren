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
import {
  assertIdenticalAuthGeneration,
  assertIdenticalGrantGeneration,
} from "./integrationConnectionFinalizeAssert.js";

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

export interface LinkReservation {
  connectionId: string;
  nextGeneration: number;
  baseRef: string;
  grantId: string;
  principal: PrincipalCandidate;
  permit: PrincipalVerificationPermit;
  authKind: string;
  scopes: string[];
  expiresAt?: string;
}

function consentRevisionFor(actorId: string, at: Date): string {
  return `consent.${actorId}.${at.toISOString()}`;
}

/**
 * Phase 1 — short org-scoped reserve transaction only (no provider/Vault I/O).
 * Durable operation owns connection_id + target_auth_generation.
 */
export async function reserveVerifiedLinkSql(
  client: IntegrationQueryClient,
  input: FinalizeVerifiedLinkInput,
): Promise<LinkReservation | FinalizeVerifiedLinkResult> {
  const permit = input.permit;
  const principal = input.principal;

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

  return {
    connectionId,
    nextGeneration,
    baseRef,
    grantId,
    principal,
    permit,
    authKind: input.authKind,
    scopes: input.scopes,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  };
}

/** Phase 2 — Vault create-only outside any SQL transaction. */
export async function finalizeReservedSecret(
  secrets: IntegrationSecretStore,
  reservation: LinkReservation,
  staged: StagedSecretHandle,
): Promise<string> {
  const finalized = await secrets.finalize(staged, reservation.baseRef, reservation.nextGeneration);
  return finalized.ref;
}

/**
 * Phase 3 — short org-scoped activation with operation ownership/CAS.
 * Auth/grant generation rows are create-only; identical conflict continues,
 * different values fail hard. Never mutates credential_ref/scopes for a fixed gen.
 */
// eslint-disable-next-line max-lines-per-function -- ordered pointer-flip multi-statement
export async function activateReservedLinkSql(
  client: IntegrationQueryClient,
  reservation: LinkReservation,
  credentialRef: string,
): Promise<FinalizeVerifiedLinkResult> {
  const { permit, principal, connectionId, nextGeneration, grantId } = reservation;

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

  // Supersede prior active auth gens (other generations only — not this one).
  await client.query(
    `UPDATE org_integration_connection_auth_generations
     SET status = 'superseded'
     WHERE org_id = $1 AND provider_kind = $2 AND connection_id = $3
       AND generation < $4 AND status = 'active'`,
    [permit.orgId, permit.providerKind, connectionId, nextGeneration],
  );

  // Create-only auth generation — never DO UPDATE credential_ref/scopes/status.
  const authInsert = await client.query(
    `INSERT INTO org_integration_connection_auth_generations
       (org_id, provider_kind, connection_id, generation, credential_ref, auth_kind, expires_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, 'active')
     ON CONFLICT (org_id, provider_kind, connection_id, generation) DO NOTHING
     RETURNING generation, credential_ref, auth_kind, status`,
    [
      permit.orgId,
      permit.providerKind,
      connectionId,
      nextGeneration,
      credentialRef,
      reservation.authKind,
      reservation.expiresAt ?? null,
    ],
  );
  if ((authInsert.rowCount ?? 0) === 0) {
    await assertIdenticalAuthGeneration(client, {
      orgId: permit.orgId,
      providerKind: permit.providerKind,
      connectionId,
      generation: nextGeneration,
      credentialRef,
      authKind: reservation.authKind,
    });
  }

  await client.query(
    `UPDATE org_integration_connections
     SET display_name = $3,
         principal_metadata = $4::jsonb,
         health = 'healthy',
         status = 'active',
         current_auth_generation = $5,
         owner_id = $6,
         updated_at = now()
     WHERE org_id = $1 AND id = $2`,
    [
      permit.orgId,
      connectionId,
      principal.displayName,
      JSON.stringify(principal.metadata),
      nextGeneration,
      permit.actorId,
    ],
  );

  const grantRow = await client.query(
    `INSERT INTO org_integration_grants
       (org_id, id, provider_kind, connection_id, plane, environment, current_generation, status, updated_at)
     VALUES ($1, $2, $3, $4, 'control', 'control', 1, 'active', now())
     ON CONFLICT (org_id, connection_id, plane, environment) WHERE status = 'active'
     DO UPDATE SET current_generation = org_integration_grants.current_generation + 1,
       status = 'active', updated_at = now()
     RETURNING id, current_generation`,
    [permit.orgId, grantId, permit.providerKind, connectionId],
  );
  const grant = grantRow.rows[0] as { id: string; current_generation: number } | undefined;
  if (grant === undefined) throw new Error("grant row missing after upsert");

  await client.query(
    `UPDATE org_integration_grant_generations
     SET status = 'superseded'
     WHERE org_id = $1 AND provider_kind = $2 AND connection_id = $3
       AND grant_id = $4 AND generation < $5 AND status = 'active'`,
    [permit.orgId, permit.providerKind, connectionId, grant.id, grant.current_generation],
  );

  const grantGenInsert = await client.query(
    `INSERT INTO org_integration_grant_generations
       (org_id, provider_kind, connection_id, grant_id, generation, capabilities, operations,
        provider_scopes, resource_constraints, policy_revision, consent_revision,
        consent_actor_id, consented_at, expires_at, status)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8::text[], '{}'::jsonb,
             $9, $10, $11, $12::timestamptz, $13::timestamptz, 'active')
     ON CONFLICT (org_id, provider_kind, connection_id, grant_id, generation) DO NOTHING
     RETURNING grant_id, generation`,
    [
      permit.orgId,
      permit.providerKind,
      connectionId,
      grant.id,
      grant.current_generation,
      capabilities,
      operations,
      reservation.scopes,
      policyRevision,
      consentRevision,
      permit.actorId,
      consentedAt.toISOString(),
      reservation.expiresAt ?? null,
    ],
  );
  if ((grantGenInsert.rowCount ?? 0) === 0) {
    await assertIdenticalGrantGeneration(client, {
      orgId: permit.orgId,
      providerKind: permit.providerKind,
      connectionId,
      grantId: grant.id,
      generation: grant.current_generation,
      capabilities,
      operations,
      scopes: reservation.scopes,
      policyRevision,
      consentRevision,
    });
  }

  await client.query(
    `UPDATE org_integration_connection_operations
     SET stage = 'completed', status = 'completed', connection_id = $3,
         target_auth_generation = $4, selected_principal_id = $5,
         completed_at = now(), updated_at = now(),
         failure_classification = NULL
     WHERE org_id = $1 AND id = $2 AND stage = 'finalizing' AND status = 'in_progress'`,
    [permit.orgId, permit.operationId, connectionId, nextGeneration, principal.providerPrincipalId],
  );

  return {
    connectionId,
    grantId: grant.id,
    providerPrincipalId: principal.providerPrincipalId,
    authGeneration: nextGeneration,
    grantGeneration: grant.current_generation,
    displayName: principal.displayName,
  };
}

/**
 * Full saga orchestrator for callers that hold a long-lived client (unit fakes).
 * Production HTTP routes MUST split phases across separate withOrgScope calls so
 * Vault I/O never runs under BEGIN.
 */
export async function finalizeVerifiedLinkSql(
  client: IntegrationQueryClient,
  input: FinalizeVerifiedLinkInput,
  secrets: IntegrationSecretStore,
): Promise<FinalizeVerifiedLinkResult> {
  const reserved = await reserveVerifiedLinkSql(client, input);
  if ("authGeneration" in reserved && "connectionId" in reserved && !("nextGeneration" in reserved)) {
    return reserved;
  }
  const reservation = reserved as LinkReservation;
  let credentialRef: string;
  try {
    credentialRef = await finalizeReservedSecret(secrets, reservation, input.staged);
  } catch (error) {
    await client.query(
      `UPDATE org_integration_connection_operations
       SET failure_classification = 'secret_finalize_failed',
           compensation_state = compensation_state || $3::jsonb,
           updated_at = now()
       WHERE org_id = $1 AND id = $2`,
      [
        reservation.permit.orgId,
        reservation.permit.operationId,
        JSON.stringify({
          secretFinalizeError: error instanceof Error ? error.message : "secret_finalize_failed",
          reservedCredentialBase: reservation.baseRef,
        }),
      ],
    );
    throw error;
  }
  return activateReservedLinkSql(client, reservation, credentialRef);
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
