// Resolve the worker's RUNNER SSH IDENTITY from the environment — both the secret
// REF the identity is stored under and the mounted-file seeding of the key material.
//
// SECURITY BOUNDARY: the runner identity is the SSH private key the worker (and the
// API) use to reach runners. Two env reads govern it, and BOTH are fail-closed:
//
//   - TANREN_RUNNER_IDENTITY_SECRET_REF (the ref): resolved through the SHARED parsed
//     env contract (`parseOrchestratorEnv` → `emptyToUndefined` + `.min(1)` + default),
//     NEVER a raw `process.env[...] ?? default`. A raw `??` only catches null/undefined,
//     so a BLANK `""` would slip through and become the live secret ref. Routing through
//     the schema makes a blank/unset ref fail-closed to the validated default and a
//     malformed ref crash boot — never a silent `""`.
//   - TANREN_RUNNER_IDENTITY_KEY_PATH (the key material): the SSH PRIVATE key is
//     delivered as a MOUNTED SECRET FILE, never a plaintext env VALUE, so the key
//     never lands in `docker inspect` / container env. A no-op when unset (the API may
//     have already seeded the shared store, or the secret is Vault-seeded out of band).
//
// Mirrors main.ts's identity wiring so the standalone worker is self-contained.

import { readFile } from "node:fs/promises";
import { parseOrchestratorEnv } from "../../envSchema.js";
import type { SecretStore } from "../contracts/index.js";

/**
 * Resolve the runner-identity secret REF through the boot-time env schema. A blank
 * or unset `TANREN_RUNNER_IDENTITY_SECRET_REF` fails-closed to the schema default
 * (`runner/local-docker/identity`) — never a silent `""`. A fresh parse (not the
 * module-frozen `parsedEnv`) so a per-process custom ref is honored at boot time.
 */
export function resolveRunnerIdentitySecretRef(): string {
  return parseOrchestratorEnv(process.env).TANREN_RUNNER_IDENTITY_SECRET_REF;
}

/**
 * Seed the runner SSH PRIVATE identity into the secret store (the same Vault the
 * API uses) from the MOUNTED SECRET FILE at `TANREN_RUNNER_IDENTITY_KEY_PATH`. A
 * no-op when the path is unset/blank.
 */
export async function seedRunnerIdentitySecret(secrets: SecretStore, ref: string): Promise<void> {
  const keyPath = process.env["TANREN_RUNNER_IDENTITY_KEY_PATH"];
  if (keyPath !== undefined && keyPath !== "") {
    await secrets.put({ ref, value: await readFile(keyPath, "utf8") });
  }
}
