/**
 * in-14: BindingMaterializer.
 *
 * Given a RESOLVED integration binding (lineage + provider/connection/auth/grant
 * coordinates + the provisioned external resource + the declared app-env outputs),
 * materialize it into the project's runnable app environment:
 *
 *   1. mint a SCOPED, least-privilege Vault secret ref per SECRET output
 *      (org + project + binding + key scoped, create-only, never a plaintext
 *      fallback), sourced from the binding's connection credential;
 *   2. persist an immutable `integration_binding_generations` row keyed by a
 *      content hash of the resolved desired state (append-only — a changed input
 *      mints the next generation; identical input is a no-op);
 *   3. record the exact-generation output shape in `integration_binding_env`;
 *   4. write the provisioned `project_app_env` rows (secret rows carry the scoped
 *      Vault ref + secret generation; non-secret rows carry the plain value);
 *   5. advance the stable binding's current-generation pointer.
 *
 * FAIL-CLOSED: a secret output whose source material cannot be resolved, or any
 * invalid output, aborts BEFORE any write — the caller's transaction rolls back
 * every row and every freshly-minted Vault secret is compensated. No partial
 * `project_app_env`, no placeholder secret ref, ever persists.
 *
 * Every write runs on the caller's org-scoped client (RLS gates the tenant rows).
 * Vault minting is create-only, so a rolled-back-then-retried materialization is
 * idempotent (identical bytes at an occupied coordinate is success).
 */

import type { ActorRef } from "../state/actor.js";
import { computeBindingAppEnvHash, sha256Hex, type CanonicalAppEnvOutput } from "./bindingAppEnvHash.js";
import type {
  ExactSecretCoordinate,
  IntegrationSecretStore,
  StagedSecretHandle,
} from "../contracts/integrationSecretStore.js";
import type { IntegrationQueryClient } from "../repositories/integrationQuery.js";
import { AppEnvironmentStore, type AppEnvScope } from "../repositories/appEnvironment.js";
import {
  BindingMaterializerStore,
  type BindingEnvironment,
  type BindingGenerationRecord,
  type BindingOwnership,
  type BindingTeardownPolicy,
} from "./bindingMaterializerStore.js";

/** A single app-env output the resolved binding projects into the product. */
export interface ResolvedBindingOutput {
  /** The env KEY the product consumes (AppBindingOutputV1.logicalKey). */
  readonly logicalKey: string;
  /** True when the value is a secret (minted into Vault), false for plain config. */
  readonly secret: boolean;
  /** Whether the product requires this key to be present. */
  readonly required: boolean;
  /** App-env phases this value reaches (defaults to `["runtime"]` when empty). */
  readonly scopes: readonly AppEnvScope[];
  /**
   * SECRET output only: the coordinate to READ the source secret material from
   * (the binding's connection credential). The materializer re-mints it into a
   * project-scoped least-privilege ref — the product never reads the org-wide
   * connection credential directly.
   */
  readonly secretSource?: ExactSecretCoordinate;
  /** NON-SECRET output only: the plaintext config value. */
  readonly plainValue?: string;
}

/** The fully-resolved binding the materializer turns into runnable app env. */
export interface ResolvedBinding {
  readonly orgId: string;
  readonly projectId: string;
  readonly requirementId: string;
  readonly environment: BindingEnvironment;
  readonly bindingId: string;
  readonly providerKind: string;
  readonly connectionId: string;
  readonly authGeneration: number;
  readonly grantId: string;
  readonly grantGeneration: number;
  readonly adapterVersion: string;
  readonly externalResourceId: string;
  readonly externalResourceName: string;
  readonly ownership: BindingOwnership;
  readonly teardownPolicy: BindingTeardownPolicy;
  readonly outputs: readonly ResolvedBindingOutput[];
}

/** The outcome of a materialization — never any secret value. */
export interface MaterializedBinding {
  readonly bindingId: string;
  readonly generation: number;
  /** The content hash addressing this generation (`sha256:<64 hex>`). */
  readonly desiredStateHash: string;
  /** The env KEY NAMES materialized, sorted. Never any value. */
  readonly materializedKeys: readonly string[];
  /** True when identical content already existed — no new generation was minted. */
  readonly reused: boolean;
}

/** A resolved output was structurally invalid (fail-closed before any write). */
export class BindingOutputInvalidError extends Error {
  public override readonly name = "BindingOutputInvalidError";
}

/** A required secret output's source material could not be resolved (fail-closed). */
export class BindingSecretUnresolvedError extends Error {
  public override readonly name = "BindingSecretUnresolvedError";
}

/** The base Vault ref for a binding output's scoped, least-privilege secret. */
export function bindingEnvSecretBaseRef(
  orgId: string,
  projectId: string,
  bindingId: string,
  logicalKey: string,
): string {
  return (
    `secret://org/${encodeURIComponent(orgId)}` +
    `/project/${encodeURIComponent(projectId)}` +
    `/binding/${encodeURIComponent(bindingId)}` +
    `/env/${encodeURIComponent(logicalKey)}`
  );
}

const LOGICAL_KEY = /^[A-Z][A-Z0-9_]*$/u;

function assertResolved(resolved: ResolvedBinding): void {
  if (resolved.externalResourceId === "" || resolved.externalResourceName === "") {
    throw new BindingOutputInvalidError(
      `binding '${resolved.bindingId}' cannot materialize without a provisioned external resource`,
    );
  }
  if (resolved.outputs.length === 0) {
    throw new BindingOutputInvalidError(`binding '${resolved.bindingId}' has no app-env outputs to materialize`);
  }
  const seen = new Set<string>();
  for (const output of resolved.outputs) {
    if (!LOGICAL_KEY.test(output.logicalKey)) {
      throw new BindingOutputInvalidError(`binding output key '${output.logicalKey}' is not a valid env key`);
    }
    if (seen.has(output.logicalKey)) {
      throw new BindingOutputInvalidError(`binding output key '${output.logicalKey}' is declared twice`);
    }
    seen.add(output.logicalKey);
    if (output.secret) {
      if (output.secretSource === undefined) {
        throw new BindingOutputInvalidError(`secret output '${output.logicalKey}' is missing its secret source`);
      }
      if (output.plainValue !== undefined) {
        throw new BindingOutputInvalidError(`secret output '${output.logicalKey}' must not carry a plain value`);
      }
    } else {
      if (output.plainValue === undefined) {
        throw new BindingOutputInvalidError(`non-secret output '${output.logicalKey}' is missing its plain value`);
      }
      if (output.secretSource !== undefined) {
        throw new BindingOutputInvalidError(`non-secret output '${output.logicalKey}' must not carry a secret source`);
      }
    }
  }
}

const scopesOf = (output: ResolvedBindingOutput): AppEnvScope[] =>
  output.scopes.length === 0 ? ["runtime"] : [...output.scopes];

/**
 * The content hash addressing the generation — the canonical `appEnvHash` (in-15).
 * Includes a digest of every resolved value (secret material or plain text) so a
 * rotated secret or changed config mints the NEXT generation, while identical
 * content is idempotent. Never embeds plaintext — only per-value digests. The
 * in-15 proof gate recomputes this EXACT hash from durable state to verify a
 * materialized app-env still matches its immutable recorded generation.
 *
 * Scopes are hashed via {@link scopesOf} — the SAME normalized/defaulted form that
 * is actually WRITTEN to `integration_binding_env` + `project_app_env`. Record ==
 * stored == verify: hashing raw scopes here would diverge from the gate's recompute
 * (which reads the stored form) and false-fail a valid binding with empty/defaulted
 * scopes.
 */
function computeDesiredStateHash(resolved: ResolvedBinding, materials: ReadonlyMap<string, string>): string {
  const outputs: CanonicalAppEnvOutput[] = resolved.outputs.map((output) => ({
    key: output.logicalKey,
    secret: output.secret,
    required: output.required,
    scopes: scopesOf(output),
    valueDigest: sha256Hex(
      output.secret ? (materials.get(output.logicalKey) as string) : (output.plainValue as string),
    ),
  }));
  return computeBindingAppEnvHash(resolved, outputs);
}

/** Resolve every secret output's source material, fail-closed on any miss. */
async function resolveSecretMaterials(
  secrets: IntegrationSecretStore,
  resolved: ResolvedBinding,
): Promise<Map<string, string>> {
  const materials = new Map<string, string>();
  for (const output of resolved.outputs) {
    if (!output.secret) continue;
    const source = output.secretSource as ExactSecretCoordinate;
    const value = await secrets.getExact(source);
    if (value === undefined || value === "") {
      throw new BindingSecretUnresolvedError(
        `secret output '${output.logicalKey}' for binding '${resolved.bindingId}' has no resolvable source material`,
      );
    }
    materials.set(output.logicalKey, value);
  }
  return materials;
}

/**
 * Materialize a resolved binding into `project_app_env` + a scoped Vault ref per
 * secret + an immutable generation. Runs on the caller-provided org-scoped client
 * INSIDE the caller's transaction (so partial writes roll back). Idempotent:
 * identical content returns the current generation without minting a new one.
 */
export async function materializeBinding(
  client: IntegrationQueryClient,
  secrets: IntegrationSecretStore,
  resolved: ResolvedBinding,
  actor: ActorRef,
): Promise<MaterializedBinding> {
  assertResolved(resolved);

  // (1) Resolve every secret's SOURCE material up front — fail-closed before any
  // write or mint, so a missing secret can never leave a partial materialization.
  const materials = await resolveSecretMaterials(secrets, resolved);
  const desiredStateHash = computeDesiredStateHash(resolved, materials);
  const materializedKeys = resolved.outputs.map((o) => o.logicalKey).sort();

  // (2) Idempotency: identical content at the current generation is a no-op.
  const current = await BindingMaterializerStore.loadCurrentGeneration(
    client,
    resolved.orgId,
    resolved.projectId,
    resolved.bindingId,
  );
  if (current !== undefined && current.desiredStateHash === desiredStateHash) {
    return {
      bindingId: resolved.bindingId,
      generation: current.generation,
      desiredStateHash,
      materializedKeys,
      reused: true,
    };
  }

  // (3) Claim the next immutable generation BEFORE minting any secret, so a
  // concurrent materializer conflicts on the generation PK with nothing minted.
  await BindingMaterializerStore.ensureBindingRow(client, generationRecord(resolved, 0, desiredStateHash));
  const generation =
    (await BindingMaterializerStore.maxGeneration(client, resolved.orgId, resolved.projectId, resolved.bindingId)) + 1;
  await BindingMaterializerStore.insertGeneration(client, generationRecord(resolved, generation, desiredStateHash));

  const staged: StagedSecretHandle[] = [];
  const minted: ExactSecretCoordinate[] = [];
  try {
    for (const output of resolved.outputs) {
      const scopes = scopesOf(output);
      await BindingMaterializerStore.insertBindingEnv(
        client,
        { orgId: resolved.orgId, projectId: resolved.projectId, bindingId: resolved.bindingId, generation },
        {
          key: output.logicalKey,
          classification: output.secret ? "secret" : "non_secret",
          required: output.required,
          scopes,
        },
      );
      if (output.secret) {
        // (4) Mint the project-scoped least-privilege secret from the resolved
        // source material (create-only Vault CAS; never a plaintext fallback).
        const material = materials.get(output.logicalKey) as string;
        const operationId = `binding-materialize:${resolved.orgId}:${resolved.projectId}:${resolved.bindingId}:${generation}:${output.logicalKey}`;
        const handle = await secrets.stage(operationId, material);
        staged.push(handle);
        const baseRef = bindingEnvSecretBaseRef(
          resolved.orgId,
          resolved.projectId,
          resolved.bindingId,
          output.logicalKey,
        );
        const coordinate = await secrets.finalize(handle, baseRef, generation);
        minted.push(coordinate);
        await AppEnvironmentStore.upsert(
          client,
          {
            orgId: resolved.orgId,
            projectId: resolved.projectId,
            environment: resolved.environment,
            key: output.logicalKey,
            valueRef: coordinate.ref,
            secretGeneration: generation,
            scopes,
            source: "provisioned",
            bindingId: resolved.bindingId,
            bindingGeneration: generation,
          },
          actor,
        );
      } else {
        await AppEnvironmentStore.upsert(
          client,
          {
            orgId: resolved.orgId,
            projectId: resolved.projectId,
            environment: resolved.environment,
            key: output.logicalKey,
            plainValue: output.plainValue as string,
            scopes,
            source: "provisioned",
            bindingId: resolved.bindingId,
            bindingGeneration: generation,
          },
          actor,
        );
      }
    }
    await BindingMaterializerStore.advanceBindingCurrentGeneration(
      client,
      resolved.orgId,
      resolved.bindingId,
      generation,
    );
  } catch (error) {
    // Fail-closed: compensate every freshly-minted / staged secret so no orphaned
    // coordinate survives the caller's transaction rollback.
    await Promise.allSettled([
      ...minted.map((coordinate) => secrets.compensate(coordinate)),
      ...staged.map((handle) => secrets.compensate(handle)),
    ]);
    throw error;
  }

  // Success: drop the staged temporaries (the generation coordinates persist).
  await Promise.allSettled(staged.map((handle) => secrets.completeStaged(handle)));
  return { bindingId: resolved.bindingId, generation, desiredStateHash, materializedKeys, reused: false };
}

function generationRecord(
  resolved: ResolvedBinding,
  generation: number,
  desiredStateHash: string,
): BindingGenerationRecord {
  return {
    orgId: resolved.orgId,
    projectId: resolved.projectId,
    requirementId: resolved.requirementId,
    environment: resolved.environment,
    bindingId: resolved.bindingId,
    generation,
    providerKind: resolved.providerKind,
    connectionId: resolved.connectionId,
    authGeneration: resolved.authGeneration,
    grantId: resolved.grantId,
    grantGeneration: resolved.grantGeneration,
    adapterVersion: resolved.adapterVersion,
    externalResourceId: resolved.externalResourceId,
    externalResourceName: resolved.externalResourceName,
    ownership: resolved.ownership,
    teardownPolicy: resolved.teardownPolicy,
    desiredStateHash,
    status: "ready",
  };
}
