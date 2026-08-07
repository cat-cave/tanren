import { randomUUID } from "node:crypto";
import { catalogOperation, integrationCatalogRevision, isKnownProviderKind } from "../contracts/integrationCatalog.js";
import {
  type AuthorizeOperationInput,
  type AuthorizeOperationResult,
  type AuthorizePrincipalVerificationInput,
  type EligibleOperationExpectation,
  type EligibleOperationLease,
  type IntegrationOperationTarget,
  type IntegrationPrivilegedOperation,
  type IntegrationResourceConstraints,
  IntegrationIdempotencyConflictError,
  IntegrationLegacyOperationNotFoundError,
  type IntegrationAuthority,
  type PrincipalVerificationPermit,
  type ResumePrincipalVerificationInput,
  type SanitizedConnectionCandidate,
} from "../contracts/integrationAuthority.js";
import { integrationStagedSecretRef } from "../contracts/integrationSecretStore.js";
import type { IntegrationQueryClient } from "../repositories/integrationQuery.js";
import { SENTRY_SAAS_ENDPOINT } from "./integrationOperationFingerprint.js";
import {
  integrationOperationTargetsEqual,
  normalizeIntegrationOperationTarget,
  parseIntegrationResourceConstraints,
} from "./integrationAuthorityValidation.js";
import {
  INTEGRATION_ELIGIBILITY_SQL,
  type IntegrationEligibilityRow as EligibilityRow,
} from "./integrationAuthorityEligibility.js";

function actorId(actor: { id?: string; label?: string; kind: string }): string {
  return actor.id ?? actor.label ?? actor.kind;
}

const authenticPrincipalPermits = new WeakSet();
const authenticOperationLeases = new WeakSet();
const OPERATION_LEASE_TTL_MS = 30_000;

function issuePrincipalVerificationPermit(fields: {
  orgId: string;
  providerKind: string;
  operationId: string;
  actorId: string;
  stagedSecretHandle: string;
}): PrincipalVerificationPermit {
  const permit = Object.freeze({ ...fields }) as PrincipalVerificationPermit;
  authenticPrincipalPermits.add(permit);
  return permit;
}

function issueEligibleOperationLease(fields: {
  orgId: string;
  projectId: string;
  providerKind: string;
  connectionId: string;
  grantId: string;
  authGeneration: number;
  grantGeneration: number;
  credentialRef: string;
  capability: string;
  operation: IntegrationPrivilegedOperation;
  target: IntegrationOperationTarget;
  resourceConstraints: IntegrationResourceConstraints;
  authorizedAt: string;
  expiresAt: string;
  providerPrincipalId: string;
  principalMetadata: Record<string, unknown>;
  policyRevision: string;
  consentRevision: string;
}): EligibleOperationLease {
  const constraints = Object.freeze({
    ...fields.resourceConstraints,
    resourceIds:
      fields.resourceConstraints.resourceIds === "*" ? "*" : Object.freeze([...fields.resourceConstraints.resourceIds]),
    environments:
      fields.resourceConstraints.environments === "*"
        ? "*"
        : Object.freeze([...fields.resourceConstraints.environments]),
  });
  const lease = Object.freeze({
    ...fields,
    target: Object.freeze({ ...fields.target }),
    resourceConstraints: constraints,
    principalMetadata: Object.freeze({ ...fields.principalMetadata }),
  }) as unknown as EligibleOperationLease;
  authenticOperationLeases.add(lease);
  return lease;
}

export function assertPrincipalVerificationPermit(
  value: PrincipalVerificationPermit,
): asserts value is PrincipalVerificationPermit {
  if (typeof value !== "object" || value === null || !authenticPrincipalPermits.has(value)) {
    throw new Error("invalid principal verification permit");
  }
}

/** Validate authenticity, freshness, and every exact operation binding before I/O. */
export function assertEligibleOperationLease(
  value: EligibleOperationLease,
  expected: EligibleOperationExpectation,
  now = new Date(),
): asserts value is EligibleOperationLease {
  if (typeof value !== "object" || value === null || !authenticOperationLeases.has(value)) {
    throw new Error("invalid eligible operation lease");
  }
  if (new Date(value.expiresAt).getTime() <= now.getTime()) {
    throw new Error("eligible operation lease expired");
  }
  if (
    value.orgId !== expected.orgId ||
    value.projectId !== expected.projectId ||
    value.providerKind !== expected.providerKind ||
    value.capability !== expected.capability ||
    value.operation !== expected.operation ||
    !integrationOperationTargetsEqual(value.target, expected.target)
  ) {
    throw new Error("eligible operation lease binding mismatch");
  }
}

function asDate(value: Date | string | null | undefined): Date | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value : new Date(value);
}

function ineligibilityReasons(
  row: EligibilityRow,
  capability: string,
  operation: string,
  target: IntegrationOperationTarget,
  now: Date,
): { reasons: string[]; constraints?: IntegrationResourceConstraints } {
  const reasons: string[] = [];
  if (row.connection_status !== "active") reasons.push("connection_not_active");
  if (row.connection_health === "invalid" || row.connection_health === "degraded") {
    reasons.push(`connection_health_${row.connection_health}`);
  }
  if (row.current_auth_generation === null) reasons.push("auth_generation_missing");
  if (row.auth_status !== "active") reasons.push("auth_generation_not_active");
  const authExpires = asDate(row.auth_expires_at);
  if (authExpires !== undefined && authExpires.getTime() <= now.getTime()) {
    reasons.push("auth_expired");
  }
  if (row.grant_status !== "active") reasons.push("grant_not_active");
  if (row.grant_current_generation === null) reasons.push("grant_generation_missing");
  if (row.grant_generation_status !== "active") reasons.push("grant_generation_not_active");
  const grantExpires = asDate(row.grant_expires_at);
  if (grantExpires !== undefined && grantExpires.getTime() <= now.getTime()) {
    reasons.push("grant_expired");
  }
  const capabilities = row.capabilities ?? [];
  if (!capabilities.includes(capability)) reasons.push("missing_capability");
  const operations = row.operations ?? [];
  if (!operations.includes(operation)) reasons.push("missing_operation");
  const catalogOp = catalogOperation(row.provider_kind, capability, operation);
  if (catalogOp === undefined) {
    reasons.push("unknown_catalog_operation");
  } else {
    const scopes = new Set(row.provider_scopes ?? []);
    for (const scope of catalogOp.requiredScopes) {
      if (!scopes.has(scope)) reasons.push(`missing_scope:${scope}`);
    }
  }
  if (row.policy_revision !== integrationCatalogRevision()) {
    reasons.push("stale_policy_revision");
  }
  if (row.consent_revision === null || row.consent_revision === "") {
    reasons.push("missing_consent_revision");
  }
  if (row.credential_ref === null || row.credential_ref === "") {
    reasons.push("credential_ref_missing");
  }
  const constraints = parseIntegrationResourceConstraints(row.resource_constraints);
  if (constraints === undefined) {
    reasons.push("unsupported_resource_constraints");
  } else {
    if (
      target.resourceId !== undefined &&
      constraints.resourceIds !== "*" &&
      !constraints.resourceIds.includes(target.resourceId)
    ) {
      reasons.push("resource_not_allowed");
    }
    if (
      target.environment !== undefined &&
      constraints.environments !== "*" &&
      !constraints.environments.includes(target.environment)
    ) {
      reasons.push("environment_not_allowed");
    }
  }
  return { reasons, ...(constraints === undefined ? {} : { constraints }) };
}

function isSelectionTarget(row: EligibilityRow): boolean {
  return row.selected_connection_id === row.connection_id && row.selected_grant_id === row.grant_id;
}

function isExactSelection(row: EligibilityRow): boolean {
  return (
    isSelectionTarget(row) &&
    row.selected_auth_generation === row.current_auth_generation &&
    row.selected_grant_generation === row.grant_current_generation
  );
}

function toCandidate(row: EligibilityRow, reasons: string[]): SanitizedConnectionCandidate {
  return {
    connectionId: row.connection_id,
    grantId: row.grant_id,
    providerKind: row.provider_kind,
    providerPrincipalId: row.provider_principal_id,
    displayName: row.display_name,
    health: row.connection_health,
    authGeneration: row.current_auth_generation ?? 0,
    grantGeneration: row.grant_current_generation ?? 0,
    ineligibilityReasons: reasons,
  };
}

export class PgIntegrationAuthority implements IntegrationAuthority {
  async authorizePrincipalVerification(client: IntegrationQueryClient, input: AuthorizePrincipalVerificationInput) {
    if (!isKnownProviderKind(input.providerKind)) {
      throw new Error(`unknown provider kind '${input.providerKind}'`);
    }
    if (input.operationKind === "rotate" && (input.connectionId === undefined || input.connectionId === "")) {
      throw new Error("rotate requires connectionId");
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(input.requestFingerprint)) {
      throw new TypeError("integration request fingerprint must be sha256");
    }
    if (
      input.legacyRequestFingerprint !== undefined &&
      !/^sha256:[0-9a-f]{64}$/u.test(input.legacyRequestFingerprint)
    ) {
      throw new TypeError("legacy integration request fingerprint must be sha256");
    }
    const legacyRetryWithoutEndpoint = input.legacyRetryOnly === true;
    const canMigrateLegacy =
      input.providerKind === "sentry" &&
      input.providerEndpoint === SENTRY_SAAS_ENDPOINT &&
      input.legacyRequestFingerprint !== undefined &&
      input.legacyRequestFingerprint !== input.requestFingerprint;
    if (legacyRetryWithoutEndpoint && input.providerKind !== "sentry") {
      throw new Error("legacy integration retry is restricted to Sentry");
    }
    if (legacyRetryWithoutEndpoint && !canMigrateLegacy) {
      throw new Error("endpoint-less legacy retry requires Sentry SaaS v2 compatibility");
    }
    if (input.legacyRequestFingerprint !== undefined && !canMigrateLegacy) {
      throw new Error("legacy integration fingerprint migration is restricted to Sentry SaaS v2 requests");
    }
    if (!input.legacyRetryOnly) {
      await client.query(
        `INSERT INTO org_integration_connection_operations
           (org_id, id, provider_kind, connection_id, operation_kind, stage, status,
            idempotency_key, actor_id, request_fingerprint, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'created', 'pending', $6, $7, $8, now())
         ON CONFLICT (org_id, idempotency_key) DO NOTHING`,
        [
          input.orgId,
          randomUUID(),
          input.providerKind,
          input.connectionId ?? null,
          input.operationKind,
          input.idempotencyKey,
          actorId(input.actor),
          input.requestFingerprint,
        ],
      );
    }
    const result = await client.query(
      `SELECT id, provider_kind, connection_id, operation_kind, stage, status,
              staged_secret_handle, actor_id, request_fingerprint
       FROM org_integration_connection_operations
       WHERE org_id = $1 AND idempotency_key = $2`,
      [input.orgId, input.idempotencyKey],
    );
    const row = result.rows[0] as
      | {
          id: string;
          provider_kind: string;
          stage: string;
          status: string;
          staged_secret_handle: string | null;
          connection_id: string | null;
          operation_kind: string;
          actor_id: string;
          request_fingerprint: string;
        }
      | undefined;
    if (row === undefined) {
      if (input.legacyRetryOnly) {
        throw new IntegrationLegacyOperationNotFoundError("legacy integration operation not found");
      }
      throw new Error("failed to create integration connection operation");
    }
    const expectedConnectionId = input.connectionId ?? null;
    if (
      row.provider_kind !== input.providerKind ||
      row.operation_kind !== input.operationKind ||
      (input.operationKind === "rotate" && row.connection_id !== expectedConnectionId) ||
      row.actor_id !== actorId(input.actor)
    ) {
      throw new IntegrationIdempotencyConflictError(
        "integration idempotency key is already bound to a different immutable request",
      );
    }
    const isLegacyRow = canMigrateLegacy && row.request_fingerprint === input.legacyRequestFingerprint;
    if (row.request_fingerprint !== input.requestFingerprint && !isLegacyRow) {
      throw new IntegrationIdempotencyConflictError(
        "integration idempotency key is already bound to a different immutable request",
      );
    }
    if (isLegacyRow) {
      const migrated = await client.query(
        `UPDATE org_integration_connection_operations
         SET request_fingerprint = $1, updated_at = now()
         WHERE org_id = $2 AND id = $3 AND request_fingerprint = $4
         RETURNING request_fingerprint`,
        [input.requestFingerprint, input.orgId, row.id, input.legacyRequestFingerprint],
      );
      if ((migrated.rowCount ?? migrated.rows.length) === 0) {
        const current = await client.query(
          `SELECT request_fingerprint
           FROM org_integration_connection_operations
           WHERE org_id = $1 AND idempotency_key = $2`,
          [input.orgId, input.idempotencyKey],
        );
        if (
          (current.rows[0] as { request_fingerprint?: unknown } | undefined)?.request_fingerprint !==
          input.requestFingerprint
        ) {
          throw new IntegrationIdempotencyConflictError(
            "integration idempotency key is already bound to a different immutable request",
          );
        }
      }
    }
    return issuePrincipalVerificationPermit({
      orgId: input.orgId,
      providerKind: input.providerKind,
      operationId: row.id,
      actorId: actorId(input.actor),
      stagedSecretHandle: row.staged_secret_handle ?? integrationStagedSecretRef(row.id),
    });
  }

  async resumePrincipalVerification(
    client: IntegrationQueryClient,
    input: ResumePrincipalVerificationInput,
  ): Promise<PrincipalVerificationPermit> {
    const result = await client.query(
      `SELECT org_id, id, provider_kind, actor_id, staged_secret_handle, stage, status
       FROM org_integration_connection_operations
       WHERE org_id = $1 AND id = $2`,
      [input.orgId, input.operationId],
    );
    const row = result.rows[0] as
      | {
          org_id: string;
          id: string;
          provider_kind: string;
          actor_id: string;
          staged_secret_handle: string | null;
          stage: string;
          status: string;
        }
      | undefined;
    if (row === undefined) throw new Error("integration operation not found");
    if (row.org_id !== input.orgId || row.id !== input.operationId) {
      throw new Error("integration operation identity mismatch");
    }
    if (!isKnownProviderKind(row.provider_kind)) throw new Error("integration operation provider is unknown");
    if (["failed", "compensated"].includes(row.status)) {
      throw new Error("integration operation is terminal and cannot resume verification");
    }
    if (
      ![
        "credential_staged",
        "verifying",
        "awaiting_principal_selection",
        "finalizing",
        "activate_pending",
        "completed",
      ].includes(row.stage)
    ) {
      throw new Error("integration operation stage cannot resume verification");
    }
    return issuePrincipalVerificationPermit({
      orgId: input.orgId,
      providerKind: row.provider_kind,
      operationId: row.id,
      actorId: row.actor_id,
      stagedSecretHandle: row.staged_secret_handle ?? integrationStagedSecretRef(row.id),
    });
  }

  async authorizeOperation(
    client: IntegrationQueryClient,
    input: AuthorizeOperationInput,
  ): Promise<AuthorizeOperationResult> {
    if (!isKnownProviderKind(input.providerKind)) {
      return { status: "ineligible", reasons: ["unknown_provider_kind"] };
    }
    if (catalogOperation(input.providerKind, input.capability, input.operation) === undefined) {
      return { status: "ineligible", reasons: ["unknown_catalog_operation"] };
    }
    const target = normalizeIntegrationOperationTarget(input.operation, input.target);
    if (target === undefined) {
      return { status: "ineligible", reasons: ["invalid_operation_target"] };
    }
    const result = await client.query(INTEGRATION_ELIGIBILITY_SQL, [input.orgId, input.projectId, input.providerKind]);
    const rows = result.rows as EligibilityRow[];
    if (rows.length === 0) return { status: "not_linked" };

    const now = new Date();
    const evaluated = rows.map((row) => {
      const evaluation = ineligibilityReasons(row, input.capability, input.operation, target, now);
      return {
        row,
        reasons: evaluation.reasons,
        constraints: evaluation.constraints,
        selected: isSelectionTarget(row),
        eligible: evaluation.reasons.length === 0,
      };
    });

    const selected = evaluated.find((item) => item.selected);
    const selectionExists = evaluated.some((item) => item.row.selected_connection_id !== null);
    if (selectionExists && selected === undefined) {
      return {
        status: "selection_required",
        reason: "selected_grant_unavailable",
        candidates: evaluated.map((item) => toCandidate(item.row, [...item.reasons, "selected_grant_missing"])),
      };
    }
    if (selected !== undefined) {
      const staleGeneration = !isExactSelection(selected.row);
      if (!selected.eligible || staleGeneration) {
        return {
          status: "selection_required",
          reason: "selected_grant_unavailable",
          candidates: [
            toCandidate(
              selected.row,
              staleGeneration ? [...selected.reasons, "selected_generation_stale"] : selected.reasons,
            ),
          ],
        };
      }
      return {
        status: "eligible",
        lease: issueEligibleOperationLease({
          orgId: input.orgId,
          projectId: input.projectId,
          providerKind: selected.row.provider_kind,
          connectionId: selected.row.connection_id,
          grantId: selected.row.grant_id,
          authGeneration: selected.row.current_auth_generation!,
          grantGeneration: selected.row.grant_current_generation!,
          credentialRef: selected.row.credential_ref!,
          capability: input.capability,
          operation: input.operation,
          target,
          resourceConstraints: selected.constraints!,
          authorizedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + OPERATION_LEASE_TTL_MS).toISOString(),
          providerPrincipalId: selected.row.provider_principal_id,
          principalMetadata: selected.row.principal_metadata ?? {},
          policyRevision: selected.row.policy_revision!,
          consentRevision: selected.row.consent_revision!,
        }),
      };
    }

    const eligible = evaluated.filter((item) => item.eligible);
    if (eligible.length === 0) {
      return {
        status: "ineligible",
        reasons: [...new Set(evaluated.flatMap((item) => item.reasons))],
      };
    }
    if (eligible.length > 1) {
      return {
        status: "selection_required",
        reason: "multiple_eligible",
        candidates: eligible.map((item) => toCandidate(item.row, [])),
      };
    }
    return {
      status: "selection_required",
      reason: "selection_missing",
      candidates: eligible.map((item) => toCandidate(item.row, [])),
    };
  }
}
