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

/**
 * Treat an EMPTY env string as UNSET (`undefined`) before validation.
 *
 * Tanren's own compose files pass through optional host env with the
 * `${VAR:-}` convention, which materializes an UNSET var as the empty
 * string `""` inside the container — NOT as an absent key. Without this,
 * `.optional()` / `.url()` / the `"0"|"1"` enum would reject `""` and crash
 * boot for a var the dev/smoke path legitimately leaves unset. Coercing `""`
 * → `undefined` makes "unset" behave as unset (default applies / field stays
 * optional) while a genuinely-MALFORMED present value (`port=abc`,
 * `flag=yes`, a non-URL base) still fails loud. Non-string input passes
 * through untouched.
 */
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema);

/**
 * The orchestrator boot env contract. Optional fields stay optional so a minimal
 * test env (and the in-process dev path) parses cleanly; the loud failures are
 * reserved for MALFORMED present values (a non-numeric port, an out-of-range
 * port, a non-URL public base, an unrecognized bool flag).
 *
 * EVERY field is wrapped in `emptyToUndefined` AS THE OUTERMOST modifier — so the
 * `""`→unset coercion runs BEFORE the `.optional()`/`.default()` decision (an
 * `""` from compose's `${VAR:-}` thus applies the default / stays optional rather
 * than reaching the inner validator and crashing).
 */
const portSchema = z.coerce.number().int().finite().min(1).max(65_535);
const boolFlagSchema = z.enum(["0", "1"]);
const envObjectSchema = z.object({
  // Public API HTTP port (plain HTTP). Default 3100.
  ORCHESTRATOR_PORT: emptyToUndefined(portSchema.default(3100)),
  // Vault address the boot health check + minter dial. Default localhost dev addr.
  VAULT_ADDR: emptyToUndefined(z.string().url().default("http://localhost:8200")),
  // The secret ref the boot seeder stores the runner SSH identity under.
  TANREN_RUNNER_IDENTITY_SECRET_REF: emptyToUndefined(z.string().min(1).default("runner/local-docker/identity")),
  // GitHub OAuth app credentials — the github_oauth identity provider registers
  // only when BOTH are present + non-blank (mainAuth.ts).
  TANREN_GITHUB_OAUTH_CLIENT_ID: emptyToUndefined(z.string().optional()),
  TANREN_GITHUB_OAUTH_CLIENT_SECRET: emptyToUndefined(z.string().optional()),
  // CANONICAL orchestrator public base URL — the OAuth redirect_uri base AND the
  // base the dashboard's App-install href is built from. (Collapsed from the old
  // TANREN_ORCHESTRATOR_PUBLIC_URL dashboard name.) Validated as a URL when present.
  TANREN_PUBLIC_BASE_URL: emptyToUndefined(z.string().url().optional()),
  // DEV-ONLY local_dev escape hatch + prod-like cookie-secure guard ("0"/"1").
  TANREN_DEV_LOGIN: emptyToUndefined(boolFlagSchema.optional()),
  TANREN_COOKIE_SECURE: emptyToUndefined(boolFlagSchema.optional()),
  // Internal control-plane mTLS listener port. Default 3110.
  TANREN_INTERNAL_MTLS_PORT: emptyToUndefined(portSchema.default(3110)),
  // Internal mTLS cert material paths — the listener starts only when all three
  // are present (internalServer.ts). File paths, not URLs.
  TANREN_INTERNAL_TLS_CERT: emptyToUndefined(z.string().optional()),
  TANREN_INTERNAL_TLS_KEY: emptyToUndefined(z.string().optional()),
  TANREN_INTERNAL_TLS_CA: emptyToUndefined(z.string().optional()),
  // CANONICAL GitHub App install URL (collapsed from the dashboard's old
  // TANREN_GITHUB_APP_URL name). Surfaced to the dashboard via /auth/providers.
  TANREN_GITHUB_APP_INSTALL_URL: emptyToUndefined(z.string().url().optional()),
  // Opt-in to fly's NON-merge-reflecting static-image deploy ("0"/"1", default
  // "0" = refuse). Fly releases a static image and ignores the merged source, so
  // it cannot prove "the live product reflects this merge"; the flyDeployProvisioner
  // fails LOUD unless this is "1" (apex must use `deploy.vercel`).
  TANREN_ALLOW_FLY_STATIC_DEPLOY: emptyToUndefined(boolFlagSchema.default("0")),
  // APEX / AUTONOMOUS mode ("0"/"1", default "0" = off). When on, apex mode
  // self-configures the autonomy-loop policy DEFAULTS the live run needs (the
  // autonomous audit posture + the lowered CI-flaky recurrence bar) and arms the
  // notification-readiness guard. Read live (not the frozen `parsedEnv`) via
  // `engine/config/apexMode.ts` so a per-process toggle takes effect without a reparse.
  TANREN_APEX_MODE: emptyToUndefined(boolFlagSchema.default("0")),
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
