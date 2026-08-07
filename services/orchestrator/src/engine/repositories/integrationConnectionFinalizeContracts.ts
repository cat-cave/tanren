import type { PrincipalCandidate, PrincipalVerificationPermit } from "../contracts/integrationAuthority.js";
import { assertPrincipalVerificationPermit } from "../integrations/integrationAuthorityImpl.js";
import {
  connectionCredentialBaseRef,
  generationSecretRef,
  type StagedSecretHandle,
} from "../contracts/integrationSecretStore.js";

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

export interface LinkReservationFields {
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

export function issueLinkReservation(fields: LinkReservationFields): LinkReservation {
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
