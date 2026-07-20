/**
 * in-14 production seam: materialize a project's resolved integration bindings
 * into runnable app env BEFORE the deploy trigger reads `project_app_env`.
 *
 * Invoked on the live deploy-on-merge path ({@link deployOnMergeShared}) ahead of
 * `attachRuntimeAppEnv`. For every `ready` binding of the project/environment that
 * already carries a current generation, it reconstructs the resolved binding from
 * durable lifecycle state (the immutable generation row, the exact-generation
 * output shape, the connection credential as each secret's source, and the current
 * plain config values) and re-drives {@link materializeBinding}.
 *
 * Because materialization is content-addressed, a binding whose desired state is
 * unchanged reconciles idempotently (same generation, no new Vault write). The
 * guard's teeth are fail-closed: if a required secret source can no longer be
 * resolved, or a plain output value is missing, it throws LOUD before the deploy —
 * a broken binding never ships as a silently-empty env.
 */

import type { Pool } from "pg";
import { runWithOrgScope } from "@tanren/db";
import { z } from "zod";
import type { ActorRef } from "../state/actor.js";
import type { IntegrationSecretStore } from "../contracts/integrationSecretStore.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { GenerationAddressedIntegrationSecretStore } from "../integrations/integrationSecretStoreImpl.js";
import type { IntegrationQueryClient } from "../repositories/integrationQuery.js";
import { APP_ENV_SCOPES, type AppEnvScope } from "../repositories/appEnvironment.js";
import {
  materializeBinding,
  BindingOutputInvalidError,
  type MaterializedBinding,
  type ResolvedBinding,
  type ResolvedBindingOutput,
} from "../integrations/bindingMaterializer.js";
import type { BindingEnvironment } from "../integrations/bindingMaterializerStore.js";

/** The org/project/environment + collaborators a reconcile runs against. */
export interface ReconcileBindingsScope {
  readonly secrets: IntegrationSecretStore;
  readonly orgId: string;
  readonly projectId: string;
  readonly environment: BindingEnvironment;
  readonly actor: ActorRef;
}

export interface MaterializeProjectBindingsDeps extends ReconcileBindingsScope {
  readonly pool: Pool;
}

const ReadyBindingRow = z.object({
  binding_id: z.string(),
  requirement_id: z.string(),
  provider_kind: z.string(),
  connection_id: z.string(),
  auth_generation: z.coerce.number().int().positive(),
  grant_id: z.string(),
  grant_generation: z.coerce.number().int().positive(),
  adapter_version: z.string(),
  external_resource_id: z.string(),
  external_resource_name: z.string(),
  ownership: z.enum(["created", "adopted", "shared"]),
  teardown_policy: z.enum(["delete", "retain"]),
  credential_ref: z.string(),
});
type ReadyBindingRow = z.infer<typeof ReadyBindingRow>;

const OutputRow = z.object({
  key: z.string(),
  classification: z.enum(["secret", "non_secret"]),
  required: z.coerce.number().int(),
  scopes: z.array(z.string()).nullable(),
  plain_value: z.string().nullable(),
});

function toScopes(raw: readonly string[] | null): AppEnvScope[] {
  const valid = new Set<string>(APP_ENV_SCOPES);
  return (raw ?? []).filter((scope): scope is AppEnvScope => valid.has(scope));
}

async function loadResolvedBinding(
  client: IntegrationQueryClient,
  deps: ReconcileBindingsScope,
  row: ReadyBindingRow,
  generation: number,
): Promise<ResolvedBinding> {
  const result = await client.query(
    `SELECT e.key, e.classification, e.required, e.scopes, pae.plain_value
       FROM integration_binding_env e
       LEFT JOIN project_app_env pae
         ON pae.org_id = e.org_id AND pae.project_id = e.project_id
        AND pae.binding_id = e.binding_id AND pae.binding_generation = e.binding_generation
        AND pae.key = e.key
      WHERE e.org_id = $1 AND e.project_id = $2 AND e.binding_id = $3 AND e.binding_generation = $4
      ORDER BY e.key`,
    [deps.orgId, deps.projectId, row.binding_id, generation],
  );
  const outputs: ResolvedBindingOutput[] = result.rows.map((raw) => {
    const out = OutputRow.parse(raw);
    if (out.classification === "secret") {
      return {
        logicalKey: out.key,
        secret: true,
        required: out.required === 1,
        scopes: toScopes(out.scopes),
        // The scoped project secret is re-minted from the authoritative connection
        // credential each reconcile — self-healing + fail-closed if it is revoked.
        secretSource: { ref: row.credential_ref, generation: row.auth_generation },
      };
    }
    if (out.plain_value === null) {
      throw new BindingOutputInvalidError(
        `binding '${row.binding_id}' non-secret output '${out.key}' has no persisted value to reconcile`,
      );
    }
    return {
      logicalKey: out.key,
      secret: false,
      required: out.required === 1,
      scopes: toScopes(out.scopes),
      plainValue: out.plain_value,
    };
  });
  return {
    orgId: deps.orgId,
    projectId: deps.projectId,
    requirementId: row.requirement_id,
    environment: deps.environment,
    bindingId: row.binding_id,
    providerKind: row.provider_kind,
    connectionId: row.connection_id,
    authGeneration: row.auth_generation,
    grantId: row.grant_id,
    grantGeneration: row.grant_generation,
    adapterVersion: row.adapter_version,
    externalResourceId: row.external_resource_id,
    externalResourceName: row.external_resource_name,
    ownership: row.ownership,
    teardownPolicy: row.teardown_policy,
    outputs,
  };
}

/**
 * Reconcile every ready binding of the project/environment into `project_app_env`
 * on the given (org-scoped, in-transaction) client. Returns one
 * {@link MaterializedBinding} per ready binding; no ready bindings is a clean no-op.
 * The transactional/org-scoped wrapper is {@link materializeReadyProjectBindings}.
 */
export async function reconcileReadyBindings(
  client: IntegrationQueryClient,
  deps: ReconcileBindingsScope,
): Promise<MaterializedBinding[]> {
  const ready = await client.query(
    `SELECT b.id AS binding_id, b.requirement_id, g.provider_kind, g.connection_id,
            g.auth_generation, g.grant_id, g.grant_generation, g.adapter_version,
            g.external_resource_id, g.external_resource_name, g.ownership,
            g.teardown_policy, ag.credential_ref, b.current_generation
       FROM integration_bindings b
       JOIN integration_binding_generations g
         ON g.org_id = b.org_id AND g.project_id = b.project_id
        AND g.binding_id = b.id AND g.generation = b.current_generation
       JOIN org_integration_connection_auth_generations ag
         ON ag.org_id = b.org_id AND ag.provider_kind = g.provider_kind
        AND ag.connection_id = g.connection_id AND ag.generation = g.auth_generation
      WHERE b.org_id = $1 AND b.project_id = $2 AND b.environment = $3
        AND b.status = 'ready' AND b.current_generation IS NOT NULL
      ORDER BY b.id`,
    [deps.orgId, deps.projectId, deps.environment],
  );

  const results: MaterializedBinding[] = [];
  for (const raw of ready.rows) {
    const parsed = z.object({ current_generation: z.coerce.number().int().positive() }).and(ReadyBindingRow).parse(raw);
    const resolved = await loadResolvedBinding(client, deps, parsed, parsed.current_generation);
    results.push(await materializeBinding(client, deps.secrets, resolved, deps.actor));
  }
  return results;
}

/**
 * Org-scoped + transactional wrapper over {@link reconcileReadyBindings} (RLS gates
 * the rows; a partial reconcile rolls back).
 */
export async function materializeReadyProjectBindings(
  deps: MaterializeProjectBindingsDeps,
): Promise<MaterializedBinding[]> {
  return runWithOrgScope(deps.pool, deps.orgId, (client) => reconcileReadyBindings(client, deps));
}

/**
 * Deploy-path entry point: wrap the global {@link SecretStore} as the generation-
 * addressed integration secret store and reconcile the project's PRODUCTION
 * bindings. The single call {@link deployOnMergeShared} makes before attaching the
 * runtime env.
 */
export function materializeProductionBindingsForDeploy(
  pool: Pool,
  secrets: SecretStore,
  orgId: string,
  projectId: string,
  actor: ActorRef,
): Promise<MaterializedBinding[]> {
  return materializeReadyProjectBindings({
    pool,
    secrets: new GenerationAddressedIntegrationSecretStore(secrets),
    orgId,
    projectId,
    environment: "production",
    actor,
  });
}
