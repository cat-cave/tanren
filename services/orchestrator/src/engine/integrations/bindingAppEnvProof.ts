/**
 * in-15: the appEnvHash PROOF gate over a materialized integration binding.
 *
 * Before a deploy consumes a binding's app-env, this gate INDEPENDENTLY recomputes
 * the binding's canonical `appEnvHash` from the durable materialized state —
 * `project_app_env` values (each secret resolved from its scoped Vault coordinate,
 * each plain read as-stored) + the exact-generation `integration_binding_env`
 * output shape + the immutable `integration_binding_generations` lineage — and
 * compares it to the generation's RECORDED `desired_state_hash` (the appEnvHash the
 * in-14 materializer sealed at materialize time).
 *
 * FAIL-CLOSED: `verified` is the ONLY pass. A binding whose materialized app-env
 * does not hash-match its recorded generation (tamper / drift), whose ready binding
 * has no recorded generation (missing), whose scoped secret can no longer be
 * resolved (unresolvable), or whose materialized keys diverge from the recorded
 * output shape (shape drift) is a BLOCK. Tamper-evident: change one env value and
 * the recomputed hash diverges from the sealed one → blocked.
 *
 * Every read runs on the caller's org-scoped client (RLS gates the tenant rows);
 * a cross-org caller sees zero bindings and the gate is a clean no-op for them.
 */

import { z } from "zod";
import {
  freezeBindingContract,
  type IntegrationBindingContractOutputV1,
  type IntegrationBindingContractV1,
} from "../contracts/integrationBindingContract.js";
import type { ExactSecretCoordinate, IntegrationSecretStore } from "../contracts/integrationSecretStore.js";
import type { IntegrationQueryClient } from "../repositories/integrationQuery.js";
import { APP_ENV_SCOPES, type AppEnvScope } from "../repositories/appEnvironment.js";
import type { BindingEnvironment } from "./bindingMaterializerStore.js";
import { computeBindingAppEnvHash, sha256Hex, type CanonicalAppEnvOutput } from "./bindingAppEnvHash.js";

/** The org / project / environment a project-wide proof gate runs against. */
export interface ProjectBindingProofScope {
  readonly orgId: string;
  readonly projectId: string;
  readonly environment: BindingEnvironment;
}

/**
 * The outcome of verifying one binding's appEnvHash proof. `verified` is the only
 * pass; every other arm is a fail-closed BLOCK carrying why.
 */
export type BindingAppEnvProofVerdict =
  | {
      readonly status: "verified";
      readonly bindingId: string;
      readonly generation: number;
      readonly contract: IntegrationBindingContractV1;
      readonly appEnvHash: string;
    }
  | {
      readonly status: "hash_mismatch";
      readonly bindingId: string;
      readonly generation: number;
      readonly contract: IntegrationBindingContractV1;
      readonly recordedHash: string;
      readonly recomputedHash: string;
    }
  | { readonly status: "missing_generation"; readonly bindingId: string }
  | {
      readonly status: "unresolved_secret";
      readonly bindingId: string;
      readonly generation: number;
      readonly key: string;
    }
  | {
      readonly status: "output_shape_mismatch";
      readonly bindingId: string;
      readonly generation: number;
      readonly detail: string;
    };

export function isProofVerified(
  verdict: BindingAppEnvProofVerdict,
): verdict is Extract<BindingAppEnvProofVerdict, { status: "verified" }> {
  return verdict.status === "verified";
}

/** One or more ready bindings failed the appEnvHash proof — the delivery gate BLOCKS. */
export class BindingAppEnvProofFailedError extends Error {
  public override readonly name = "BindingAppEnvProofFailedError";
  public readonly failures: readonly BindingAppEnvProofVerdict[];

  public constructor(scope: ProjectBindingProofScope, failures: readonly BindingAppEnvProofVerdict[]) {
    super(
      `appEnvHash proof gate BLOCKED delivery for project '${scope.projectId}' (org '${scope.orgId}', ` +
        `env '${scope.environment}'): ${failures.map((f) => `${f.bindingId}=${f.status}`).join(", ")}`,
    );
    this.failures = failures;
  }
}

const GenerationRow = z.object({
  current_generation: z.coerce.number().int().positive(),
  requirement_id: z.string(),
  environment: z.enum(["test", "preview", "production"]),
  desired_state_hash: z.string(),
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
  status: z.enum(["pending", "ready", "drifted", "needs_attention", "retired"]),
  drift_state: z.enum(["unknown", "in_sync", "drifted"]),
});
type GenerationRow = z.infer<typeof GenerationRow>;

const MaterializedOutputRow = z.object({
  key: z.string(),
  classification: z.enum(["secret", "non_secret"]),
  required: z.coerce.number().int(),
  scopes: z.array(z.string()).nullable(),
  value_ref: z.string().nullable(),
  secret_generation: z.coerce.number().int().positive().nullable(),
  plain_value: z.string().nullable(),
});

const CountRow = z.object({ n: z.coerce.number().int().nonnegative() });

function toScopes(raw: readonly string[] | null): AppEnvScope[] {
  const valid = new Set<string>(APP_ENV_SCOPES);
  return (raw ?? []).filter((scope): scope is AppEnvScope => valid.has(scope));
}

/** Load the ready binding's current generation + lineage, or `undefined` (missing). */
async function loadReadyGeneration(
  client: IntegrationQueryClient,
  scope: ProjectBindingProofScope,
  bindingId: string,
): Promise<GenerationRow | undefined> {
  const result = await client.query(
    `SELECT b.current_generation, g.requirement_id, g.environment, g.desired_state_hash,
            g.provider_kind, g.connection_id, g.auth_generation, g.grant_id,
            g.grant_generation, g.adapter_version, g.external_resource_id,
            g.external_resource_name, g.ownership, g.teardown_policy, g.status, g.drift_state
       FROM integration_bindings b
       JOIN integration_binding_generations g
         ON g.org_id = b.org_id AND g.project_id = b.project_id
        AND g.binding_id = b.id AND g.generation = b.current_generation
      WHERE b.org_id = $1 AND b.project_id = $2 AND b.id = $3
        AND b.environment = $4 AND b.status = 'ready' AND b.current_generation IS NOT NULL`,
    [scope.orgId, scope.projectId, bindingId, scope.environment],
  );
  const raw = result.rows[0];
  return raw === undefined ? undefined : GenerationRow.parse(raw);
}

/** The immutable output SHAPE + a proof descriptor for one binding contract. */
function contractFrom(
  scope: ProjectBindingProofScope,
  bindingId: string,
  gen: GenerationRow,
  outputs: readonly IntegrationBindingContractOutputV1[],
): IntegrationBindingContractV1 {
  return freezeBindingContract({
    version: 1,
    orgId: scope.orgId,
    projectId: scope.projectId,
    requirementId: gen.requirement_id,
    environment: gen.environment,
    bindingId,
    generation: gen.current_generation,
    providerKind: gen.provider_kind,
    connectionId: gen.connection_id,
    authGeneration: gen.auth_generation,
    grantId: gen.grant_id,
    grantGeneration: gen.grant_generation,
    adapterVersion: gen.adapter_version,
    resource: { externalResourceId: gen.external_resource_id, externalResourceName: gen.external_resource_name },
    ownership: gen.ownership,
    teardownPolicy: gen.teardown_policy,
    outputs,
    appEnvHash: gen.desired_state_hash,
    status: gen.status,
    driftState: gen.drift_state,
  });
}

/**
 * Verify one binding's materialized app-env against its immutable recorded
 * generation. Reads only the caller's org-scoped rows.
 */
export async function verifyBindingAppEnvProof(
  client: IntegrationQueryClient,
  secrets: IntegrationSecretStore,
  scope: ProjectBindingProofScope,
  bindingId: string,
): Promise<BindingAppEnvProofVerdict> {
  const gen = await loadReadyGeneration(client, scope, bindingId);
  if (gen === undefined) return { status: "missing_generation", bindingId };
  const generation = gen.current_generation;

  // The exact-generation output shape LEFT JOINed onto the materialized rows the
  // deploy is about to consume (secret coordinate + plain value).
  const rows = await client.query(
    `SELECT e.key, e.classification, e.required, e.scopes,
            pae.value_ref, pae.secret_generation, pae.plain_value
       FROM integration_binding_env e
       LEFT JOIN project_app_env pae
         ON pae.org_id = e.org_id AND pae.project_id = e.project_id
        AND pae.binding_id = e.binding_id AND pae.binding_generation = e.binding_generation
        AND pae.key = e.key AND pae.environment = $5
      WHERE e.org_id = $1 AND e.project_id = $2 AND e.binding_id = $3 AND e.binding_generation = $4
      ORDER BY e.key`,
    [scope.orgId, scope.projectId, bindingId, generation, gen.environment],
  );

  const shape: IntegrationBindingContractOutputV1[] = [];
  const canonical: CanonicalAppEnvOutput[] = [];
  for (const raw of rows.rows) {
    const out = MaterializedOutputRow.parse(raw);
    const scopes = toScopes(out.scopes);
    shape.push({
      logicalKey: out.key,
      classification: out.classification,
      required: out.required === 1,
      scopes,
    });
    if (out.classification === "secret") {
      // A declared secret with no materialized coordinate is shape drift (the row
      // the deploy would consume is missing) — fail closed before resolving.
      if (out.value_ref === null || out.secret_generation === null) {
        return {
          status: "output_shape_mismatch",
          bindingId,
          generation,
          detail: `secret output '${out.key}' has no materialized project_app_env coordinate`,
        };
      }
      const coordinate: ExactSecretCoordinate = { ref: out.value_ref, generation: out.secret_generation };
      const material = await secrets.getExact(coordinate);
      if (material === undefined || material === "") {
        return { status: "unresolved_secret", bindingId, generation, key: out.key };
      }
      canonical.push({
        key: out.key,
        secret: true,
        required: out.required === 1,
        scopes,
        valueDigest: sha256Hex(material),
      });
    } else {
      if (out.plain_value === null) {
        return {
          status: "output_shape_mismatch",
          bindingId,
          generation,
          detail: `non-secret output '${out.key}' has no materialized project_app_env value`,
        };
      }
      canonical.push({
        key: out.key,
        secret: false,
        required: out.required === 1,
        scopes,
        valueDigest: sha256Hex(out.plain_value),
      });
    }
  }

  if (canonical.length === 0) {
    return { status: "output_shape_mismatch", bindingId, generation, detail: "binding generation has no output shape" };
  }

  // Extra-row defense: a project_app_env row provisioned under this exact
  // (binding, generation) that is NOT in the recorded output shape is an injected
  // env var — shape drift, fail closed.
  const provisionedCount = await client.query(
    `SELECT count(*)::int AS n FROM project_app_env
      WHERE org_id = $1 AND project_id = $2 AND environment = $3
        AND binding_id = $4 AND binding_generation = $5`,
    [scope.orgId, scope.projectId, gen.environment, bindingId, generation],
  );
  const materializedRows = CountRow.parse(provisionedCount.rows[0] ?? { n: 0 }).n;
  if (materializedRows !== canonical.length) {
    return {
      status: "output_shape_mismatch",
      bindingId,
      generation,
      detail: `materialized ${materializedRows} project_app_env rows for a ${canonical.length}-key output shape`,
    };
  }

  const contract = contractFrom(scope, bindingId, gen, shape);
  const recomputedHash = computeBindingAppEnvHash(
    {
      providerKind: gen.provider_kind,
      connectionId: gen.connection_id,
      authGeneration: gen.auth_generation,
      grantId: gen.grant_id,
      grantGeneration: gen.grant_generation,
      adapterVersion: gen.adapter_version,
      externalResourceId: gen.external_resource_id,
      externalResourceName: gen.external_resource_name,
      ownership: gen.ownership,
      teardownPolicy: gen.teardown_policy,
      environment: gen.environment,
    },
    canonical,
  );
  if (recomputedHash !== gen.desired_state_hash) {
    return {
      status: "hash_mismatch",
      bindingId,
      generation,
      contract,
      recordedHash: gen.desired_state_hash,
      recomputedHash,
    };
  }
  return { status: "verified", bindingId, generation, contract, appEnvHash: recomputedHash };
}

/** Every `ready` binding id of the project/environment, sorted. */
async function readyBindingIds(client: IntegrationQueryClient, scope: ProjectBindingProofScope): Promise<string[]> {
  const result = await client.query(
    `SELECT b.id AS ready_binding_id
       FROM integration_bindings b
      WHERE b.org_id = $1 AND b.project_id = $2 AND b.environment = $3
        AND b.status = 'ready' AND b.current_generation IS NOT NULL
      ORDER BY b.id`,
    [scope.orgId, scope.projectId, scope.environment],
  );
  return result.rows.map((raw) => z.object({ ready_binding_id: z.string() }).parse(raw).ready_binding_id);
}

/** Verify every ready binding of the project/environment (one verdict each). */
export async function verifyReadyProjectBindingProofs(
  client: IntegrationQueryClient,
  secrets: IntegrationSecretStore,
  scope: ProjectBindingProofScope,
): Promise<BindingAppEnvProofVerdict[]> {
  const verdicts: BindingAppEnvProofVerdict[] = [];
  for (const bindingId of await readyBindingIds(client, scope)) {
    verdicts.push(await verifyBindingAppEnvProof(client, secrets, scope, bindingId));
  }
  return verdicts;
}

/**
 * Assert every ready binding of the project/environment proves its appEnvHash.
 * Returns the frozen verified contracts; throws {@link BindingAppEnvProofFailedError}
 * (BLOCK) if any binding does not verify. A project with no ready bindings is a
 * clean no-op (empty array).
 */
export async function assertReadyProjectBindingProofs(
  client: IntegrationQueryClient,
  secrets: IntegrationSecretStore,
  scope: ProjectBindingProofScope,
): Promise<IntegrationBindingContractV1[]> {
  const verdicts = await verifyReadyProjectBindingProofs(client, secrets, scope);
  const verified: IntegrationBindingContractV1[] = [];
  const failures: BindingAppEnvProofVerdict[] = [];
  for (const verdict of verdicts) {
    if (isProofVerified(verdict)) verified.push(verdict.contract);
    else failures.push(verdict);
  }
  if (failures.length > 0) throw new BindingAppEnvProofFailedError(scope, failures);
  return verified;
}
