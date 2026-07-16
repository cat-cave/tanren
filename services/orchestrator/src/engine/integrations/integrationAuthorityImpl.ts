import { randomUUID } from "node:crypto";
import { catalogOperation, integrationCatalogRevision, isKnownProviderKind } from "../contracts/integrationCatalog.js";
import {
  issueEligibleOperationLease,
  issuePrincipalVerificationPermit,
  type AuthorizeOperationInput,
  type AuthorizeOperationResult,
  type AuthorizePrincipalVerificationInput,
  IntegrationIdempotencyConflictError,
  type IntegrationAuthority,
  type SanitizedConnectionCandidate,
} from "../contracts/integrationAuthority.js";
import { integrationStagedSecretRef } from "../contracts/integrationSecretStore.js";
import type { IntegrationQueryClient } from "../repositories/integrationQuery.js";

function actorId(actor: { id?: string; label?: string; kind: string }): string {
  return actor.id ?? actor.label ?? actor.kind;
}

const ELIGIBILITY_SQL = `
SELECT
  c.id AS connection_id,
  c.provider_kind,
  c.provider_principal_id,
  c.display_name,
  c.principal_metadata,
  c.health AS connection_health,
  c.status AS connection_status,
  c.current_auth_generation,
  g.id AS grant_id,
  g.current_generation AS grant_current_generation,
  g.status AS grant_status,
  g.plane,
  g.environment,
  ag.credential_ref,
  ag.expires_at AS auth_expires_at,
  ag.status AS auth_status,
  gg.capabilities,
  gg.operations,
  gg.provider_scopes,
  gg.resource_constraints,
  gg.policy_revision,
  gg.consent_revision,
  gg.expires_at AS grant_expires_at,
  gg.status AS grant_generation_status,
  s.auth_generation AS selected_auth_generation,
  s.grant_generation AS selected_grant_generation,
  s.connection_id AS selected_connection_id,
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

type EligibilityRow = {
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

function asDate(value: Date | string | null | undefined): Date | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value : new Date(value);
}

function ineligibilityReasons(row: EligibilityRow, capability: string, operation: string, now: Date): string[] {
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
  return reasons;
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
    const operationId = randomUUID();
    await client.query(
      `INSERT INTO org_integration_connection_operations
         (org_id, id, provider_kind, connection_id, operation_kind, stage, status,
          idempotency_key, actor_id, request_fingerprint, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'created', 'pending', $6, $7, $8, now())
       ON CONFLICT (org_id, idempotency_key) DO NOTHING`,
      [
        input.orgId,
        operationId,
        input.providerKind,
        input.connectionId ?? null,
        input.operationKind,
        input.idempotencyKey,
        actorId(input.actor),
        input.requestFingerprint,
      ],
    );
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
      throw new Error("failed to create integration connection operation");
    }
    const expectedConnectionId = input.connectionId ?? null;
    if (
      row.provider_kind !== input.providerKind ||
      row.operation_kind !== input.operationKind ||
      (input.operationKind === "rotate" && row.connection_id !== expectedConnectionId) ||
      row.actor_id !== actorId(input.actor) ||
      row.request_fingerprint !== input.requestFingerprint
    ) {
      throw new IntegrationIdempotencyConflictError(
        "integration idempotency key is already bound to a different immutable request",
      );
    }
    return issuePrincipalVerificationPermit({
      orgId: input.orgId,
      providerKind: input.providerKind,
      operationId: row.id,
      actorId: actorId(input.actor),
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
    const result = await client.query(ELIGIBILITY_SQL, [input.orgId, input.projectId, input.providerKind]);
    const rows = result.rows as EligibilityRow[];
    if (rows.length === 0) return { status: "not_linked" };

    const now = new Date();
    const evaluated = rows.map((row) => {
      const reasons = ineligibilityReasons(row, input.capability, input.operation, now);
      return { row, reasons, selected: isSelectionTarget(row), eligible: reasons.length === 0 };
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
