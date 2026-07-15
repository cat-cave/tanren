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
// PORTABILITY: the managed-router key is resolved through a PORTABLE precedence
// (see `resolveSeedSecrets` below) — exported env > `TANREN_SECRET_ENV_FILE` >
// the plaintext-local `.env.validation.local`. Tanren stays agnostic to WHO
// produces the env-file (sops / 1Password / Vault-agent / …); it only reads a
// fixed ALLOWLIST of known keys from whatever file is pointed at, never blindly
// exporting arbitrary vars. There is NO dependency on Nix, sops, or any
// machine-specific path.
//
// Contract:
//   - Resolves the key via the portable precedence above.
//   - FAIL-LOUD if no source yields a key — a typed `MissingSeedSecretError`
//     naming all three sources tried (no silent skip).
//   - Writes ONLY platform-scoped refs (never a tenant route).
//   - Idempotent: `SecretStore.put` upserts, so re-running re-seeds the same ref.
//   - Never logs the secret VALUE (only the ref it wrote to).
//
// Invoked via `just seed-platform-creds` (and folded into `just up-dev`).

import { readFileSync } from "node:fs";

import {
  buildSecretStore,
  type SecretStoreEnv,
} from "../../services/orchestrator/src/engine/contracts/secretStoreFactory.js";
import { DEFAULT_MANAGED_CREDENTIAL_REF } from "../../services/orchestrator/src/engine/config/managedProvider.js";
import type { SecretStore } from "../../services/orchestrator/src/engine/contracts/secretStore.js";

/** The env var the managed-router key is read from (matches the manifest). */
export const MANAGED_ROUTER_KEY_ENV = "TANREN_E2E_MANAGED_ROUTER_KEY";

/** Env var naming a secure env-file (rendered by ANY secret manager) to source
 * seed secrets from when they are not already exported. Tanren is agnostic to
 * the producer — it only reads a fixed allowlist of known keys from the file. */
export const SECRET_ENV_FILE_ENV = "TANREN_SECRET_ENV_FILE";

/** Default plaintext-local fallback env-file (0600, `~/.config/tanren/secrets/`
 * symlinked into cwd by `just secrets-link`). Backwards-compatible source of
 * last resort — used only when neither exported env nor an env-file provides
 * the key. */
export const LOCAL_FALLBACK_ENV_FILE = ".env.validation.local";

/**
 * The FIXED ALLOWLIST of secret keys this seeder may load from an external
 * env-file (`TANREN_SECRET_ENV_FILE` or the local fallback). Only these keys are
 * ever read out of a file into the process; every other key in the file is
 * IGNORED — the seeder never blindly exports arbitrary vars from a file it is
 * pointed at. Add a key here only if a new platform ref legitimately needs it.
 */
export const SEED_SECRET_ALLOWLIST: readonly string[] = [MANAGED_ROUTER_KEY_ENV];

/** One platform-scoped ref to seed: the secret-store ref + the env var its
 * value is read from. Add a sibling here only for ANOTHER platform-scoped ref
 * (never a tenant cred — those stay on the operator credential API). Any env
 * key referenced here must also be in `SEED_SECRET_ALLOWLIST`. */
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

/** Typed, loud error for the "no source yielded a key" case — names every
 * source tried so an operator knows exactly where to put the key. */
export class MissingSeedSecretError extends Error {
  readonly key: string;
  constructor(key: string, envFilePath: string | undefined) {
    const sources = [
      `exported env ($${key})`,
      envFilePath === undefined
        ? `$${SECRET_ENV_FILE_ENV} (unset — point it at a secure env-file to use)`
        : `$${SECRET_ENV_FILE_ENV}=${envFilePath}`,
      `${LOCAL_FALLBACK_ENV_FILE} (plaintext-local fallback)`,
    ];
    super(
      `seed-platform-creds: could not resolve ${key} from any source — refusing to seed a platform credential to an empty value. ` +
        `Tried, in precedence order: ${sources.join(" -> ")}. ` +
        `Set the key in one of these (export it, point ${SECRET_ENV_FILE_ENV} at a secure env-file produced by any secret manager, or place it in ${LOCAL_FALLBACK_ENV_FILE}) and re-run.`,
    );
    this.name = "MissingSeedSecretError";
    this.key = key;
  }
}

/**
 * Parse a dotenv-style file, returning ONLY the allowlisted keys with non-blank
 * values. Defensive by design:
 *   - skips blank lines and `#` comments;
 *   - handles `KEY=value`, `export KEY=value`, and surrounding whitespace;
 *   - strips a single matched pair of surrounding single OR double quotes;
 *   - IGNORES any key not in `allowlist` (never exports arbitrary vars);
 *   - single-line values only (matches Tanren's .env files);
 *   - a missing/unreadable file yields an empty map (caller falls through).
 * Never throws on a malformed line — a malformed line is skipped, not fatal.
 */
export function parseAllowlistedEnvFile(path: string, allowlist: readonly string[]): Record<string, string> {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return {};
  }
  const allow = new Set(allowlist);
  const out: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    // Strip an optional leading `export ` (dotenv files sometimes carry it).
    const line = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    // ALLOWLIST gate — ignore any key not on the allowlist.
    if (!allow.has(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    // A blank value is treated as unset (not an empty-string key).
    if (value.trim() === "") continue;
    out[key] = value;
  }
  return out;
}

/**
 * Resolve every allowlisted seed secret through the PORTABLE precedence:
 *   1. already exported in `env` (non-blank) → highest precedence;
 *   2. else `TANREN_SECRET_ENV_FILE=<path>` → load the allowlisted keys from it;
 *   3. else the plaintext-local `.env.validation.local` fallback.
 * Returns only keys that resolved to a non-blank value. Reads NOTHING outside
 * the allowlist from any file. Pure w.r.t. `process.env` — never mutates it.
 *
 * `readFile` is injectable for tests; defaults to the real allowlisted parser.
 */
export function resolveSeedSecrets(
  env: SecretStoreEnv,
  allowlist: readonly string[] = SEED_SECRET_ALLOWLIST,
  readFile: (path: string, allow: readonly string[]) => Record<string, string> = parseAllowlistedEnvFile,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const key of allowlist) {
    const exported = env[key];
    if (typeof exported === "string" && exported.trim() !== "") {
      resolved[key] = exported.trim();
    } else {
      unresolved.push(key);
    }
  }

  // File reads are lazy by precedence. An explicitly injected credential (the
  // exact-stack nonce sentinel) must prevent even an attempted access to local
  // validation material, not merely win after that material was read.
  if (unresolved.length === 0) return resolved;
  const envFilePath = typeof env[SECRET_ENV_FILE_ENV] === "string" ? env[SECRET_ENV_FILE_ENV]!.trim() : "";
  const fromEnvFile = envFilePath === "" ? {} : readFile(envFilePath, unresolved);
  const stillUnresolved: string[] = [];
  for (const key of unresolved) {
    const value = fromEnvFile[key];
    if (value !== undefined && value.trim() !== "") resolved[key] = value.trim();
    else stillUnresolved.push(key);
  }
  if (stillUnresolved.length === 0) return resolved;
  const local = readFile(LOCAL_FALLBACK_ENV_FILE, stillUnresolved);
  for (const key of stillUnresolved) {
    const value = local[key];
    if (value !== undefined && value.trim() !== "") resolved[key] = value.trim();
  }
  return resolved;
}

/**
 * Seed every platform-scoped ref into the configured SecretStore. Idempotent
 * (upsert). Resolves each ref's value through the portable precedence FIRST so a
 * missing key fails (typed `MissingSeedSecretError`) BEFORE any write — a
 * partial env never leaves the platform half-seeded. Returns the refs it wrote
 * (never the values) for the caller to report.
 */
export async function seedPlatformCredentials(
  secrets: SecretStore,
  env: SecretStoreEnv = process.env,
): Promise<string[]> {
  const secretsMap = resolveSeedSecrets(env);
  const envFilePathRaw = env[SECRET_ENV_FILE_ENV];
  const envFilePath =
    typeof envFilePathRaw === "string" && envFilePathRaw.trim() !== "" ? envFilePathRaw.trim() : undefined;

  // Resolve every value first so a missing key fails before any write.
  const resolved = PLATFORM_REFS.map((spec) => {
    const value = secretsMap[spec.env];
    if (value === undefined) {
      throw new MissingSeedSecretError(spec.env, envFilePath);
    }
    return { spec, value };
  });

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
