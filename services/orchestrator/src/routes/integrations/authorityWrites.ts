import type { Hono } from "hono";
import type { ActorContext } from "../../auth/schemas.js";
import { catalogCapabilitiesForProvider, isKnownProviderKind } from "../../engine/contracts/integrationCatalog.js";
import type { IntegrationSecretStore } from "../../engine/contracts/integrationSecretStore.js";
import type { LinkReservation } from "../../engine/repositories/integrationConnectionFinalize.js";
import { issuePrincipalVerificationPermit } from "../../engine/contracts/integrationAuthority.js";
import type { EventStore } from "../../engine/eventStore.js";
import type { PgIntegrationAuthority } from "../../engine/integrations/integrationAuthorityImpl.js";
import { principalVerifierFor } from "../../engine/integrations/principalVerifiers.js";
import { IntegrationConnectionsStore } from "../../engine/repositories/integrationConnections.js";
import type { IntegrationQueryClient } from "../../engine/repositories/integrationQuery.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "../orgs/access.js";
import { z } from "zod";

export interface IntegrationAuthorityRouteDatabase {
  events: EventStore;
  withOrgScope<T>(orgId: string, work: (client: IntegrationQueryClient) => Promise<T>): Promise<T>;
}

const LinkBody = z.object({ token: z.string().min(1).max(4096), idempotencyKey: z.string().min(1).max(200) }).strict();
const RotateBody = z
  .object({ token: z.string().min(1).max(4096), idempotencyKey: z.string().min(1).max(200) })
  .strict();
const PrincipalSelectBody = z.object({ providerPrincipalId: z.string().min(1).max(200) }).strict();
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

/** Split reserve → Vault create-only → activate; no provider/Vault I/O under BEGIN. */
async function runSplitLinkFinalize(
  database: IntegrationAuthorityRouteDatabase,
  orgId: string,
  input: Parameters<typeof IntegrationConnectionsStore.finalizeVerifiedLink>[1],
  integrationSecrets: IntegrationSecretStore,
): Promise<Awaited<ReturnType<typeof IntegrationConnectionsStore.finalizeVerifiedLink>>> {
  const { finalizeReservedSecret } = await import("../../engine/repositories/integrationConnectionFinalize.js");

  const reserved = await database.withOrgScope(orgId, (client) =>
    IntegrationConnectionsStore.reserveVerifiedLink(client, input),
  );
  if ("authGeneration" in reserved && !("nextGeneration" in reserved)) {
    return reserved;
  }
  const reservation = reserved as LinkReservation;
  let credentialRef: string;
  try {
    credentialRef = await finalizeReservedSecret(integrationSecrets, reservation, input.staged);
  } catch (error) {
    await database.withOrgScope(orgId, (client) =>
      client.query(
        `UPDATE org_integration_connection_operations
         SET failure_classification = 'secret_finalize_failed',
             compensation_state = compensation_state || $3::jsonb,
             updated_at = now()
         WHERE org_id = $1 AND id = $2`,
        [
          orgId,
          reservation.permit.operationId,
          JSON.stringify({
            secretFinalizeError: error instanceof Error ? error.message : "secret_finalize_failed",
            reservedCredentialBase: reservation.baseRef,
          }),
        ],
      ),
    );
    throw error;
  }
  return database.withOrgScope(orgId, (client) =>
    IntegrationConnectionsStore.activateReservedLink(client, reservation, credentialRef),
  );
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

// Authority write surface is one continuous HTTP mount; split would fragment the
// 401/403-before-I/O sequence across files. Keep a single mount with an explicit
// line budget exception for this serialized control-plane surface.
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
    // 401/403 before operation creation, secret staging, verifier, or provider I/O.
    if (!actorIsOrgAdmin(actor, orgId)) return c.json({ error: "org_admin_required" }, 403);
    if (!isKnownProviderKind(providerKind)) {
      return c.json({ error: "unknown_provider_kind", message: `unknown provider kind '${providerKind}'` }, 400);
    }
    const parsed = LinkBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_link", issues: parsed.error.issues }, 400);

    try {
      // Completed idempotent replay — return terminal result without restage/reverify.
      const existingOp = await database.withOrgScope(orgId, async (client) => {
        const found = await client.query(
          `SELECT id, stage, status, connection_id, target_auth_generation
           FROM org_integration_connection_operations
           WHERE org_id = $1 AND idempotency_key = $2`,
          [orgId, parsed.data.idempotencyKey],
        );
        return found.rows[0] as
          | {
              id: string;
              stage: string;
              status: string;
              connection_id: string | null;
              target_auth_generation: number | null;
            }
          | undefined;
      });
      if (existingOp?.status === "completed" && existingOp.connection_id !== null) {
        const inventory = await database.withOrgScope(orgId, (client) =>
          IntegrationConnectionsStore.listInventory(client, orgId),
        );
        const row = inventory.find((item) => item.connectionId === existingOp.connection_id);
        return c.json(
          {
            status: "completed",
            operationId: existingOp.id,
            operationUrl: `/orgs/${orgId}/integrations/operations/${existingOp.id}`,
            providerKind,
            connectionId: existingOp.connection_id,
            grantId: row?.grantId,
            providerPrincipalId: row?.providerPrincipalId,
            displayName: row?.displayName,
            authGeneration: row?.currentAuthGeneration ?? existingOp.target_auth_generation,
            grantGeneration: row?.grantGeneration,
            capabilities: catalogCapabilitiesForProvider(providerKind),
            idempotentReplay: true,
          },
          202,
        );
      }
      const permit = await database.withOrgScope(orgId, (client) =>
        authority.authorizePrincipalVerification(client, {
          orgId,
          providerKind,
          operationKind: "link",
          idempotencyKey: parsed.data.idempotencyKey,
          actor: { kind: "operator", id: actor.userId },
        }),
      );
      const staged = await integrationSecrets.stage(permit.operationId, parsed.data.token);
      await database.withOrgScope(orgId, (client) =>
        IntegrationConnectionsStore.markOperationStaged(client, orgId, permit.operationId, staged.handle),
      );
      const verifier = principalVerifierFor(providerKind, fetchImpl);
      const verified = await verifier.verify(
        { ...permit, stagedSecretHandle: staged.handle },
        staged,
        integrationSecrets,
      );
      if (verified.status === "invalid") {
        await integrationSecrets.compensate(staged);
        await database.withOrgScope(orgId, (client) =>
          IntegrationConnectionsStore.markOperationFailed(client, orgId, permit.operationId, verified.reason),
        );
        return c.json(
          {
            status: "failed",
            operationId: permit.operationId,
            operationUrl: `/orgs/${orgId}/integrations/operations/${permit.operationId}`,
            reason: verified.reason,
          },
          202,
        );
      }
      if (verified.status === "multi_principal") {
        await database.withOrgScope(orgId, (client) =>
          IntegrationConnectionsStore.markAwaitingPrincipalSelection(
            client,
            orgId,
            permit.operationId,
            verified.candidates,
            { authKind: verified.authKind, scopes: verified.scopes },
          ),
        );
        return c.json(
          {
            status: "awaiting_principal_selection",
            operationId: permit.operationId,
            operationUrl: `/orgs/${orgId}/integrations/operations/${permit.operationId}`,
            candidates: verified.candidates,
          },
          202,
        );
      }
      try {
        const linked = await runSplitLinkFinalize(
          database,
          orgId,
          {
            permit: { ...permit, stagedSecretHandle: staged.handle },
            staged,
            principal: verified.principal,
            authKind: verified.authKind,
            scopes: verified.scopes,
            ...(verified.expiresAt === undefined ? {} : { expiresAt: verified.expiresAt }),
          },
          integrationSecrets,
        );
        return c.json(
          {
            status: "completed",
            operationId: permit.operationId,
            operationUrl: `/orgs/${orgId}/integrations/operations/${permit.operationId}`,
            providerKind,
            connectionId: linked.connectionId,
            grantId: linked.grantId,
            providerPrincipalId: linked.providerPrincipalId,
            displayName: linked.displayName,
            authGeneration: linked.authGeneration,
            grantGeneration: linked.grantGeneration,
            capabilities: catalogCapabilitiesForProvider(providerKind),
          },
          202,
        );
      } catch (error) {
        if (messageOf(error).includes("principal_already_linked")) {
          await integrationSecrets.compensate(staged);
          return c.json({ error: "principal_already_linked" }, 409);
        }
        await database.withOrgScope(orgId, (client) =>
          IntegrationConnectionsStore.markOperationFailed(client, orgId, permit.operationId, "finalize_failed"),
        );
        return c.json(
          {
            status: "failed",
            operationId: permit.operationId,
            operationUrl: `/orgs/${orgId}/integrations/operations/${permit.operationId}`,
            reason: "finalize_failed",
          },
          202,
        );
      }
    } catch (error) {
      const msg = messageOf(error);
      if (msg.includes("auth_generation_immutable_conflict") || msg.includes("grant_generation_immutable_conflict")) {
        return c.json({ error: "generation_immutable_conflict" }, 409);
      }
      if (msg.includes("principal_already_linked")) {
        return c.json({ error: "principal_already_linked" }, 409);
      }
      return c.json({ error: "link_failed" }, 500);
    }
  });

  app.post("/:orgId/integrations/:providerKind/connections/:connectionId/rotate", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const providerKind = c.req.param("providerKind");
    const connectionId = c.req.param("connectionId");
    if (!actorIsOrgAdmin(actor, orgId)) return c.json({ error: "org_admin_required" }, 403);
    if (!isKnownProviderKind(providerKind)) {
      return c.json({ error: "unknown_provider_kind" }, 400);
    }
    const parsed = RotateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_rotate", issues: parsed.error.issues }, 400);

    try {
      const permit = await database.withOrgScope(orgId, (client) =>
        authority.authorizePrincipalVerification(client, {
          orgId,
          providerKind,
          operationKind: "rotate",
          connectionId,
          idempotencyKey: parsed.data.idempotencyKey,
          actor: { kind: "operator", id: actor.userId },
        }),
      );
      const staged = await integrationSecrets.stage(permit.operationId, parsed.data.token);
      await database.withOrgScope(orgId, (client) =>
        IntegrationConnectionsStore.markOperationStaged(client, orgId, permit.operationId, staged.handle),
      );
      const verifier = principalVerifierFor(providerKind, fetchImpl);
      const verified = await verifier.verify(
        { ...permit, stagedSecretHandle: staged.handle },
        staged,
        integrationSecrets,
      );
      if (verified.status !== "verified") {
        await integrationSecrets.compensate(staged);
        await database.withOrgScope(orgId, (client) =>
          IntegrationConnectionsStore.markOperationFailed(
            client,
            orgId,
            permit.operationId,
            verified.status === "invalid" ? verified.reason : "multi_principal_on_rotate",
          ),
        );
        return c.json(
          {
            status: "failed",
            operationId: permit.operationId,
            operationUrl: `/orgs/${orgId}/integrations/operations/${permit.operationId}`,
            reason: verified.status === "invalid" ? verified.reason : "multi_principal_on_rotate",
          },
          202,
        );
      }
      const linked = await runSplitLinkFinalize(
        database,
        orgId,
        {
          permit: { ...permit, stagedSecretHandle: staged.handle },
          staged,
          principal: verified.principal,
          authKind: verified.authKind,
          scopes: verified.scopes,
        },
        integrationSecrets,
      );
      return c.json(
        {
          status: "completed",
          operationId: permit.operationId,
          operationUrl: `/orgs/${orgId}/integrations/operations/${permit.operationId}`,
          connectionId: linked.connectionId,
          authGeneration: linked.authGeneration,
          grantGeneration: linked.grantGeneration,
        },
        202,
      );
    } catch (error) {
      const msg = messageOf(error);
      if (msg.includes("auth_generation_immutable_conflict") || msg.includes("grant_generation_immutable_conflict")) {
        return c.json({ error: "generation_immutable_conflict" }, 409);
      }
      return c.json({ error: "rotate_failed" }, 500);
    }
  });

  app.post("/:orgId/integrations/operations/:operationId/principal", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const operationId = c.req.param("operationId");
    if (!actorIsOrgAdmin(actor, orgId)) return c.json({ error: "org_admin_required" }, 403);
    const parsed = PrincipalSelectBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_principal_selection", issues: parsed.error.issues }, 400);

    const op = await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.getOperation(client, orgId, operationId),
    );
    if (op === undefined) return c.json({ error: "operation_not_found" }, 404);
    if (op.status !== "awaiting_principal_selection") {
      return c.json({ error: "operation_not_awaiting_principal" }, 409);
    }
    const principal = op.candidatePrincipals.find(
      (candidate) => candidate.providerPrincipalId === parsed.data.providerPrincipalId,
    );
    if (principal === undefined) return c.json({ error: "unknown_principal_candidate" }, 400);
    if (op.stagedSecretHandle === undefined) return c.json({ error: "staged_secret_missing" }, 409);

    const staged = { handle: op.stagedSecretHandle, operationId: op.id };
    const branded = issuePrincipalVerificationPermit({
      orgId,
      providerKind: op.providerKind,
      operationId: op.id,
      actorId: actor.userId,
      stagedSecretHandle: op.stagedSecretHandle,
    });
    try {
      const linked = await runSplitLinkFinalize(
        database,
        orgId,
        {
          permit: branded,
          staged,
          principal,
          authKind: op.verifiedAuthKind ?? "api_key",
          scopes: op.verifiedScopes ?? [],
          selectedPrincipalId: principal.providerPrincipalId,
        },
        integrationSecrets,
      );
      return c.json(
        {
          status: "completed",
          operationId: op.id,
          connectionId: linked.connectionId,
          providerPrincipalId: linked.providerPrincipalId,
          authGeneration: linked.authGeneration,
          grantGeneration: linked.grantGeneration,
        },
        202,
      );
    } catch (error) {
      if (messageOf(error).includes("principal_already_linked")) {
        return c.json({ error: "principal_already_linked" }, 409);
      }
      return c.json({ error: "principal_selection_failed" }, 500);
    }
  });

  app.get("/:orgId/integrations/operations/:operationId", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const operationId = c.req.param("operationId");
    const op = await database.withOrgScope(orgId, (client) =>
      IntegrationConnectionsStore.getOperation(client, orgId, operationId),
    );
    if (op === undefined) return c.json({ error: "operation_not_found" }, 404);
    return c.json(
      {
        operationId: op.id,
        providerKind: op.providerKind,
        connectionId: op.connectionId,
        operationKind: op.operationKind,
        stage: op.stage,
        status: op.status,
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
