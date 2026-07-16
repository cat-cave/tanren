import type { Hono } from "hono";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { issuePrincipalVerificationPermit } from "../../engine/contracts/integrationAuthority.js";
import {
  integrationStagedSecretRef,
  type IntegrationSecretStore,
} from "../../engine/contracts/integrationSecretStore.js";
import { PrincipalProviderUnavailableError } from "../../engine/integrations/principalVerifierSupport.js";
import { IntegrationConnectionsStore } from "../../engine/repositories/integrationConnections.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorIsOrgAdmin } from "../orgs/access.js";
import { transitionPendingPayload } from "./authorityPayloads.js";
import type { IntegrationAuthorityRouteDatabase } from "./authorityWrites.js";
import { runDurableLinkSaga } from "./linkSaga.js";
import { runSelectedPrincipalSaga } from "./selectedPrincipalSaga.js";
import { recordVerifierUnavailable, terminalizeVerifierFailure } from "./verifierTransition.js";

const PrincipalSelectBody = z.object({ providerPrincipalId: z.string().min(1).max(200) }).strict();

function actor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function completedPayload(operationId: string, result: Awaited<ReturnType<typeof runDurableLinkSaga>>) {
  if (result.status !== "completed") throw new Error("completed payload requires completed saga result");
  return {
    status: "completed",
    operationId,
    connectionId: result.result.connectionId,
    grantId: result.result.grantId,
    providerPrincipalId: result.result.providerPrincipalId,
    authGeneration: result.result.authGeneration,
    grantGeneration: result.result.grantGeneration,
  };
}

export function mountPrincipalSelectionRoute(
  app: Hono<ActorContextEnv>,
  database: IntegrationAuthorityRouteDatabase,
  secrets: IntegrationSecretStore,
  fetchImpl: typeof fetch,
): void {
  app.post("/:orgId/integrations/operations/:operationId/principal", async (c) => {
    const orgId = c.req.param("orgId");
    const operationId = c.req.param("operationId");
    if (!actorIsOrgAdmin(actor(c), orgId)) return c.json({ error: "org_admin_required" }, 403);
    if (!secrets.supportsAtomicFinalization()) {
      return c.json({ error: "atomic_secret_finalization_unavailable" }, 422);
    }
    const parsed = PrincipalSelectBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_principal_selection", issues: parsed.error.issues }, 400);

    const op = await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.getOperation(client, orgId, operationId),
    );
    if (op === undefined) return c.json({ error: "operation_not_found" }, 404);
    const handle = op.stagedSecretHandle ?? integrationStagedSecretRef(op.id);
    const staged = { handle, operationId: op.id };
    const permit = issuePrincipalVerificationPermit({
      orgId,
      providerKind: op.providerKind,
      operationId: op.id,
      actorId: op.actorId,
      stagedSecretHandle: handle,
    });

    if (["finalizing", "activate_pending", "completed"].includes(op.stage)) {
      if (op.selectedPrincipalId !== parsed.data.providerPrincipalId) {
        return c.json({ error: "principal_selection_conflict" }, 409);
      }
      const resumed = await runDurableLinkSaga(database, orgId, secrets, { permit, staged });
      return resumed.status === "completed"
        ? c.json(completedPayload(op.id, resumed), 202)
        : c.json(transitionPendingPayload(resumed, orgId, op.id), 202);
    }
    if (op.status === "failed" || op.status === "compensated") {
      return c.json({ status: "failed", operationId: op.id }, 202);
    }
    if (op.status !== "awaiting_principal_selection") {
      return c.json({ error: "operation_not_awaiting_principal" }, 409);
    }
    const principal = op.candidatePrincipals.find(
      (candidate) => candidate.providerPrincipalId === parsed.data.providerPrincipalId,
    );
    if (principal === undefined) return c.json({ error: "unknown_principal_candidate" }, 400);
    if (op.stagedSecretHandle === undefined) return c.json({ error: "staged_secret_missing" }, 409);

    try {
      const outcome = await runSelectedPrincipalSaga(database, orgId, secrets, fetchImpl, {
        permit,
        staged,
        providerKind: op.providerKind,
        principal,
        authKind: op.verifiedAuthKind ?? "api_key",
        discoveredScopes: op.verifiedScopes,
        ...(op.verifiedExpiresAt === undefined ? {} : { expiresAt: op.verifiedExpiresAt }),
      });
      return outcome.status === "completed"
        ? c.json(completedPayload(op.id, outcome), 202)
        : c.json(transitionPendingPayload(outcome, orgId, op.id), 202);
    } catch (error) {
      const context = { database, orgId, secrets, permit, staged };
      if (error instanceof PrincipalProviderUnavailableError) {
        const unavailable = await recordVerifierUnavailable(context, error.reason, error.retryAfter);
        return c.json(transitionPendingPayload(unavailable, orgId, operationId), 202);
      }
      if (messageOf(error).includes("selected_principal_scopes_unproven")) {
        return c.json({ error: "selected_principal_scopes_unproven" }, 409);
      }
      if (messageOf(error).includes("principal_already_linked")) {
        const terminal = await terminalizeVerifierFailure(context, "principal_already_linked");
        if (terminal.status === "completed") return c.json(completedPayload(op.id, terminal), 202);
        if (terminal.status !== "failed") {
          return c.json(transitionPendingPayload(terminal, orgId, operationId), 202);
        }
        return c.json({ error: "principal_already_linked" }, 409);
      }
      return c.json({ error: "principal_selection_failed" }, 500);
    }
  });
}
