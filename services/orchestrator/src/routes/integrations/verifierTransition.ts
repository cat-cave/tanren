import type { PrincipalCandidate, PrincipalVerificationPermit } from "../../engine/contracts/integrationAuthority.js";
import type { IntegrationSecretStore, StagedSecretHandle } from "../../engine/contracts/integrationSecretStore.js";
import { IntegrationConnectionsStore } from "../../engine/repositories/integrationConnections.js";
import type { IntegrationAuthorityRouteDatabase } from "./authorityWrites.js";
import { runDurableLinkSaga, type DurableLinkSagaOutcome } from "./linkSaga.js";

export type VerifierTransitionOutcome =
  | DurableLinkSagaOutcome
  | { status: "awaiting_principal_selection"; candidates: PrincipalCandidate[] }
  | { status: "provider_unavailable"; reason: string; retryAfter?: string }
  | { status: "verification_in_progress" }
  | { status: "failed"; reason: string };

interface TransitionContext {
  database: IntegrationAuthorityRouteDatabase;
  orgId: string;
  secrets: IntegrationSecretStore;
  permit: PrincipalVerificationPermit;
  staged: StagedSecretHandle;
  credential?: string;
}

async function convergeAfterCasLoss(context: TransitionContext): Promise<VerifierTransitionOutcome> {
  const op = await context.database.withOrgScope(context.orgId, (client) =>
    IntegrationConnectionsStore.getOperation(client, context.orgId, context.permit.operationId),
  );
  if (op === undefined) throw new Error("operation_missing_after_transition_cas_loss");
  if (op.status === "failed" || op.status === "compensated") {
    return { status: "failed", reason: op.failureClassification ?? "operation_failed" };
  }
  if (op.status === "awaiting_principal_selection") {
    return { status: "awaiting_principal_selection", candidates: op.candidatePrincipals };
  }
  if (["finalizing", "activate_pending", "completed"].includes(op.stage)) {
    return runDurableLinkSaga(context.database, context.orgId, context.secrets, {
      permit: context.permit,
      staged: context.staged,
      ...(context.credential === undefined ? {} : { credential: context.credential }),
    });
  }
  return { status: "verification_in_progress" };
}

export async function convergeVerifierTransition(context: TransitionContext): Promise<VerifierTransitionOutcome> {
  return convergeAfterCasLoss(context);
}

async function clearTerminalStage(context: TransitionContext): Promise<void> {
  try {
    await context.secrets.compensate(context.staged);
    await context.database.withOrgScope(context.orgId, (client) =>
      IntegrationConnectionsStore.markStagedCleanupComplete(client, context.permit),
    );
  } catch {
    // The terminal receipt and staged handle are durable; the cleanup reaper retries.
  }
}

export async function terminalizeVerifierFailure(
  context: TransitionContext,
  reason: string,
): Promise<VerifierTransitionOutcome> {
  const terminal = await context.database.withOrgScope(context.orgId, (client) =>
    IntegrationConnectionsStore.markOperationFailed(client, context.orgId, context.permit.operationId, reason),
  );
  if (!terminal) return convergeAfterCasLoss(context);
  await clearTerminalStage(context);
  return { status: "failed", reason };
}

export async function recordVerifierUnavailable(
  context: TransitionContext,
  reason: string,
  retryAfter?: string,
): Promise<VerifierTransitionOutcome> {
  const recorded = await context.database.withOrgScope(context.orgId, (client) =>
    IntegrationConnectionsStore.markOperationRetryable(
      client,
      context.orgId,
      context.permit.operationId,
      reason,
      retryAfter,
    ),
  );
  if (!recorded) return convergeAfterCasLoss(context);
  return { status: "provider_unavailable", reason, ...(retryAfter === undefined ? {} : { retryAfter }) };
}

export async function recordAwaitingPrincipal(
  context: TransitionContext,
  candidates: PrincipalCandidate[],
  verified: { authKind: string; scopes: string[]; expiresAt?: string },
): Promise<VerifierTransitionOutcome> {
  const recorded = await context.database.withOrgScope(context.orgId, (client) =>
    IntegrationConnectionsStore.markAwaitingPrincipalSelection(
      client,
      context.orgId,
      context.permit.operationId,
      candidates,
      verified,
    ),
  );
  if (!recorded) return convergeAfterCasLoss(context);
  return { status: "awaiting_principal_selection", candidates };
}
