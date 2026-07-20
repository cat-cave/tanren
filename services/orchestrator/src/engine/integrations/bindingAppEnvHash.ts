/**
 * in-15: the SINGLE canonical `appEnvHash` — the content-addressed sha256 of a
 * binding's canonical app-env. This is the one hash both the in-14
 * BindingMaterializer records (as `integration_binding_generations.desired_state_hash`)
 * and the in-15 proof gate independently recomputes, so a binding's materialized
 * app-env is provably the exact immutable app-env its generation recorded.
 *
 * The hash covers the binding lineage (provider / connection / auth+grant
 * generations / adapter / external resource / ownership / teardown / environment)
 * and, per output key, its classification, required flag, phase scopes, and a
 * DIGEST of the resolved value material. It NEVER embeds a plaintext value or a
 * secret — only per-value sha256 digests — so a rotated secret or a changed config
 * value changes the hash (tamper-evident) while identical content is idempotent.
 */

import { createHash } from "node:crypto";
import { canonicalJson, type CanonicalBody } from "../contracts/cas.js";

/** Binding-generation lineage that binds the app-env hash to one exact generation. */
export interface BindingAppEnvLineage {
  readonly providerKind: string;
  readonly connectionId: string;
  readonly authGeneration: number;
  readonly grantId: string;
  readonly grantGeneration: number;
  readonly adapterVersion: string;
  readonly externalResourceId: string;
  readonly externalResourceName: string;
  readonly ownership: string;
  readonly teardownPolicy: string;
  readonly environment: string;
}

/** One output key's canonical contribution — a value DIGEST, never the value. */
export interface CanonicalAppEnvOutput {
  readonly key: string;
  readonly secret: boolean;
  readonly required: boolean;
  readonly scopes: readonly string[];
  /** sha256 hex (no `sha256:` prefix) of this key's resolved value material. */
  readonly valueDigest: string;
}

/** sha256 hex digest of a value (the per-value digest the app-env hash embeds). */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The canonical `appEnvHash` — `sha256:<64 hex>` over the key-sorted lineage +
 * per-key output digests. Deterministic: identical binding + identical resolved
 * values always yield the same hash; any changed value or lineage field yields a
 * different one.
 */
export function computeBindingAppEnvHash(
  lineage: BindingAppEnvLineage,
  outputs: readonly CanonicalAppEnvOutput[],
): string {
  const normalizedOutputs = [...outputs]
    .map((output) => ({
      key: output.key,
      secret: output.secret,
      required: output.required,
      scopes: [...output.scopes].sort(),
      valueDigest: output.valueDigest,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const body: CanonicalBody = {
    providerKind: lineage.providerKind,
    connectionId: lineage.connectionId,
    authGeneration: lineage.authGeneration,
    grantId: lineage.grantId,
    grantGeneration: lineage.grantGeneration,
    adapterVersion: lineage.adapterVersion,
    externalResourceId: lineage.externalResourceId,
    externalResourceName: lineage.externalResourceName,
    ownership: lineage.ownership,
    teardownPolicy: lineage.teardownPolicy,
    environment: lineage.environment,
    outputs: normalizedOutputs,
  } as unknown as CanonicalBody;
  return `sha256:${sha256Hex(canonicalJson(body))}`;
}
