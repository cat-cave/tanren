import { randomUUID } from "node:crypto";
import {
  catalogCapabilitiesForProvider,
  catalogEntry,
  integrationCatalogRevision,
} from "../contracts/integrationCatalog.js";
import type { PrincipalCandidate, PrincipalVerificationPermit } from "../contracts/integrationAuthority.js";
import { assertPrincipalVerificationPermit } from "../integrations/integrationAuthorityImpl.js";
import {
  connectionCredentialBaseRef,
  generationSecretRef,
  type IntegrationSecretStore,
  type StagedSecretHandle,
} from "../contracts/integrationSecretStore.js";
import { principalVerificationFingerprint } from "../integrations/integrationOperationFingerprint.js";
import type { IntegrationQueryClient } from "./integrationQuery.js";
import { loadCompletedLinkResult } from "./integrationConnectionFinalizeResult.js";

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

declare const linkReservationBrand: unique symbol;

interface LinkReservationFields {
  readonly operationKind: "link" | "rotate";
  readonly connectionId: string;
  readonly nextGeneration: number;
  readonly baseRef: string;
  readonly credentialRef: string;
  readonly grantId: string;
  readonly grantGeneration: number;
  readonly principal: PrincipalCandidate;
  readonly permit: PrincipalVerificationPermit;
  readonly authKind: string;
  readonly scopes: string[];
  readonly expiresAt?: string;
  readonly capabilities: string[];
  readonly operations: string[];
  readonly policyRevision: string;
  readonly consentRevision: string;
  readonly consentedAt: string;
}

export interface LinkReservation extends LinkReservationFields {
  readonly [linkReservationBrand]: true;
}

const authenticLinkReservations = new WeakSet();

function issueLinkReservation(fields: LinkReservationFields): LinkReservation {
  const reservation = Object.freeze({
    ...fields,
    principal: Object.freeze({
      ...fields.principal,
      metadata: Object.freeze({ ...fields.principal.metadata }),
    }),
    scopes: Object.freeze([...fields.scopes]),
    capabilities: Object.freeze([...fields.capabilities]),
    operations: Object.freeze([...fields.operations]),
  }) as unknown as LinkReservation;
  authenticLinkReservations.add(reservation);
  return reservation;
}

export function assertLinkReservation(value: LinkReservation): asserts value is LinkReservation {
  if (typeof value !== "object" || value === null || !authenticLinkReservations.has(value)) {
    throw new Error("invalid link reservation");
  }
  assertPrincipalVerificationPermit(value.permit);
  const expectedBase = connectionCredentialBaseRef(value.permit.orgId, value.permit.providerKind, value.connectionId);
  if (
    value.baseRef !== expectedBase ||
    value.credentialRef !== generationSecretRef(expectedBase, value.nextGeneration)
  ) {
    throw new Error("operation_credential_coordinate_conflict");
  }
}

type OperationRow = {
  id: string;
  provider_kind: string;
  connection_id: string | null;
  operation_kind: "link" | "rotate";
  stage: string;
  status: string;
  actor_id: string;
  staged_secret_handle: string | null;
  verification_fingerprint: string | null;
  verified_principal: PrincipalCandidate | null;
  verified_auth_kind: string | null;
  verified_scopes: string[] | null;
  verified_expires_at: Date | string | null;
  reserved_connection_id: string | null;
  reserved_credential_ref: string | null;
  target_auth_generation: number | null;
  target_grant_id: string | null;
  target_grant_generation: number | null;
  reserved_capabilities: string[] | null;
  reserved_operations: string[] | null;
  reserved_policy_revision: string | null;
  reserved_consent_revision: string | null;
  reserved_consented_at: Date | string | null;
  created_at: Date | string;
};

const OPERATION_COLUMNS = `
  id, provider_kind, connection_id, operation_kind, stage, status, actor_id,
  staged_secret_handle, verification_fingerprint, verified_principal,
  verified_auth_kind, verified_scopes, verified_expires_at,
  reserved_connection_id, reserved_credential_ref, target_auth_generation,
  target_grant_id, target_grant_generation, reserved_capabilities,
  reserved_operations, reserved_policy_revision, reserved_consent_revision,
  reserved_consented_at, created_at`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function consentRevisionFor(operationId: string, actorId: string): string {
  return `consent.${actorId}.${operationId}`;
}

function catalogOperations(providerKind: string): string[] {
  return [
    ...new Set(
      (catalogEntry(providerKind)?.capabilities ?? []).flatMap((capability) =>
        capability.operations.map((operation) => operation.id),
      ),
    ),
  ].sort();
}

function assertOperationIdentity(row: OperationRow, permit: PrincipalVerificationPermit): void {
  if (row.provider_kind !== permit.providerKind || row.actor_id !== permit.actorId) {
    throw new Error("operation_immutable_conflict");
  }
}

function reservationFromRow(row: OperationRow, permit: PrincipalVerificationPermit): LinkReservation {
  if (
    row.verification_fingerprint === null ||
    row.verified_principal === null ||
    row.verified_auth_kind === null ||
    row.verified_scopes === null ||
    row.reserved_connection_id === null ||
    row.reserved_credential_ref === null ||
    row.target_auth_generation === null ||
    row.target_grant_id === null ||
    row.target_grant_generation === null ||
    row.reserved_capabilities === null ||
    row.reserved_operations === null ||
    row.reserved_policy_revision === null ||
    row.reserved_consent_revision === null ||
    row.reserved_consented_at === null
  ) {
    throw new Error("operation_reservation_incomplete");
  }
  const baseRef = row.reserved_credential_ref.replace(/\/g\/\d+$/u, "");
  if (generationSecretRef(baseRef, row.target_auth_generation) !== row.reserved_credential_ref) {
    throw new Error("operation_credential_coordinate_conflict");
  }
  return issueLinkReservation({
    operationKind: row.operation_kind,
    connectionId: row.reserved_connection_id,
    nextGeneration: row.target_auth_generation,
    baseRef,
    credentialRef: row.reserved_credential_ref,
    grantId: row.target_grant_id,
    grantGeneration: row.target_grant_generation,
    principal: row.verified_principal,
    permit,
    authKind: row.verified_auth_kind,
    scopes: row.verified_scopes,
    ...(row.verified_expires_at === null ? {} : { expiresAt: iso(row.verified_expires_at) }),
    capabilities: row.reserved_capabilities,
    operations: row.reserved_operations,
    policyRevision: row.reserved_policy_revision,
    consentRevision: row.reserved_consent_revision,
    consentedAt: iso(row.reserved_consented_at),
  });
}

async function operationForUpdate(
  client: IntegrationQueryClient,
  permit: PrincipalVerificationPermit,
): Promise<OperationRow> {
  // Authenticate the opaque permit before its coordinates can influence even a
  // database read. Callers cannot reach finalization with a structurally similar
  // object that merely happens to name a real operation.
  assertPrincipalVerificationPermit(permit);
  const result = await client.query(
    `SELECT ${OPERATION_COLUMNS}
     FROM org_integration_connection_operations
     WHERE org_id = $1 AND id = $2
     FOR UPDATE`,
    [permit.orgId, permit.operationId],
  );
  const row = result.rows[0] as OperationRow | undefined;
  if (row === undefined) throw new Error("operation_missing");
  assertOperationIdentity(row, permit);
  return row;
}

/** Load a reservation after process death without staging or provider verification. */
export async function loadDurableLinkStateSql(
  client: IntegrationQueryClient,
  permit: PrincipalVerificationPermit,
): Promise<LinkReservation | FinalizeVerifiedLinkResult | undefined> {
  const row = await operationForUpdate(client, permit);
  if (row.status === "failed" || row.status === "compensated") {
    throw new Error(`operation_terminal_${row.status}`);
  }
  if (!["finalizing", "activate_pending", "completed"].includes(row.stage)) return undefined;
  const reservation = reservationFromRow(row, permit);
  if (row.stage === "completed" && row.status === "completed") {
    return loadCompletedLinkResult(client, reservation);
  }
  return reservation;
}

/** Phase 1: persist the exact verified reservation; no connection shell is inserted. */
export async function reserveVerifiedLinkSql(
  client: IntegrationQueryClient,
  input: FinalizeVerifiedLinkInput,
): Promise<LinkReservation | FinalizeVerifiedLinkResult> {
  const row = await operationForUpdate(client, input.permit);
  const verificationFingerprint = principalVerificationFingerprint(input);
  if (row.verification_fingerprint !== null) {
    if (row.verification_fingerprint !== verificationFingerprint) {
      throw new Error("principal_verification_immutable_conflict");
    }
    const reservation = reservationFromRow(row, input.permit);
    return row.stage === "completed" && row.status === "completed"
      ? loadCompletedLinkResult(client, reservation)
      : reservation;
  }
  if (row.status === "failed" || row.status === "compensated") {
    throw new Error(`operation_terminal_${row.status}`);
  }
  if (row.staged_secret_handle !== input.staged.handle) throw new Error("operation_staged_handle_conflict");

  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
    `${input.permit.orgId}:${input.permit.providerKind}`,
    input.principal.providerPrincipalId,
  ]);
  const competing = await client.query(
    `SELECT id FROM org_integration_connection_operations
     WHERE org_id = $1 AND provider_kind = $2 AND selected_principal_id = $3
       AND status = 'in_progress' AND id <> $4
     LIMIT 1`,
    [input.permit.orgId, input.permit.providerKind, input.principal.providerPrincipalId, input.permit.operationId],
  );
  if ((competing.rowCount ?? 0) > 0) throw new Error("principal_reservation_in_progress");

  const target =
    row.operation_kind === "rotate"
      ? await reserveRotationTarget(client, row, input)
      : await reserveLinkTarget(client, input);
  const scopes = [...new Set(input.scopes)].sort();
  const capabilities = [...catalogCapabilitiesForProvider(input.permit.providerKind)].sort();
  const operations = catalogOperations(input.permit.providerKind);
  const policyRevision = integrationCatalogRevision();
  const consentRevision = consentRevisionFor(row.id, row.actor_id);
  const consentedAt = iso(row.created_at);
  const baseRef = connectionCredentialBaseRef(input.permit.orgId, input.permit.providerKind, target.connectionId);
  const credentialRef = generationSecretRef(baseRef, target.authGeneration);

  const updated = await client.query(
    `UPDATE org_integration_connection_operations
     SET stage = 'finalizing', status = 'in_progress',
         verification_fingerprint = $3, verified_principal = $4::jsonb,
         verified_auth_kind = $5, verified_scopes = $6::text[], verified_expires_at = $7::timestamptz,
         selected_principal_id = $8, reserved_connection_id = $9,
         reserved_credential_ref = $10, target_auth_generation = $11,
         target_grant_id = $12, target_grant_generation = $13,
         reserved_capabilities = $14::text[], reserved_operations = $15::text[],
         reserved_policy_revision = $16, reserved_consent_revision = $17,
         reserved_consented_at = $18::timestamptz, updated_at = now()
     WHERE org_id = $1 AND id = $2 AND verification_fingerprint IS NULL
       AND stage IN ('credential_staged','verifying','awaiting_principal_selection')
     RETURNING id`,
    [
      input.permit.orgId,
      input.permit.operationId,
      verificationFingerprint,
      JSON.stringify(input.principal),
      input.authKind,
      scopes,
      input.expiresAt ?? null,
      input.principal.providerPrincipalId,
      target.connectionId,
      credentialRef,
      target.authGeneration,
      target.grantId,
      target.grantGeneration,
      capabilities,
      operations,
      policyRevision,
      consentRevision,
      consentedAt,
    ],
  );
  if ((updated.rowCount ?? 0) !== 1) throw new Error("operation_reservation_conflict");
  return issueLinkReservation({
    operationKind: row.operation_kind,
    connectionId: target.connectionId,
    nextGeneration: target.authGeneration,
    baseRef,
    credentialRef,
    grantId: target.grantId,
    grantGeneration: target.grantGeneration,
    principal: input.principal,
    permit: input.permit,
    authKind: input.authKind,
    scopes,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    capabilities,
    operations,
    policyRevision,
    consentRevision,
    consentedAt,
  });
}

async function reserveLinkTarget(client: IntegrationQueryClient, input: FinalizeVerifiedLinkInput) {
  const existing = await client.query(
    `SELECT id, current_auth_generation, status FROM org_integration_connections
     WHERE org_id = $1 AND provider_kind = $2 AND provider_principal_id = $3
     FOR UPDATE`,
    [input.permit.orgId, input.permit.providerKind, input.principal.providerPrincipalId],
  );
  const connection = existing.rows[0] as
    | { id: string; current_auth_generation: number | null; status: string }
    | undefined;
  if (connection === undefined) {
    return { connectionId: randomUUID(), authGeneration: 1, grantId: randomUUID(), grantGeneration: 1 };
  }
  if (connection.status === "active") throw new Error("principal_already_linked");
  if (connection.status !== "revoked" || connection.current_auth_generation === null) {
    throw new Error("revoked_connection_generation_missing");
  }
  const grantResult = await client.query(
    `SELECT id, current_generation, status FROM org_integration_grants
     WHERE org_id = $1 AND provider_kind = $2 AND connection_id = $3
       AND plane = 'control' AND environment = 'control'
     FOR UPDATE`,
    [input.permit.orgId, input.permit.providerKind, connection.id],
  );
  const grant = grantResult.rows[0] as { id: string; current_generation: number | null; status: string } | undefined;
  if (grant?.status !== "revoked" || grant.current_generation === null) {
    throw new Error("revoked_grant_generation_missing");
  }
  return {
    connectionId: connection.id,
    authGeneration: connection.current_auth_generation + 1,
    grantId: grant.id,
    grantGeneration: grant.current_generation + 1,
  };
}

async function reserveRotationTarget(
  client: IntegrationQueryClient,
  row: OperationRow,
  input: FinalizeVerifiedLinkInput,
) {
  if (row.connection_id === null) throw new Error("rotate_connection_missing");
  const connectionResult = await client.query(
    `SELECT id, provider_principal_id, current_auth_generation
     FROM org_integration_connections
     WHERE org_id = $1 AND provider_kind = $2 AND id = $3 AND status = 'active'
     FOR UPDATE`,
    [input.permit.orgId, input.permit.providerKind, row.connection_id],
  );
  const connection = connectionResult.rows[0] as
    | { id: string; provider_principal_id: string; current_auth_generation: number | null }
    | undefined;
  if (connection?.current_auth_generation === null || connection === undefined)
    throw new Error("rotate_connection_inactive");
  if (connection.provider_principal_id !== input.principal.providerPrincipalId) {
    throw new Error("rotate_principal_mismatch");
  }
  const grantResult = await client.query(
    `SELECT id, current_generation FROM org_integration_grants
     WHERE org_id = $1 AND provider_kind = $2 AND connection_id = $3
       AND plane = 'control' AND environment = 'control' AND status = 'active'
     FOR UPDATE`,
    [input.permit.orgId, input.permit.providerKind, row.connection_id],
  );
  const grant = grantResult.rows[0] as { id: string; current_generation: number | null } | undefined;
  if (grant?.current_generation === null || grant === undefined) throw new Error("rotate_grant_inactive");
  return {
    connectionId: connection.id,
    authGeneration: connection.current_auth_generation + 1,
    grantId: grant.id,
    grantGeneration: grant.current_generation + 1,
  };
}

/** Phase 2: Vault CAS outside SQL. Staged bytes remain until activation commits. */
export async function finalizeReservedSecret(
  secrets: IntegrationSecretStore,
  reservation: LinkReservation,
  staged: StagedSecretHandle,
): Promise<string> {
  assertLinkReservation(reservation);
  if (
    staged.operationId !== reservation.permit.operationId ||
    staged.handle !== reservation.permit.stagedSecretHandle
  ) {
    throw new Error("operation_staged_handle_conflict");
  }
  const finalized = await secrets.finalize(staged, reservation.baseRef, reservation.nextGeneration);
  if (finalized.ref !== reservation.credentialRef || finalized.generation !== reservation.nextGeneration) {
    throw new Error("secret_store_coordinate_conflict");
  }
  return finalized.ref;
}

/** Persist confirmed Vault success before attempting the activation transaction. */
export async function markReservationActivatePendingSql(
  client: IntegrationQueryClient,
  reservation: LinkReservation,
  credentialRef: string,
): Promise<void> {
  assertLinkReservation(reservation);
  if (credentialRef !== reservation.credentialRef) throw new Error("operation_credential_coordinate_conflict");
  const updated = await client.query(
    `UPDATE org_integration_connection_operations
     SET stage = 'activate_pending', failure_classification = NULL, updated_at = now()
     WHERE org_id = $1 AND id = $2 AND stage = 'finalizing' AND status = 'in_progress'
       AND reserved_connection_id = $3 AND reserved_credential_ref = $4
       AND target_auth_generation = $5 AND target_grant_id = $6 AND target_grant_generation = $7
     RETURNING id`,
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
  if ((updated.rowCount ?? 0) === 1) return;
  const state = await client.query(
    `SELECT stage, status, reserved_credential_ref
     FROM org_integration_connection_operations WHERE org_id = $1 AND id = $2`,
    [reservation.permit.orgId, reservation.permit.operationId],
  );
  const row = state.rows[0] as { stage: string; status: string; reserved_credential_ref: string | null } | undefined;
  if (row?.reserved_credential_ref === credentialRef && ["activate_pending", "completed"].includes(row.stage)) return;
  throw new Error("operation_activate_pending_conflict");
}

export async function activateReservedLinkSql(
  client: IntegrationQueryClient,
  reservation: LinkReservation,
  credentialRef: string,
): Promise<FinalizeVerifiedLinkResult> {
  assertLinkReservation(reservation);
  const { activateDurableReservationSql } = await import("./integrationConnectionActivate.js");
  return activateDurableReservationSql(client, reservation, credentialRef);
}

export async function markStagedCleanupCompleteSql(
  client: IntegrationQueryClient,
  permit: PrincipalVerificationPermit,
): Promise<void> {
  assertPrincipalVerificationPermit(permit);
  await client.query(
    `UPDATE org_integration_connection_operations
     SET staged_secret_handle = NULL,
         compensation_state = compensation_state || '{"stagedCleanup":"completed"}'::jsonb,
         updated_at = now()
     WHERE org_id = $1 AND id = $2
       AND ((stage = 'completed' AND status = 'completed') OR (stage = 'failed' AND status = 'failed'))`,
    [permit.orgId, permit.operationId],
  );
}
