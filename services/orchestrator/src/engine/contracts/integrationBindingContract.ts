/**
 * in-15: IntegrationBindingContractV1 — the immutable, proof-bearing typed
 * contract over one exact `integration_binding_generations` row (in-14).
 *
 * It is a FROZEN descriptor of a binding generation the delivery gate reasons
 * about: resource identity, provider/adapter versions, the exact auth+grant
 * generations, the app-env output SHAPE (logical env keys + classification +
 * required flag + phase scopes), and the content-addressed `appEnvHash` (the
 * generation's recorded `desired_state_hash`). It NEVER carries a secret value or
 * a plain config value — only the immutable shape + the hash that proves it.
 *
 * The gate recomputes the `appEnvHash` from the materialized `project_app_env`
 * and compares it to `contract.appEnvHash`: a match proves the app-env the deploy
 * is about to consume IS the immutable app-env this generation recorded; any
 * mismatch (tamper / drift) fails closed.
 */

import { z } from "zod";

const LOGICAL_KEY = /^[A-Z][A-Z0-9_]*$/u;
const APP_ENV_HASH = /^sha256:[0-9a-f]{64}$/u;

/** One immutable output-shape entry — a logical env key, never a value. */
export const IntegrationBindingContractOutputV1Schema = z
  .object({
    logicalKey: z.string().min(1).max(128).regex(LOGICAL_KEY),
    classification: z.enum(["secret", "non_secret"]),
    required: z.boolean(),
    scopes: z.array(z.enum(["build", "test", "runtime", "dev"])).min(1),
  })
  .strict();

export type IntegrationBindingContractOutputV1 = z.infer<typeof IntegrationBindingContractOutputV1Schema>;

export const IntegrationBindingContractV1Schema = z
  .object({
    version: z.literal(1),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    requirementId: z.string().min(1),
    environment: z.enum(["test", "preview", "production"]),
    bindingId: z.string().min(1),
    generation: z.number().int().positive(),
    providerKind: z.string().min(1),
    connectionId: z.string().min(1),
    authGeneration: z.number().int().positive(),
    grantId: z.string().min(1),
    grantGeneration: z.number().int().positive(),
    adapterVersion: z.string().min(1),
    resource: z.object({ externalResourceId: z.string().min(1), externalResourceName: z.string().min(1) }).strict(),
    ownership: z.enum(["created", "adopted", "shared"]),
    teardownPolicy: z.enum(["delete", "retain"]),
    outputs: z.array(IntegrationBindingContractOutputV1Schema).min(1),
    /** The content-addressed app-env hash (the generation's `desired_state_hash`). */
    appEnvHash: z.string().regex(APP_ENV_HASH),
    status: z.enum(["pending", "ready", "drifted", "needs_attention", "retired"]),
    driftState: z.enum(["unknown", "in_sync", "drifted"]),
  })
  .strict();

export type IntegrationBindingContractV1 = z.infer<typeof IntegrationBindingContractV1Schema>;

/** A binding-contract projection was structurally invalid (fail-closed). */
export class MalformedBindingContractError extends Error {
  public override readonly name = "MalformedBindingContractError";
}

/**
 * Parse + DEEP-FREEZE a binding-contract projection. The returned value is
 * immutable (frozen object, frozen resource, frozen outputs array + entries) —
 * a delivery gate can hold it as an unforgeable descriptor. A structurally
 * invalid projection throws {@link MalformedBindingContractError} (fail-closed).
 */
export function freezeBindingContract(input: unknown): IntegrationBindingContractV1 {
  const parsed = IntegrationBindingContractV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new MalformedBindingContractError(`invalid IntegrationBindingContractV1: ${parsed.error.message}`);
  }
  const contract = parsed.data;
  for (const output of contract.outputs) {
    Object.freeze(output.scopes);
    Object.freeze(output);
  }
  Object.freeze(contract.outputs);
  Object.freeze(contract.resource);
  return Object.freeze(contract);
}
