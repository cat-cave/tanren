import {
  IntegrationSecretConflictError,
  type IntegrationSecretStore,
} from "../../engine/contracts/integrationSecretStore.js";
import { isSecretStoreWriteError } from "../../engine/contracts/secretStore.js";
import type { PrincipalCandidate } from "../../engine/contracts/integrationAuthority.js";
import type {
  FinalizeVerifiedLinkInput,
  FinalizeVerifiedLinkResult,
  LinkReservation,
} from "../../engine/repositories/integrationConnectionFinalize.js";
import { finalizeReservedSecret } from "../../engine/repositories/integrationConnectionFinalize.js";
import { IntegrationConnectionsStore } from "../../engine/repositories/integrationConnections.js";
import type { IntegrationAuthorityRouteDatabase } from "./authorityWrites.js";

export type DurableLinkSagaOutcome =
  | { status: "verification_required" }
  | { status: "completed"; result: FinalizeVerifiedLinkResult }
  | { status: "finalize_pending" }
  | { status: "activate_pending" }
  | { status: "failed"; reason: "secret_finalize_failed" | "activation_conflict" };

type DurableLinkSagaInput = {
  permit: FinalizeVerifiedLinkInput["permit"];
  staged: FinalizeVerifiedLinkInput["staged"];
  credential?: string;
  verified?: {
    principal: PrincipalCandidate;
    authKind: string;
    scopes: string[];
    expiresAt?: string;
    selectedPrincipalId?: string;
  };
};

function isReservation(state: LinkReservation | FinalizeVerifiedLinkResult | undefined): state is LinkReservation {
  return state !== undefined && "nextGeneration" in state;
}

function isPermanentSagaConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:immutable|pointer|coordinate|reservation|completion|connection)_conflict|operation_lost_reservation/u.test(
    message,
  );
}

async function recordNonterminalFailure(
  database: IntegrationAuthorityRouteDatabase,
  orgId: string,
  operationId: string,
  classification: string,
): Promise<void> {
  await database.withOrgScope(orgId, (client) =>
    IntegrationConnectionsStore.recordNonterminalFailure(client, orgId, operationId, classification),
  );
}

async function cleanCommittedStage(
  database: IntegrationAuthorityRouteDatabase,
  orgId: string,
  secrets: IntegrationSecretStore,
  permit: DurableLinkSagaInput["permit"],
  staged: DurableLinkSagaInput["staged"],
): Promise<void> {
  try {
    await secrets.completeStaged(staged);
    await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.markStagedCleanupComplete(client, permit),
    );
  } catch {
    // The durable staged handle intentionally remains so a later cleanup pass
    // can retry without touching a finalized generation coordinate.
  }
}

async function completedAfterConcurrentCleanup(
  database: IntegrationAuthorityRouteDatabase,
  orgId: string,
  input: DurableLinkSagaInput,
): Promise<FinalizeVerifiedLinkResult | undefined> {
  const state = await database.withOrgScope(orgId, (client) =>
    IntegrationConnectionsStore.loadDurableLinkState(client, input.permit),
  );
  return state !== undefined && !isReservation(state) ? state : undefined;
}

async function terminalSecretFailure(
  database: IntegrationAuthorityRouteDatabase,
  orgId: string,
  secrets: IntegrationSecretStore,
  input: DurableLinkSagaInput,
): Promise<DurableLinkSagaOutcome> {
  await database.withOrgScope(orgId, (client) =>
    IntegrationConnectionsStore.markOperationActivationFailed(
      client,
      orgId,
      input.permit.operationId,
      "secret_finalize_failed",
    ),
  );
  // Terminal receipt is durable before the only staged recovery bytes are touched.
  await cleanCommittedStage(database, orgId, secrets, input.permit, input.staged);
  return { status: "failed", reason: "secret_finalize_failed" };
}

async function terminalActivationConflict(
  database: IntegrationAuthorityRouteDatabase,
  orgId: string,
  secrets: IntegrationSecretStore,
  input: DurableLinkSagaInput,
): Promise<DurableLinkSagaOutcome> {
  await database.withOrgScope(orgId, (client) =>
    IntegrationConnectionsStore.markOperationActivationFailed(
      client,
      orgId,
      input.permit.operationId,
      "activation_permanent_conflict",
    ),
  );
  // The finalized generation is intentionally retained. Only the duplicate
  // operation-scoped staged bytes are safe to remove after the terminal receipt.
  await cleanCommittedStage(database, orgId, secrets, input.permit, input.staged);
  return { status: "failed", reason: "activation_conflict" };
}

/**
 * Production saga driver. Every SQL callback is a short transaction; Vault is
 * always outside it. Durable reservations resume without provider verification.
 */
export async function runDurableLinkSaga(
  database: IntegrationAuthorityRouteDatabase,
  orgId: string,
  secrets: IntegrationSecretStore,
  input: DurableLinkSagaInput,
): Promise<DurableLinkSagaOutcome> {
  let state = await database.withOrgScope(orgId, (client) =>
    IntegrationConnectionsStore.loadDurableLinkState(client, input.permit),
  );
  if (state !== undefined && !isReservation(state)) {
    await cleanCommittedStage(database, orgId, secrets, input.permit, input.staged);
    return { status: "completed", result: state };
  }
  if (state === undefined) {
    if (input.verified === undefined) return { status: "verification_required" };
    const verified = input.verified;
    state = await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.reserveVerifiedLink(client, {
        permit: input.permit,
        staged: input.staged,
        ...verified,
      }),
    );
    if (!isReservation(state)) return { status: "completed", result: state };
  } else if (input.verified !== undefined) {
    // A concurrent same-key call may have reserved while this caller verified.
    // Re-enter reserve solely to compare the persisted verification fingerprint.
    const verified = input.verified;
    state = await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.reserveVerifiedLink(client, {
        permit: input.permit,
        staged: input.staged,
        ...verified,
      }),
    );
    if (!isReservation(state)) return { status: "completed", result: state };
  }
  const reservation = state;

  // Re-materialize only the operation-scoped staged coordinate. The request
  // fingerprint already proved these are the same credential bytes.
  if (input.credential !== undefined) await secrets.stage(input.permit.operationId, input.credential);

  let credentialRef: string;
  try {
    credentialRef = await finalizeReservedSecret(secrets, reservation, input.staged);
  } catch (error) {
    const completed = await completedAfterConcurrentCleanup(database, orgId, input);
    if (completed !== undefined) return { status: "completed", result: completed };
    if (
      error instanceof IntegrationSecretConflictError ||
      (isSecretStoreWriteError(error) && error.writeState === "definitely_unwritten")
    ) {
      return terminalSecretFailure(database, orgId, secrets, input);
    }
    if (isPermanentSagaConflict(error)) throw error;
    await recordNonterminalFailure(database, orgId, input.permit.operationId, "secret_finalize_ambiguous");
    return { status: "finalize_pending" };
  }

  try {
    await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.markReservationActivatePending(client, reservation, credentialRef),
    );
  } catch (error) {
    if (isPermanentSagaConflict(error)) {
      return terminalActivationConflict(database, orgId, secrets, input);
    }
    await recordNonterminalFailure(database, orgId, input.permit.operationId, "activate_mark_pending");
    return { status: "activate_pending" };
  }

  let result: FinalizeVerifiedLinkResult;
  try {
    result = await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.activateReservedLink(client, reservation, credentialRef),
    );
  } catch (error) {
    if (isPermanentSagaConflict(error)) {
      return terminalActivationConflict(database, orgId, secrets, input);
    }
    await recordNonterminalFailure(database, orgId, input.permit.operationId, "activation_retry_pending");
    return { status: "activate_pending" };
  }
  await cleanCommittedStage(database, orgId, secrets, input.permit, input.staged);
  return { status: "completed", result };
}
