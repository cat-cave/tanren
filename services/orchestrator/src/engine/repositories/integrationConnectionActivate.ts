import type { IntegrationQueryClient } from "./integrationQuery.js";
import type { FinalizeVerifiedLinkResult, LinkReservation } from "./integrationConnectionFinalize.js";
import {
  assertIdenticalAuthGeneration,
  assertIdenticalGrantGeneration,
} from "./integrationConnectionFinalizeAssert.js";

function isReactivation(reservation: LinkReservation): boolean {
  return reservation.operationKind === "link" && reservation.nextGeneration > 1;
}

async function assertConnection(
  client: IntegrationQueryClient,
  reservation: LinkReservation,
  expectedStatus: "active" | "revoked",
): Promise<void> {
  const result = await client.query(
    `SELECT provider_principal_id, principal_kind, status
     FROM org_integration_connections
     WHERE org_id = $1 AND provider_kind = $2 AND id = $3`,
    [reservation.permit.orgId, reservation.permit.providerKind, reservation.connectionId],
  );
  const row = result.rows[0] as { provider_principal_id: string; principal_kind: string; status: string } | undefined;
  if (
    row === undefined ||
    row.provider_principal_id !== reservation.principal.providerPrincipalId ||
    row.principal_kind !== reservation.principal.principalKind ||
    row.status !== expectedStatus
  ) {
    throw new Error("connection_immutable_conflict");
  }
}

async function ensureConnection(client: IntegrationQueryClient, reservation: LinkReservation): Promise<void> {
  if (reservation.operationKind === "link" && !isReactivation(reservation)) {
    await client.query(
      `INSERT INTO org_integration_connections
         (org_id, id, provider_kind, provider_principal_id, principal_kind, display_name,
          principal_metadata, health, status, current_auth_generation, owner_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'healthy', 'active', NULL, $8, now())
       ON CONFLICT DO NOTHING`,
      [
        reservation.permit.orgId,
        reservation.connectionId,
        reservation.permit.providerKind,
        reservation.principal.providerPrincipalId,
        reservation.principal.principalKind,
        reservation.principal.displayName,
        JSON.stringify(reservation.principal.metadata),
        reservation.permit.actorId,
      ],
    );
  }
  await assertConnection(client, reservation, isReactivation(reservation) ? "revoked" : "active");
}

async function ensureAuthGeneration(client: IntegrationQueryClient, reservation: LinkReservation): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO org_integration_connection_auth_generations
       (org_id, provider_kind, connection_id, generation, credential_ref, auth_kind, expires_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, 'active')
     ON CONFLICT (org_id, provider_kind, connection_id, generation) DO NOTHING
     RETURNING generation`,
    [
      reservation.permit.orgId,
      reservation.permit.providerKind,
      reservation.connectionId,
      reservation.nextGeneration,
      reservation.credentialRef,
      reservation.authKind,
      reservation.expiresAt ?? null,
    ],
  );
  if ((inserted.rowCount ?? 0) === 0) {
    await assertIdenticalAuthGeneration(client, {
      orgId: reservation.permit.orgId,
      providerKind: reservation.permit.providerKind,
      connectionId: reservation.connectionId,
      generation: reservation.nextGeneration,
      credentialRef: reservation.credentialRef,
      authKind: reservation.authKind,
      expiresAt: reservation.expiresAt,
    });
  }
}

async function ensureGrant(client: IntegrationQueryClient, reservation: LinkReservation): Promise<void> {
  if (reservation.operationKind === "link" && !isReactivation(reservation)) {
    await client.query(
      `INSERT INTO org_integration_grants
         (org_id, id, provider_kind, connection_id, plane, environment, current_generation, status, updated_at)
       VALUES ($1, $2, $3, $4, 'control', 'control', NULL, 'pending', now())
       ON CONFLICT DO NOTHING`,
      [reservation.permit.orgId, reservation.grantId, reservation.permit.providerKind, reservation.connectionId],
    );
  }
  const result = await client.query(
    `SELECT current_generation, status FROM org_integration_grants
     WHERE org_id = $1 AND provider_kind = $2 AND connection_id = $3 AND id = $4
       AND plane = 'control' AND environment = 'control'
     FOR UPDATE`,
    [reservation.permit.orgId, reservation.permit.providerKind, reservation.connectionId, reservation.grantId],
  );
  const row = result.rows[0] as { current_generation: number | null; status: string } | undefined;
  const expectedPrior = reservation.grantGeneration - 1;
  if (
    row === undefined ||
    (row.current_generation !== null &&
      row.current_generation !== expectedPrior &&
      row.current_generation !== reservation.grantGeneration) ||
    (isReactivation(reservation) ? row.status !== "revoked" : !["pending", "active"].includes(row.status))
  ) {
    throw new Error("grant_pointer_conflict");
  }
}

async function ensureGrantGeneration(client: IntegrationQueryClient, reservation: LinkReservation): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO org_integration_grant_generations
       (org_id, provider_kind, connection_id, grant_id, generation, capabilities, operations,
        provider_scopes, resource_constraints, policy_revision, consent_revision,
        consent_actor_id, consented_at, expires_at, status)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8::text[], '{}'::jsonb,
             $9, $10, $11, $12::timestamptz, $13::timestamptz, 'active')
     ON CONFLICT (org_id, provider_kind, connection_id, grant_id, generation) DO NOTHING
     RETURNING generation`,
    [
      reservation.permit.orgId,
      reservation.permit.providerKind,
      reservation.connectionId,
      reservation.grantId,
      reservation.grantGeneration,
      reservation.capabilities,
      reservation.operations,
      reservation.scopes,
      reservation.policyRevision,
      reservation.consentRevision,
      reservation.permit.actorId,
      reservation.consentedAt,
      reservation.expiresAt ?? null,
    ],
  );
  if ((inserted.rowCount ?? 0) === 0) {
    await assertIdenticalGrantGeneration(client, {
      orgId: reservation.permit.orgId,
      providerKind: reservation.permit.providerKind,
      connectionId: reservation.connectionId,
      grantId: reservation.grantId,
      generation: reservation.grantGeneration,
      capabilities: reservation.capabilities,
      operations: reservation.operations,
      scopes: reservation.scopes,
      policyRevision: reservation.policyRevision,
      consentRevision: reservation.consentRevision,
      consentActorId: reservation.permit.actorId,
      consentedAt: reservation.consentedAt,
      expiresAt: reservation.expiresAt,
    });
  }
}

async function flipPointers(client: IntegrationQueryClient, reservation: LinkReservation): Promise<void> {
  const priorAuth = reservation.nextGeneration - 1;
  const priorGrant = reservation.grantGeneration - 1;
  await client.query(
    `UPDATE org_integration_connection_auth_generations SET status = 'superseded'
     WHERE org_id = $1 AND provider_kind = $2 AND connection_id = $3
       AND generation < $4 AND status = 'active'`,
    [reservation.permit.orgId, reservation.permit.providerKind, reservation.connectionId, reservation.nextGeneration],
  );
  await client.query(
    `UPDATE org_integration_grant_generations SET status = 'superseded'
     WHERE org_id = $1 AND provider_kind = $2 AND connection_id = $3
       AND grant_id = $4 AND generation < $5 AND status = 'active'`,
    [
      reservation.permit.orgId,
      reservation.permit.providerKind,
      reservation.connectionId,
      reservation.grantId,
      reservation.grantGeneration,
    ],
  );
  const connection = await client.query(
    `UPDATE org_integration_connections
     SET display_name = $4, principal_metadata = $5::jsonb, health = 'healthy', status = 'active',
         current_auth_generation = $6, owner_id = $7, updated_at = now()
     WHERE org_id = $1 AND provider_kind = $2 AND id = $3
       AND (current_auth_generation IS NOT DISTINCT FROM $8 OR current_auth_generation = $6)
     RETURNING id`,
    [
      reservation.permit.orgId,
      reservation.permit.providerKind,
      reservation.connectionId,
      reservation.principal.displayName,
      JSON.stringify(reservation.principal.metadata),
      reservation.nextGeneration,
      reservation.permit.actorId,
      priorAuth === 0 ? null : priorAuth,
    ],
  );
  if ((connection.rowCount ?? 0) !== 1) throw new Error("connection_pointer_conflict");
  const grant = await client.query(
    `UPDATE org_integration_grants
     SET current_generation = $5, status = 'active', updated_at = now()
     WHERE org_id = $1 AND provider_kind = $2 AND connection_id = $3 AND id = $4
       AND (current_generation IS NOT DISTINCT FROM $6 OR current_generation = $5)
     RETURNING id`,
    [
      reservation.permit.orgId,
      reservation.permit.providerKind,
      reservation.connectionId,
      reservation.grantId,
      reservation.grantGeneration,
      priorGrant === 0 ? null : priorGrant,
    ],
  );
  if ((grant.rowCount ?? 0) !== 1) throw new Error("grant_pointer_conflict");
}

/** One short transaction: immutable rows, exact pointer flips, then terminal operation. */
export async function activateDurableReservationSql(
  client: IntegrationQueryClient,
  reservation: LinkReservation,
  credentialRef: string,
): Promise<FinalizeVerifiedLinkResult> {
  if (credentialRef !== reservation.credentialRef) throw new Error("operation_credential_coordinate_conflict");
  const owner = await client.query(
    `SELECT stage, status FROM org_integration_connection_operations
     WHERE org_id = $1 AND id = $2 AND reserved_connection_id = $3
       AND reserved_credential_ref = $4 AND target_auth_generation = $5
       AND target_grant_id = $6 AND target_grant_generation = $7
     FOR UPDATE`,
    [
      reservation.permit.orgId,
      reservation.permit.operationId,
      reservation.connectionId,
      credentialRef,
      reservation.nextGeneration,
      reservation.grantId,
      reservation.grantGeneration,
    ],
  );
  const operation = owner.rows[0] as { stage: string; status: string } | undefined;
  if (operation?.stage === "completed" && operation.status === "completed") return resultFrom(reservation);
  if (operation?.stage !== "activate_pending" || operation.status !== "in_progress") {
    throw new Error("operation_lost_reservation");
  }

  await ensureConnection(client, reservation);
  await ensureAuthGeneration(client, reservation);
  await ensureGrant(client, reservation);
  await ensureGrantGeneration(client, reservation);
  await flipPointers(client, reservation);

  const completed = await client.query(
    `UPDATE org_integration_connection_operations
     SET stage = 'completed', status = 'completed', connection_id = $3,
         completed_at = now(), updated_at = now(), failure_classification = NULL,
         compensation_state = compensation_state || '{"stagedCleanup":"pending"}'::jsonb
     WHERE org_id = $1 AND id = $2 AND stage = 'activate_pending' AND status = 'in_progress'
     RETURNING id`,
    [reservation.permit.orgId, reservation.permit.operationId, reservation.connectionId],
  );
  if ((completed.rowCount ?? 0) !== 1) throw new Error("operation_completion_conflict");
  return resultFrom(reservation);
}

function resultFrom(reservation: LinkReservation): FinalizeVerifiedLinkResult {
  return {
    connectionId: reservation.connectionId,
    grantId: reservation.grantId,
    providerPrincipalId: reservation.principal.providerPrincipalId,
    authGeneration: reservation.nextGeneration,
    grantGeneration: reservation.grantGeneration,
    displayName: reservation.principal.displayName,
  };
}
