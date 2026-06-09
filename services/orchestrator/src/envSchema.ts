/**
 * envSchema — the orchestrator's SINGLE boot-time environment contract.
 *
 * Doctrine (no-silent-fallback + three-layer config): every numeric / boolean /
 * URL platform knob the boot path reads is validated HERE, once, at module load,
 * via Zod. A malformed value (a non-numeric port, an out-of-range port, a bad URL,
 * a bool flag that is neither "0" nor "1") FAILS LOUD at boot — the process never
 * starts on a quietly-coerced default. The per-site `Number(process.env[...] ?? n)`
 * reads in main.ts / mainAuth.ts / internalServer.ts are replaced by `parsedEnv.X`.
 *
 * This file is the ONLY place in the orchestrator's boot path that reads these
 * `TANREN_*` / port env vars directly — enforced by scripts/lint/env-read-whitelist.mjs.
 * REQUIRED-at-point-of-use secrets that must fail loud when MISSING (VAULT_TOKEN,
 * MIGRATION_DATABASE_URL, the runner identity key material) stay on their existing
 * `requireEnv`/`required` guards — those are resolved lazily at USE, not at load,
 * so importing this module for `buildApp` tests needs no production secret env.
 */
import { z } from "zod";

/** A TCP port: coerced from the env string, finite integer, 1–65535. */
const portSchema = z.coerce.number().int().finite().min(1).max(65_535);

/** A boolean feature flag expressed as the literal "0" / "1" env convention. */
const boolFlagSchema = z.enum(["0", "1"]);

/**
 * The orchestrator boot env contract. Optional fields stay optional so a minimal
 * test env (and the in-process dev path) parses cleanly; the loud failures are
 * reserved for MALFORMED present values (a non-numeric port, an out-of-range
 * port, a non-URL public base, an unrecognized bool flag).
 */
const envObjectSchema = z.object({
  // Public API HTTP port (plain HTTP). Default 3100.
  ORCHESTRATOR_PORT: portSchema.default(3100),
  // Vault address the boot health check + minter dial. Default localhost dev addr.
  VAULT_ADDR: z.string().url().default("http://localhost:8200"),
  // The secret ref the boot seeder stores the runner SSH identity under.
  TANREN_RUNNER_IDENTITY_SECRET_REF: z.string().min(1).default("runner/local-docker/identity"),
  // GitHub OAuth app credentials — the github_oauth identity provider registers
  // only when BOTH are present + non-blank (mainAuth.ts).
  TANREN_GITHUB_OAUTH_CLIENT_ID: z.string().optional(),
  TANREN_GITHUB_OAUTH_CLIENT_SECRET: z.string().optional(),
  // CANONICAL orchestrator public base URL — the OAuth redirect_uri base AND the
  // base the dashboard's App-install href is built from. (Collapsed from the old
  // TANREN_ORCHESTRATOR_PUBLIC_URL dashboard name.) Validated as a URL when present.
  TANREN_PUBLIC_BASE_URL: z.string().url().optional(),
  // DEV-ONLY local_dev escape hatch + prod-like cookie-secure guard ("0"/"1").
  TANREN_DEV_LOGIN: boolFlagSchema.optional(),
  TANREN_COOKIE_SECURE: boolFlagSchema.optional(),
  // Internal control-plane mTLS listener port. Default 3110.
  TANREN_INTERNAL_MTLS_PORT: portSchema.default(3110),
  // Internal mTLS cert material paths — the listener starts only when all three
  // are present (internalServer.ts). File paths, not URLs.
  TANREN_INTERNAL_TLS_CERT: z.string().optional(),
  TANREN_INTERNAL_TLS_KEY: z.string().optional(),
  TANREN_INTERNAL_TLS_CA: z.string().optional(),
  // CANONICAL GitHub App install URL (collapsed from the dashboard's old
  // TANREN_GITHUB_APP_URL name). Surfaced to the dashboard via /auth/providers.
  TANREN_GITHUB_APP_INSTALL_URL: z.string().url().optional(),
});

export type OrchestratorEnv = z.infer<typeof envObjectSchema>;

/** Parse `source` (defaults to process.env), throwing a LOUD aggregate on failure. */
export function parseOrchestratorEnv(source: NodeJS.ProcessEnv = process.env): OrchestratorEnv {
  const result = envObjectSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid orchestrator environment (fail-closed at boot):\n${issues}`);
  }
  return result.data;
}

/**
 * The validated env, parsed ONCE at module load. Importing this module asserts the
 * env is well-formed; a malformed value crashes the boot here, by design.
 */
export const parsedEnv: OrchestratorEnv = parseOrchestratorEnv();
