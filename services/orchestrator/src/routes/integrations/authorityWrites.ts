import type { Hono } from "hono";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { isKnownProviderKind } from "../../engine/contracts/integrationCatalog.js";
import { IntegrationIdempotencyConflictError } from "../../engine/contracts/integrationAuthority.js";
import type { IntegrationSecretStore } from "../../engine/contracts/integrationSecretStore.js";
import type { EventStore } from "../../engine/eventStore.js";
import type { PgIntegrationAuthority } from "../../engine/integrations/integrationAuthorityImpl.js";
import { integrationRequestFingerprint } from "../../engine/integrations/integrationOperationFingerprint.js";
import { hasPrincipalVerifier, principalVerifierFor } from "../../engine/integrations/principalVerifiers.js";
import { IntegrationConnectionsStore } from "../../engine/repositories/integrationConnections.js";
import type { IntegrationQueryClient } from "../../engine/repositories/integrationQuery.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "../orgs/access.js";
import {
  linkCompletedPayload,
  operationUrl,
  rotationCompletedPayload,
  transitionPendingPayload,
} from "./authorityPayloads.js";
import { runDurableLinkSaga } from "./linkSaga.js";
import { mountPrincipalSelectionRoute } from "./principalSelectionRoute.js";
import { publicLinkOperationProjection } from "./publicLinkOpStatus.js";
import {
  convergeVerifierTransition,
  recordAwaitingPrincipal,
  recordVerifierUnavailable,
  terminalizeVerifierFailure,
} from "./verifierTransition.js";

export interface IntegrationAuthorityRouteDatabase {
  events: EventStore;
  withOrgScope<T>(orgId: string, work: (client: IntegrationQueryClient) => Promise<T>): Promise<T>;
}

const LinkBody = z.object({ token: z.string().min(1).max(4096), idempotencyKey: z.string().min(1).max(200) }).strict();
const RotateBody = LinkBody;
const SelectionBody = z
  .object({
    connectionId: z.string().min(1).max(200),
    grantId: z.string().min(1).max(200),
    authGeneration: z.number().int().positive(),
    grantGeneration: z.number().int().positive(),
  })
  .strict();

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function projectAccess(
  database: IntegrationAuthorityRouteDatabase,
  orgId: string,
  projectId: string,
  actor: ActorContext,
) {
  const { integrationProjectAccess } = await import("../../engine/repositories/integrationProjectAccess.js");
  return database.withOrgScope(orgId, (client) => integrationProjectAccess(client, orgId, projectId, actor));
}

// Authority write surface is one serialized HTTP mount. The saga itself lives in
// linkSaga.ts so provider/Vault I/O cannot accidentally enter a database callback.
// eslint-disable-next-line max-lines-per-function -- coherent link/rotate/select mount
export function mountIntegrationAuthorityWrites(
  app: Hono<ActorContextEnv>,
  database: IntegrationAuthorityRouteDatabase,
  _options: { secrets?: unknown },
  authority: PgIntegrationAuthority,
  integrationSecrets: IntegrationSecretStore,
  fetchImpl: typeof fetch,
): void {
  app.post("/:orgId/integrations/:providerKind", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const providerKind = c.req.param("providerKind");
    if (!actorIsOrgAdmin(actor, orgId)) return c.json({ error: "org_admin_required" }, 403);
    if (!isKnownProviderKind(providerKind)) {
      return c.json({ error: "unknown_provider_kind", message: `unknown provider kind '${providerKind}'` }, 400);
    }
    // Known catalog entries without a production verifier are not linkable yet.
    if (!hasPrincipalVerifier(providerKind)) return c.json({ error: "principal_verifier_unavailable" }, 422);
    if (!integrationSecrets.supportsAtomicFinalization()) {
      return c.json({ error: "atomic_secret_finalization_unavailable" }, 422);
    }
    const parsed = LinkBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_link", issues: parsed.error.issues }, 400);

    try {
      const requestFingerprint = integrationRequestFingerprint({
        orgId,
        providerKind,
        operationKind: "link",
        actorId: actor.userId,
        credential: parsed.data.token,
      });
      const permit = await database.withOrgScope(orgId, (client) =>
        authority.authorizePrincipalVerification(client, {
          orgId,
          providerKind,
          operationKind: "link",
          idempotencyKey: parsed.data.idempotencyKey,
          requestFingerprint,
          actor: { kind: "operator", id: actor.userId },
        }),
      );
      const op = await database.withOrgScope(orgId, (client) =>
        IntegrationConnectionsStore.getOperation(client, orgId, permit.operationId),
      );
      if (op === undefined) throw new Error("operation_missing_after_authorize");
      if (op.status === "failed" || op.status === "compensated") {
        return c.json({ status: "failed", operationId: op.id, operationUrl: operationUrl(orgId, op.id) }, 202);
      }
      if (op.status === "awaiting_principal_selection") {
        return c.json(
          {
            status: "awaiting_principal_selection",
            operationId: op.id,
            operationUrl: operationUrl(orgId, op.id),
            candidates: op.candidatePrincipals,
          },
          202,
        );
      }
      const staged = { handle: permit.stagedSecretHandle, operationId: permit.operationId };
      if (["finalizing", "activate_pending", "completed"].includes(op.stage)) {
        const resumed = await runDurableLinkSaga(database, orgId, integrationSecrets, {
          permit,
          staged,
          credential: parsed.data.token,
        });
        if (resumed.status !== "completed") {
          return c.json(transitionPendingPayload(resumed, orgId, permit.operationId), 202);
        }
        return c.json(linkCompletedPayload(orgId, permit.operationId, providerKind, resumed.result, true), 202);
      }

      await integrationSecrets.stage(permit.operationId, parsed.data.token);
      const stagedRecorded = await database.withOrgScope(orgId, (client) =>
        IntegrationConnectionsStore.markOperationStaged(client, orgId, permit.operationId, staged.handle),
      );
      const transitionContext = {
        database,
        orgId,
        secrets: integrationSecrets,
        permit,
        staged,
        credential: parsed.data.token,
      };
      if (!stagedRecorded) {
        const converged = await convergeVerifierTransition(transitionContext);
        if (converged.status === "completed") {
          return c.json(linkCompletedPayload(orgId, permit.operationId, providerKind, converged.result, true), 202);
        }
        return c.json(transitionPendingPayload(converged, orgId, permit.operationId), 202);
      }
      const verified = await principalVerifierFor(providerKind, fetchImpl).verify(permit, staged, integrationSecrets);
      if (verified.status === "invalid") {
        const terminal = await terminalizeVerifierFailure(transitionContext, verified.reason);
        if (terminal.status === "completed") {
          return c.json(linkCompletedPayload(orgId, permit.operationId, providerKind, terminal.result, true), 202);
        }
        return c.json(transitionPendingPayload(terminal, orgId, permit.operationId), 202);
      }
      if (verified.status === "unavailable") {
        const unavailable = await recordVerifierUnavailable(transitionContext, verified.reason, verified.retryAfter);
        if (unavailable.status === "completed") {
          return c.json(linkCompletedPayload(orgId, permit.operationId, providerKind, unavailable.result, true), 202);
        }
        return c.json(transitionPendingPayload(unavailable, orgId, permit.operationId), 202);
      }
      if (verified.status === "multi_principal") {
        const awaiting = await recordAwaitingPrincipal(transitionContext, verified.candidates, {
          authKind: verified.authKind,
          scopes: verified.scopes,
        });
        if (awaiting.status === "completed") {
          return c.json(linkCompletedPayload(orgId, permit.operationId, providerKind, awaiting.result, true), 202);
        }
        return c.json(transitionPendingPayload(awaiting, orgId, permit.operationId), 202);
      }

      let outcome;
      try {
        outcome = await runDurableLinkSaga(database, orgId, integrationSecrets, {
          permit: transitionContext.permit,
          staged,
          credential: parsed.data.token,
          verified: {
            principal: verified.principal,
            authKind: verified.authKind,
            scopes: verified.scopes,
            ...(verified.expiresAt === undefined ? {} : { expiresAt: verified.expiresAt }),
          },
        });
      } catch (error) {
        if (!messageOf(error).includes("principal_already_linked")) throw error;
        const terminal = await terminalizeVerifierFailure(transitionContext, "principal_already_linked");
        if (terminal.status === "completed") {
          return c.json(linkCompletedPayload(orgId, permit.operationId, providerKind, terminal.result, true), 202);
        }
        if (terminal.status === "failed") return c.json({ error: "principal_already_linked" }, 409);
        return c.json(transitionPendingPayload(terminal, orgId, permit.operationId), 202);
      }
      if (outcome.status !== "completed") {
        return c.json(transitionPendingPayload(outcome, orgId, permit.operationId), 202);
      }
      return c.json(linkCompletedPayload(orgId, permit.operationId, providerKind, outcome.result), 202);
    } catch (error) {
      if (error instanceof IntegrationIdempotencyConflictError) {
        return c.json({ error: "idempotency_conflict" }, 409);
      }
      const msg = messageOf(error);
      if (msg.includes("principal_reservation_in_progress")) {
        return c.json({ error: "principal_reservation_in_progress" }, 409);
      }
      if (msg.includes("immutable_conflict")) return c.json({ error: "generation_immutable_conflict" }, 409);
      if (msg.includes("principal_already_linked")) return c.json({ error: "principal_already_linked" }, 409);
      return c.json({ error: "link_failed" }, 500);
    }
  });

  app.post("/:orgId/integrations/:providerKind/connections/:connectionId/rotate", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const providerKind = c.req.param("providerKind");
    const connectionId = c.req.param("connectionId");
    if (!actorIsOrgAdmin(actor, orgId)) return c.json({ error: "org_admin_required" }, 403);
    if (!isKnownProviderKind(providerKind)) return c.json({ error: "unknown_provider_kind" }, 400);
    if (!hasPrincipalVerifier(providerKind)) return c.json({ error: "principal_verifier_unavailable" }, 422);
    if (!integrationSecrets.supportsAtomicFinalization()) {
      return c.json({ error: "atomic_secret_finalization_unavailable" }, 422);
    }
    const parsed = RotateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_rotate", issues: parsed.error.issues }, 400);

    try {
      const requestFingerprint = integrationRequestFingerprint({
        orgId,
        providerKind,
        operationKind: "rotate",
        connectionId,
        actorId: actor.userId,
        credential: parsed.data.token,
      });
      const permit = await database.withOrgScope(orgId, (client) =>
        authority.authorizePrincipalVerification(client, {
          orgId,
          providerKind,
          operationKind: "rotate",
          connectionId,
          idempotencyKey: parsed.data.idempotencyKey,
          requestFingerprint,
          actor: { kind: "operator", id: actor.userId },
        }),
      );
      const op = await database.withOrgScope(orgId, (client) =>
        IntegrationConnectionsStore.getOperation(client, orgId, permit.operationId),
      );
      if (op === undefined) throw new Error("operation_missing_after_authorize");
      if (op.status === "failed" || op.status === "compensated") {
        return c.json({ status: "failed", operationId: op.id, operationUrl: operationUrl(orgId, op.id) }, 202);
      }
      const staged = { handle: permit.stagedSecretHandle, operationId: permit.operationId };
      if (["finalizing", "activate_pending", "completed"].includes(op.stage)) {
        const resumed = await runDurableLinkSaga(database, orgId, integrationSecrets, {
          permit,
          staged,
          credential: parsed.data.token,
        });
        if (resumed.status !== "completed") return c.json(transitionPendingPayload(resumed, orgId, op.id), 202);
        return c.json(rotationCompletedPayload(orgId, op.id, resumed.result, true), 202);
      }

      await integrationSecrets.stage(permit.operationId, parsed.data.token);
      const stagedRecorded = await database.withOrgScope(orgId, (client) =>
        IntegrationConnectionsStore.markOperationStaged(client, orgId, permit.operationId, staged.handle),
      );
      const transitionContext = {
        database,
        orgId,
        secrets: integrationSecrets,
        permit,
        staged,
        credential: parsed.data.token,
      };
      if (!stagedRecorded) {
        const converged = await convergeVerifierTransition(transitionContext);
        if (converged.status === "completed") {
          return c.json(rotationCompletedPayload(orgId, permit.operationId, converged.result, true), 202);
        }
        return c.json(transitionPendingPayload(converged, orgId, permit.operationId), 202);
      }
      const verified = await principalVerifierFor(providerKind, fetchImpl).verify(permit, staged, integrationSecrets);
      if (verified.status === "unavailable") {
        const unavailable = await recordVerifierUnavailable(transitionContext, verified.reason, verified.retryAfter);
        if (unavailable.status === "completed") {
          return c.json(rotationCompletedPayload(orgId, permit.operationId, unavailable.result, true), 202);
        }
        return c.json(transitionPendingPayload(unavailable, orgId, permit.operationId), 202);
      }
      if (verified.status !== "verified") {
        const reason = verified.status === "invalid" ? verified.reason : "multi_principal_on_rotate";
        const terminal = await terminalizeVerifierFailure(transitionContext, reason);
        if (terminal.status === "completed") {
          return c.json(rotationCompletedPayload(orgId, permit.operationId, terminal.result, true), 202);
        }
        return c.json(transitionPendingPayload(terminal, orgId, permit.operationId), 202);
      }
      const outcome = await runDurableLinkSaga(database, orgId, integrationSecrets, {
        permit: transitionContext.permit,
        staged,
        credential: parsed.data.token,
        verified: {
          principal: verified.principal,
          authKind: verified.authKind,
          scopes: verified.scopes,
          ...(verified.expiresAt === undefined ? {} : { expiresAt: verified.expiresAt }),
        },
      });
      if (outcome.status !== "completed") {
        return c.json(transitionPendingPayload(outcome, orgId, permit.operationId), 202);
      }
      return c.json(rotationCompletedPayload(orgId, permit.operationId, outcome.result), 202);
    } catch (error) {
      if (error instanceof IntegrationIdempotencyConflictError) return c.json({ error: "idempotency_conflict" }, 409);
      if (messageOf(error).includes("principal_reservation_in_progress")) {
        return c.json({ error: "connection_rotation_in_progress" }, 409);
      }
      if (messageOf(error).includes("immutable_conflict")) {
        return c.json({ error: "generation_immutable_conflict" }, 409);
      }
      return c.json({ error: "rotate_failed" }, 500);
    }
  });

  mountPrincipalSelectionRoute(app, database, integrationSecrets, fetchImpl);

  app.get("/:orgId/integrations/operations/:operationId", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const op = await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.getOperation(client, orgId, c.req.param("operationId")),
    );
    if (op === undefined) return c.json({ error: "operation_not_found" }, 404);
    const publicProjection = publicLinkOperationProjection(op);
    return c.json(
      {
        operationId: op.id,
        providerKind: op.providerKind,
        connectionId: op.connectionId,
        operationKind: op.operationKind,
        stage: op.stage,
        status: op.status,
        ...publicProjection,
        candidates: op.candidatePrincipals,
      },
      200,
    );
  });

  app.put("/:orgId/projects/:projectId/integrations/:providerKind/selection", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    const providerKind = c.req.param("providerKind");
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const access = await projectAccess(database, orgId, projectId, actor);
    if (access === "not_found") return c.json({ error: "project_not_found" }, 404);
    if (access === "denied") return c.json({ error: "project_access_denied" }, 403);
    const parsed = SelectionBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_selection", issues: parsed.error.issues }, 400);

    const selected = await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.selectControlGrant(
        client,
        { orgId, projectId, providerKind, ...parsed.data },
        { kind: "operator", id: actor.userId },
      ),
    );
    if (selected === undefined) return c.json({ error: "selection_conflict" }, 409);
    return c.json(
      {
        status: "selected",
        providerKind,
        connectionId: selected.connectionId,
        grantId: selected.grantId,
        providerPrincipalId: selected.providerPrincipalId,
        authGeneration: selected.authGeneration,
        grantGeneration: selected.grantGeneration,
      },
      200,
    );
  });
}
