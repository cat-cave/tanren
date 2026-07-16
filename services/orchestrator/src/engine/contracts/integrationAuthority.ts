/**
 * IntegrationAuthority — sole entry before normal integration secret reads or
 * provider construction. Opaque branded permits prevent naked grant/secret use.
 */

import type { IntegrationQueryClient } from "../repositories/integrationQuery.js";
import type { ActorRef } from "../state/actor.js";

export const PRINCIPAL_VERIFICATION_PERMIT = Symbol("PrincipalVerificationPermit");
export const ELIGIBLE_OPERATION_LEASE = Symbol("EligibleOperationLease");

export interface PrincipalCandidate {
  providerPrincipalId: string;
  principalKind: "team" | "organization" | "user";
  displayName: string;
  metadata: Record<string, string>;
}

export interface PrincipalVerificationPermit {
  readonly [PRINCIPAL_VERIFICATION_PERMIT]: true;
  readonly orgId: string;
  readonly providerKind: string;
  readonly operationId: string;
  readonly actorId: string;
  readonly stagedSecretHandle: string;
}

export interface EligibleOperationLease {
  readonly [ELIGIBLE_OPERATION_LEASE]: true;
  readonly orgId: string;
  readonly projectId: string;
  readonly providerKind: string;
  readonly connectionId: string;
  readonly grantId: string;
  readonly authGeneration: number;
  readonly grantGeneration: number;
  readonly credentialRef: string;
  readonly capability: string;
  readonly operation: string;
  readonly providerPrincipalId: string;
  readonly principalMetadata: Record<string, unknown>;
  readonly policyRevision: string;
  readonly consentRevision: string;
}

export type AuthorizePrincipalVerificationInput = {
  orgId: string;
  providerKind: string;
  operationKind: "link" | "rotate";
  idempotencyKey: string;
  connectionId?: string;
  /** Digest binding the idempotency key to actor, target, and credential bytes. */
  requestFingerprint: string;
  actor: ActorRef;
};

export class IntegrationIdempotencyConflictError extends Error {
  public override readonly name = "IntegrationIdempotencyConflictError";
}

export type AuthorizeOperationInput = {
  orgId: string;
  projectId: string;
  providerKind: string;
  capability: string;
  operation: string;
  actor: ActorRef;
};

export type AuthorizeOperationResult =
  | { status: "eligible"; lease: EligibleOperationLease }
  | { status: "not_linked" }
  | {
      status: "ineligible";
      reasons: string[];
    }
  | {
      status: "selection_required";
      reason: "selection_missing" | "multiple_eligible" | "selected_grant_unavailable";
      candidates: SanitizedConnectionCandidate[];
    };

export interface SanitizedConnectionCandidate {
  connectionId: string;
  grantId: string;
  providerKind: string;
  providerPrincipalId: string;
  displayName: string;
  health: string;
  authGeneration: number;
  grantGeneration: number;
  ineligibilityReasons: string[];
}

export interface IntegrationAuthority {
  authorizePrincipalVerification(
    client: IntegrationQueryClient,
    input: AuthorizePrincipalVerificationInput,
  ): Promise<PrincipalVerificationPermit>;

  authorizeOperation(client: IntegrationQueryClient, input: AuthorizeOperationInput): Promise<AuthorizeOperationResult>;
}

export function issuePrincipalVerificationPermit(
  fields: Omit<PrincipalVerificationPermit, typeof PRINCIPAL_VERIFICATION_PERMIT>,
): PrincipalVerificationPermit {
  return { [PRINCIPAL_VERIFICATION_PERMIT]: true, ...fields };
}

export function issueEligibleOperationLease(
  fields: Omit<EligibleOperationLease, typeof ELIGIBLE_OPERATION_LEASE>,
): EligibleOperationLease {
  return { [ELIGIBLE_OPERATION_LEASE]: true, ...fields };
}

export function assertPrincipalVerificationPermit(
  value: PrincipalVerificationPermit,
): asserts value is PrincipalVerificationPermit {
  if (!value?.[PRINCIPAL_VERIFICATION_PERMIT]) {
    throw new Error("invalid principal verification permit");
  }
}

export function assertEligibleOperationLease(value: EligibleOperationLease): asserts value is EligibleOperationLease {
  if (!value?.[ELIGIBLE_OPERATION_LEASE]) {
    throw new Error("invalid eligible operation lease");
  }
}
