// in-20 — the integration-bindings read side of the integration HTTP read surface.
// Extracted from `integrationReadStore.ts` so each store module stays under the
// 500-line ceiling. Reads `integration_bindings` + `integration_binding_generations`
// + `integration_binding_env` and composes each binding's current-generation
// sealed view with the in-15 `appEnvHash` proof.
//
// REDACTION is structural here. The response carries `appEnvHash` — the content
// digest of the canonical app-env the materializer sealed at materialize time,
// stored as `integration_binding_generations.desired_state_hash` — and the
// logical output SHAPE from `integration_binding_env` (key + classification +
// required + scopes). It NEVER carries a resolved env value, a token, a
// principal secret, or a raw provider response body.

import type { IntegrationQueryClient } from "../../engine/repositories/integrationQuery.js";
import {
  INTEGRATION_READ_SURFACE_VERSION,
  IntegrationBindingListItem,
  IntegrationBindingOwnershipRead,
  IntegrationBindingOutputShapeView,
  IntegrationBindingTeardownPolicyRead,
  IntegrationBindingsResponse,
  IntegrationEnvironmentRead,
} from "./contract.js";
import type { IntegrationBindingCurrentGenerationView } from "./contract.js";
import { asDate, asStringArray, type IntegrationReadScope } from "./shared.js";

const Sha256 = /^sha256:[0-9a-f]{64}$/u;

interface BindingRow {
  binding_id: string;
  requirement_id: string;
  environment: string;
  provider_kind: string;
  connection_id: string;
  current_generation: number | null;
  status: string;
  drift_state: string;
  created_at: unknown;
  updated_at: unknown;
}

interface BindingGenerationRow {
  binding_id: string;
  generation: number;
  auth_generation: number;
  grant_id: string;
  grant_generation: number;
  adapter_version: string;
  external_resource_id: string;
  external_resource_name: string;
  ownership: string;
  teardown_policy: string;
  desired_state_hash: string;
}

interface BindingEnvRow {
  binding_id: string;
  binding_generation: number;
  key: string;
  classification: string;
  required: number;
  scopes: string[];
}

/**
 * Reads the project's bindings and composes each one's current-generation view
 * with the in-15 `appEnvHash` proof (= `integration_binding_generations.desired_state_hash`,
 * the content digest of the canonical app-env the materializer sealed). The
 * output SHAPE comes from `integration_binding_env` — logical keys + scopes
 * only; NEVER a resolved value. A binding whose `current_generation` is NULL
 * (still pending) surfaces `currentGeneration: null`.
 */
export async function listIntegrationBindings(
  client: IntegrationQueryClient,
  scope: IntegrationReadScope,
): Promise<IntegrationBindingsResponse> {
  const bindingResult = await client.query(
    `SELECT id AS binding_id, requirement_id, environment, provider_kind, connection_id,
            current_generation, status, drift_state, created_at, updated_at
       FROM integration_bindings
      WHERE org_id = $1 AND project_id = $2
      ORDER BY created_at DESC, id`,
    [scope.orgId, scope.projectId],
  );
  const bindingRows = bindingResult.rows as unknown as BindingRow[];
  if (bindingRows.length === 0) {
    return IntegrationBindingsResponse.parse({
      version: INTEGRATION_READ_SURFACE_VERSION,
      orgId: scope.orgId,
      projectId: scope.projectId,
      bindings: [],
    });
  }

  const bindingIds = bindingRows.map((row) => row.binding_id);
  const generationByBinding = new Map<string, BindingGenerationRow>();
  const envByBinding = new Map<string, BindingEnvRow[]>();

  if (bindingIds.length > 0) {
    const genResult = await client.query(
      `SELECT g.binding_id, g.generation, g.auth_generation, g.grant_id, g.grant_generation,
              g.adapter_version, g.external_resource_id, g.external_resource_name, g.ownership,
              g.teardown_policy, g.desired_state_hash
         FROM integration_binding_generations g
        WHERE g.org_id = $1 AND g.project_id = $2
          AND g.binding_id = ANY($3::text[])
          AND g.generation = ANY(
                SELECT b.current_generation
                  FROM integration_bindings b
                 WHERE b.org_id = g.org_id AND b.project_id = g.project_id
                   AND b.id = g.binding_id AND b.current_generation IS NOT NULL
              )`,
      [scope.orgId, scope.projectId, bindingIds],
    );
    for (const row of genResult.rows as unknown as BindingGenerationRow[]) {
      generationByBinding.set(row.binding_id, row);
    }

    const envResult = await client.query(
      `SELECT e.binding_id, e.binding_generation, e.key, e.classification, e.required, e.scopes
         FROM integration_binding_env e
        WHERE e.org_id = $1 AND e.project_id = $2
          AND e.binding_id = ANY($3::text[])
          AND (e.binding_id, e.binding_generation) IN (
                SELECT b.id, b.current_generation
                  FROM integration_bindings b
                 WHERE b.org_id = e.org_id AND b.project_id = e.project_id
                   AND b.id = e.binding_id AND b.current_generation IS NOT NULL
              )`,
      [scope.orgId, scope.projectId, bindingIds],
    );
    for (const row of envResult.rows as unknown as BindingEnvRow[]) {
      const list = envByBinding.get(row.binding_id) ?? [];
      list.push(row);
      envByBinding.set(row.binding_id, list);
    }
  }

  const bindings: IntegrationBindingListItem[] = bindingRows.map((row) => {
    const generation = generationByBinding.get(row.binding_id);
    const envRows = envByBinding.get(row.binding_id) ?? [];
    const currentGeneration = composeCurrentGeneration(row.binding_id, generation, envRows);
    return IntegrationBindingListItem.parse({
      bindingId: row.binding_id,
      requirementId: row.requirement_id,
      environment: IntegrationEnvironmentRead.parse(row.environment),
      providerKind: row.provider_kind,
      connectionId: row.connection_id,
      currentGenerationNumber: row.current_generation,
      status: row.status,
      driftState: row.drift_state,
      createdAt: asDate(row.created_at),
      updatedAt: asDate(row.updated_at),
      currentGeneration,
    });
  });

  return IntegrationBindingsResponse.parse({
    version: INTEGRATION_READ_SURFACE_VERSION,
    orgId: scope.orgId,
    projectId: scope.projectId,
    bindings,
  });
}

function composeCurrentGeneration(
  bindingId: string,
  generation: BindingGenerationRow | undefined,
  envRows: BindingEnvRow[],
): IntegrationBindingCurrentGenerationView | null {
  if (generation === undefined) return null;
  if (!Sha256.test(generation.desired_state_hash)) {
    throw new Error(`binding ${bindingId} generation ${generation.generation} has malformed desired_state_hash`);
  }
  const outputs: IntegrationBindingOutputShapeView[] = envRows.map((row) => {
    if (row.binding_generation !== generation.generation) {
      throw new Error(
        `binding ${bindingId} env row binding_generation ${row.binding_generation} does not match current generation ${generation.generation}`,
      );
    }
    // The output SHAPE — logical key + classification + required + scopes.
    // Validated through the contract Zod schema so a bad scope value (e.g. a
    // scope outside the build/test/runtime/dev closed set) fails closed.
    return IntegrationBindingOutputShapeView.parse({
      logicalKey: row.key,
      classification: row.classification,
      required: row.required === 1,
      scopes: asStringArray(row.scopes),
    });
  });
  if (outputs.length === 0) {
    throw new Error(`binding ${bindingId} generation ${generation.generation} has zero output-shape rows`);
  }
  return {
    generation: generation.generation,
    authGeneration: generation.auth_generation,
    grantId: generation.grant_id,
    grantGeneration: generation.grant_generation,
    adapterVersion: generation.adapter_version,
    resource: {
      externalResourceId: generation.external_resource_id,
      externalResourceName: generation.external_resource_name,
    },
    ownership: IntegrationBindingOwnershipRead.parse(generation.ownership),
    teardownPolicy: IntegrationBindingTeardownPolicyRead.parse(generation.teardown_policy),
    appEnvHash: generation.desired_state_hash,
    outputs,
  };
}
