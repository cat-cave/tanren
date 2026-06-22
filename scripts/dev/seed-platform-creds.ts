// Hosting/boot seeder for PLATFORM-scoped secret-store refs.
//
// This is the deploy-layer's job, deliberately SEPARATE from the userland
// credential routes (`routes/credentials/index.ts`, which write only
// tenant-namespaced refs `credential/<kind>/org/<org>/...` and by design CANNOT
// write `platform/`-scoped refs). A platform/hosting credential — the SaaS
// managed-LLM router key every tenant routes THROUGH under
// `providerMode: managed` — is provisioned by the hosting layer, not by a
// tenant. Vault is the system's secret store; a fresh stack (`down-dev -v` wipes
// the dev Vault) leaves the platform ref UNSEEDED, and managed mode then
// HARD-FAILS at `resolveRawProviderKey` (correctly — no silent fallback). This
// seeder is the sanctioned, repeatable way to (re)seed those platform refs.
//
// What it seeds today: the managed-router key at
// `DEFAULT_MANAGED_CREDENTIAL_REF` (`credential/openrouter/platform/default`) —
// the ONE platform-scoped entry the validation manifest declares (the manifest's
// other connectors are tenant-scoped `home: managed`/org creds that flow through
// the operator credential API, NOT this seeder).
//
// Contract:
//   - Reads the key from `TANREN_E2E_MANAGED_ROUTER_KEY` (the same env var the
//     validation manifest's `managed-router` connector points at).
//   - FAIL-LOUD if that env var is absent/blank (no silent skip).
//   - Writes ONLY platform-scoped refs (never a tenant route).
//   - Idempotent: `SecretStore.put` upserts, so re-running re-seeds the same ref.
//   - Never logs the secret VALUE (only the ref it wrote to).
//
// Invoked via `just seed-platform-creds` (and folded into `just up-dev`).

import {
  buildSecretStore,
  type SecretStoreEnv,
} from "../../services/orchestrator/src/engine/contracts/secretStoreFactory.js";
import { DEFAULT_MANAGED_CREDENTIAL_REF } from "../../services/orchestrator/src/engine/config/managedProvider.js";
import type { SecretStore } from "../../services/orchestrator/src/engine/contracts/secretStore.js";

/** The env var the managed-router key is read from (matches the manifest). */
export const MANAGED_ROUTER_KEY_ENV = "TANREN_E2E_MANAGED_ROUTER_KEY";

/** One platform-scoped ref to seed: the secret-store ref + the env var its
 * value is read from. Add a sibling here only for ANOTHER platform-scoped ref
 * (never a tenant cred — those stay on the operator credential API). */
interface PlatformRefSpec {
  ref: string;
  env: string;
  description: string;
}

const PLATFORM_REFS: readonly PlatformRefSpec[] = [
  {
    ref: DEFAULT_MANAGED_CREDENTIAL_REF,
    env: MANAGED_ROUTER_KEY_ENV,
    description: "managed-LLM platform router key (providerMode: managed)",
  },
];

function requireEnv(env: SecretStoreEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `seed-platform-creds: required env var ${name} is missing or blank — refusing to seed a platform credential to an empty value. ` +
        `Set it (e.g. from .env.validation.local / the connections manifest) and re-run.`,
    );
  }
  return value.trim();
}

/**
 * Seed every platform-scoped ref into the configured SecretStore. Idempotent
 * (upsert). FAIL-LOUD on a missing env var BEFORE writing anything, so a partial
 * env never leaves the platform half-seeded. Returns the refs it wrote (never
 * the values) for the caller to report.
 */
export async function seedPlatformCredentials(
  secrets: SecretStore,
  env: SecretStoreEnv = process.env,
): Promise<string[]> {
  // Resolve every value first so a missing env var fails before any write.
  const resolved = PLATFORM_REFS.map((spec) => ({ spec, value: requireEnv(env, spec.env) }));
  const written: string[] = [];
  for (const { spec, value } of resolved) {
    await secrets.put({ ref: spec.ref, value });
    written.push(spec.ref);
  }
  return written;
}

async function main(): Promise<void> {
  const secrets = buildSecretStore(process.env);
  const written = await seedPlatformCredentials(secrets, process.env);
  for (const ref of written) {
    // Ref only — NEVER the value.
    console.log(`seed-platform-creds: seeded platform ref ${ref}`);
  }
  console.log(`seed-platform-creds: done (${written.length} platform ref(s))`);
}

// Run as a script (not when imported by a test). `import.meta.url` ends with this
// file's path when invoked directly via tsx.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
