import { catalogCapabilitiesForProvider } from "../../engine/contracts/integrationCatalog.js";
import type { FinalizeVerifiedLinkResult } from "../../engine/repositories/integrationConnections.js";
import type { VerifierTransitionOutcome } from "./verifierTransition.js";

export function operationUrl(orgId: string, operationId: string): string {
  return `/orgs/${orgId}/integrations/operations/${operationId}`;
}

export function transitionPendingPayload(outcome: VerifierTransitionOutcome, orgId: string, operationId: string) {
  return {
    status: outcome.status,
    operationId,
    operationUrl: operationUrl(orgId, operationId),
    ...(outcome.status === "failed" || outcome.status === "provider_unavailable" ? { reason: outcome.reason } : {}),
    ...(outcome.status === "provider_unavailable" && outcome.retryAfter !== undefined
      ? { retryAfter: outcome.retryAfter }
      : {}),
    ...(outcome.status === "awaiting_principal_selection" ? { candidates: outcome.candidates } : {}),
  };
}

export function linkCompletedPayload(
  orgId: string,
  operationId: string,
  providerKind: string,
  result: FinalizeVerifiedLinkResult,
  idempotentReplay = false,
) {
  return {
    status: "completed",
    operationId,
    operationUrl: operationUrl(orgId, operationId),
    providerKind,
    ...result,
    capabilities: catalogCapabilitiesForProvider(providerKind),
    ...(idempotentReplay ? { idempotentReplay: true } : {}),
  };
}

export function rotationCompletedPayload(
  orgId: string,
  operationId: string,
  result: FinalizeVerifiedLinkResult,
  idempotentReplay = false,
) {
  return {
    status: "completed",
    operationId,
    operationUrl: operationUrl(orgId, operationId),
    connectionId: result.connectionId,
    authGeneration: result.authGeneration,
    grantGeneration: result.grantGeneration,
    ...(idempotentReplay ? { idempotentReplay: true } : {}),
  };
}
