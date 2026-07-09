/**
 * envSchema — the dashboard's SINGLE boot-time environment contract.
 *
 * Doctrine (no-silent-fallback + three-layer config): every numeric / boolean /
 * URL platform knob the boot path reads is validated HERE, once per `createApp`
 * (and at the CLI entry), via Zod. A malformed value FAILS LOUD at boot.
 *
 * Auth fail-closed (CX-006/007/CHK-052):
 *   - In a prod-like profile (`NODE_ENV=production` or `TANREN_ENV=prod|production`),
 *     `ORCHESTRATOR_URL` is required and `TANREN_REQUIRE_AUTH` defaults ON when
 *     unset. Explicit `TANREN_REQUIRE_AUTH=0` remains the opt-out (e2e smoke).
 *   - `TANREN_DEV_LOGIN=1` is honored only inside an explicit non-prod profile —
 *     never solely because `TANREN_COOKIE_SECURE` is off.
 *
 * This file is the intended home for dashboard boot env reads (see
 * scripts/lint/env-read-whitelist.mjs). Compose flags are documented in
 * docs/operator-guide/auth.md and `.env.example`.
 */
import { z } from "zod";

/**
 * Treat an EMPTY env string as UNSET (`undefined`) before validation — compose
 * `${VAR:-}` materializes unset as `""`, not an absent key.
 */
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema);

const portSchema = z.coerce.number().int().finite().min(1).max(65_535);
const boolFlagSchema = z.enum(["0", "1"]);

const envObjectSchema = z.object({
  // Dashboard HTTP listen port. Default 3000.
  DASHBOARD_PORT: emptyToUndefined(portSchema.default(3000)),
  // Orchestrator base the BFF + shell dial. Required in prod; localhost default in dev.
  ORCHESTRATOR_URL: emptyToUndefined(z.string().url().optional()),
  // Auth gate ("0"/"1"). Unset → fail-closed ON in prod, OFF otherwise.
  TANREN_REQUIRE_AUTH: emptyToUndefined(boolFlagSchema.optional()),
  // DEV-ONLY local_dev escape hatch ("0"/"1"). Refused outside explicit dev profile.
  TANREN_DEV_LOGIN: emptyToUndefined(boolFlagSchema.optional()),
  // Prod-like cookie marker (set on the orchestrator in prod). When "1", dev-login
  // is refused even if NODE_ENV is unset — defense-in-depth, never the sole gate.
  TANREN_COOKIE_SECURE: emptyToUndefined(boolFlagSchema.optional()),
  // Node runtime mode. `production` is a prod-profile marker.
  NODE_ENV: emptyToUndefined(z.string().optional()),
  // Optional explicit profile override (prod | production | dev | development).
  TANREN_ENV: emptyToUndefined(z.string().optional()),
});

type RawDashboardEnv = z.infer<typeof envObjectSchema>;

export interface DashboardEnv {
  DASHBOARD_PORT: number;
  ORCHESTRATOR_URL: string;
  /** Effective auth gate after fail-closed resolution. */
  requireAuth: boolean;
  /** Effective dev-login after explicit-dev-profile gate. */
  devLoginEnabled: boolean;
  /** True when NODE_ENV=production or TANREN_ENV is a prod token. */
  isProdProfile: boolean;
  NODE_ENV: string | undefined;
  TANREN_ENV: string | undefined;
  TANREN_REQUIRE_AUTH: "0" | "1" | undefined;
  TANREN_DEV_LOGIN: "0" | "1" | undefined;
  TANREN_COOKIE_SECURE: "0" | "1" | undefined;
}

/** Prod-like profile markers (fail-closed auth + required ORCHESTRATOR_URL). */
export function isProdProfile(source: { NODE_ENV?: string | undefined; TANREN_ENV?: string | undefined }): boolean {
  if (source.NODE_ENV === "production") {
    return true;
  }
  const profile = (source.TANREN_ENV ?? "").toLowerCase();
  return profile === "prod" || profile === "production";
}

/**
 * Explicit non-prod profile required for TANREN_DEV_LOGIN.
 *
 * Positive markers only — "unset profile + cookie-secure off" is NOT enough
 * (a misconfigured prod that left NODE_ENV blank must never enable the hatch
 * solely because TANREN_COOKIE_SECURE is off). COOKIE_SECURE=1 is an extra refuse.
 *
 * Accepted explicit markers:
 *   - NODE_ENV in {development, dev, test}
 *   - TANREN_ENV in {dev, development, test}
 */
export function isExplicitDevProfile(source: {
  NODE_ENV?: string | undefined;
  TANREN_ENV?: string | undefined;
  TANREN_COOKIE_SECURE?: string | undefined;
}): boolean {
  if (isProdProfile(source)) {
    return false;
  }
  if (source.TANREN_COOKIE_SECURE === "1") {
    return false;
  }
  const node = (source.NODE_ENV ?? "").toLowerCase();
  if (node === "development" || node === "dev" || node === "test") {
    return true;
  }
  const profile = (source.TANREN_ENV ?? "").toLowerCase();
  if (profile === "dev" || profile === "development" || profile === "test") {
    return true;
  }
  return false;
}

/** Resolve require-auth: explicit flag wins; unset fail-closes ON in prod. */
export function resolveRequireAuth(flag: "0" | "1" | undefined, prodProfile: boolean): boolean {
  if (flag === "1") {
    return true;
  }
  if (flag === "0") {
    return false;
  }
  return prodProfile;
}

/** Resolve dev-login: flag AND explicit non-prod profile. */
export function resolveDevLoginEnabled(source: {
  TANREN_DEV_LOGIN?: string | undefined;
  NODE_ENV?: string | undefined;
  TANREN_ENV?: string | undefined;
  TANREN_COOKIE_SECURE?: string | undefined;
}): boolean {
  return source.TANREN_DEV_LOGIN === "1" && isExplicitDevProfile(source);
}

const DEV_DEFAULT_ORCHESTRATOR_URL = "http://localhost:3100";

/** Parse `source` (defaults to process.env), throwing a LOUD aggregate on failure. */
export function parseDashboardEnv(source: NodeJS.ProcessEnv = process.env): DashboardEnv {
  const result = envObjectSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid dashboard environment (fail-closed at boot):\n${issues}`);
  }
  const raw: RawDashboardEnv = result.data;
  const prodProfile = isProdProfile(raw);
  const orchestratorUrl = raw.ORCHESTRATOR_URL ?? (prodProfile ? undefined : DEV_DEFAULT_ORCHESTRATOR_URL);
  if (orchestratorUrl === undefined) {
    throw new Error(
      "Invalid dashboard environment (fail-closed at boot):\n  ORCHESTRATOR_URL: required in production profiles (NODE_ENV=production or TANREN_ENV=prod|production)",
    );
  }
  return {
    DASHBOARD_PORT: raw.DASHBOARD_PORT,
    ORCHESTRATOR_URL: orchestratorUrl,
    requireAuth: resolveRequireAuth(raw.TANREN_REQUIRE_AUTH, prodProfile),
    devLoginEnabled: resolveDevLoginEnabled(raw),
    isProdProfile: prodProfile,
    NODE_ENV: raw.NODE_ENV,
    TANREN_ENV: raw.TANREN_ENV,
    TANREN_REQUIRE_AUTH: raw.TANREN_REQUIRE_AUTH,
    TANREN_DEV_LOGIN: raw.TANREN_DEV_LOGIN,
    TANREN_COOKIE_SECURE: raw.TANREN_COOKIE_SECURE,
  };
}
