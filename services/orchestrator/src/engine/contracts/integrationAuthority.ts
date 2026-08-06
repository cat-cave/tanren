/**
 * IntegrationAuthority is the only issuer of provider/credential authority.
 * The brands below are deliberately type-only and module-private: consumers can
 * hold a permit or lease, but cannot import a symbol or constructor to mint one.
 */

import type { IntegrationQueryClient } from "../repositories/integrationQuery.js";
import type { ActorRef } from "../state/actor.js";

declare const principalVerificationPermitBrand: unique symbol;
declare const eligibleOperationLeaseBrand: unique symbol;

export interface PrincipalCandidate {
  providerPrincipalId: string;
  principalKind: "team" | "organization" | "user";
  displayName: string;
  metadata: Record<string, string>;
}

export interface PrincipalVerificationPermit {
  readonly [principalVerificationPermitBrand]: true;
  readonly orgId: string;
  readonly providerKind: string;
  readonly operationId: string;
  readonly actorId: string;
  readonly stagedSecretHandle: string;
}

export type IntegrationPrivilegedOperation =
  | "discover"
  | "provision"
  | "bind"
  | "intake"
  | "attach_runtime_env"
  | "deploy"
  | "verify"
  | "resolve_demo_surface"
  | "resolve_artifact_identity"
  | "promote"
  | "rollback"
  | "teardown_deployment";

/**
 * The complete, supported target vocabulary for privileged integration calls.
 * Every field is intentionally scalar so equality is unambiguous at provider
 * boundaries and no caller-controlled object is silently ignored.
 */
export interface IntegrationOperationTarget {
  readonly resourceId?: string;
  readonly deploymentId?: string;
  readonly environment?: "production";
  readonly sourceRepo?: string;
  readonly sourceRef?: string;
  readonly projectName?: string;
  readonly orgSlug?: string;
  readonly stack?: string;
}

/** Canonical target for project-scoped provision/bind calls. */
export function projectIntegrationOperationTarget(
  projectCtx: { projectId: string; orgSlug: string; name?: string; stack?: string },
  resourceId?: string,
): IntegrationOperationTarget {
  return {
    projectName: projectCtx.name ?? projectCtx.projectId,
    orgSlug: projectCtx.orgSlug,
    ...(projectCtx.stack === undefined ? {} : { stack: projectCtx.stack }),
    ...(resourceId === undefined ? {} : { resourceId }),
  };
}

/** The only resource-constraint shape Tanren currently claims to enforce. */
export interface IntegrationResourceConstraintsV1 {
  readonly version: 1;
  /** Every provider operation must use the project's exact persisted selection. */
  readonly projectBinding: "selected";
  readonly resourceIds: "*" | readonly string[];
  readonly environments: "*" | readonly "production"[];
}

export type IntegrationResourceConstraints = IntegrationResourceConstraintsV1;

/** Deterministic constraints persisted for every newly activated control grant. */
export function defaultIntegrationResourceConstraints(): IntegrationResourceConstraints {
  return {
    version: 1,
    projectBinding: "selected",
    resourceIds: "*",
    environments: ["production"],
  };
}

export interface EligibleOperationLease {
  readonly [eligibleOperationLeaseBrand]: true;
  readonly orgId: string;
  readonly projectId: string;
  readonly providerKind: string;
  readonly connectionId: string;
  readonly grantId: string;
  readonly authGeneration: number;
  readonly grantGeneration: number;
  readonly credentialRef: string;
  readonly capability: string;
  readonly operation: IntegrationPrivilegedOperation;
  readonly target: Readonly<IntegrationOperationTarget>;
  readonly resourceConstraints: IntegrationResourceConstraints;
  readonly authorizedAt: string;
  readonly expiresAt: string;
  readonly providerPrincipalId: string;
  readonly principalMetadata: Record<string, unknown>;
  readonly policyRevision: string;
  readonly consentRevision: string;
}

export interface EligibleOperationExpectation {
  readonly orgId: string;
  readonly projectId: string;
  readonly providerKind: string;
  readonly capability: string;
  readonly operation: IntegrationPrivilegedOperation;
  readonly target: Readonly<IntegrationOperationTarget>;
}

export type AuthorizePrincipalVerificationInput = {
  orgId: string;
  providerKind: string;
  operationKind: "link" | "rotate";
  idempotencyKey: string;
  connectionId?: string;
  /**
   * Digest binding the idempotency key to actor, target, and credential bytes.
   * Endpoint-less historical retries pass the exact pre-endpoint v1 digest here.
   */
  requestFingerprint: string;
  /**
   * Exact pre-endpoint v1 digest. Only the Sentry link/rotate route may use it
   * to migrate a historically endpoint-less operation to the current digest.
   */
  legacyRequestFingerprint?: string;
  /** Do not create a new operation while replaying an endpoint-less legacy request. */
  legacyRetryOnly?: boolean;
  actor: ActorRef;
};

export type ResumePrincipalVerificationInput = {
  orgId: string;
  operationId: string;
};

export class IntegrationIdempotencyConflictError extends Error {
  public override readonly name = "IntegrationIdempotencyConflictError";
}

export class IntegrationLegacyOperationNotFoundError extends Error {
  public override readonly name = "IntegrationLegacyOperationNotFoundError";
}

export type AuthorizeOperationInput = EligibleOperationExpectation & {
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

  /** Rehydrate an existing durable link operation without consumer-side minting. */
  resumePrincipalVerification(
    client: IntegrationQueryClient,
    input: ResumePrincipalVerificationInput,
  ): Promise<PrincipalVerificationPermit>;

  authorizeOperation(client: IntegrationQueryClient, input: AuthorizeOperationInput): Promise<AuthorizeOperationResult>;
}
