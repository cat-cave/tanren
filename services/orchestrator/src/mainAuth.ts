/**
 * mainAuth — assembles the orchestrator's identity providers from environment.
 * Extracted from main.ts to keep that file under the 500-line architecture cap.
 * Registers github_oauth / OIDC providers when their env is present, plus the
 * dev-only local_dev escape hatch (opt-in via TANREN_DEV_LOGIN=1, refused
 * outside an explicit non-prod profile — never solely because cookie-secure is off).
 */
import type pg from "pg";
import type { ActorContext, IdentityProviderId } from "./auth/index.js";
import {
  buildOidcProviderFromEnv,
  createDevLoginProvider,
  GitHubOAuthProvider,
  IdentityStore,
  type IdentityProvider,
} from "./auth/index.js";
import { isExplicitDevProfile, parseOrchestratorEnv } from "./envSchema.js";
import { optionalSecretFromFileOrEnv } from "./engine/contracts/secretStoreFactory.js";
import { createLogger } from "./engine/observability/logger.js";

const log = createLogger("auth");

export interface BuildAppAuthOptions {
  store: IdentityStore;
  providers: Map<IdentityProviderId, IdentityProvider>;
  publicBaseUrl: string;
  cookieSecure?: boolean;
  platformAdminUserIds?: ReadonlySet<string>;
  /** When set, requests without a session/token resolve to this actor. Used in tests/dev. */
  localDevActor?: ActorContext;
  /**
   * CANONICAL GitHub App install URL (TANREN_GITHUB_APP_INSTALL_URL). Surfaced on
   * `/auth/providers` so the dashboard reads it from the orchestrator rather than
   * carrying its own env copy.
   */
  githubAppInstallUrl?: string;
}

export function buildAuthFromEnv(pool: pg.Pool, port?: number): BuildAppAuthOptions | undefined {
  // Re-parse the env FRESH at call time (still Zod-validated, still fail-loud) so
  // a caller that adjusted process.env — boot, tests, dev — sees the current
  // values. The module-level `parsedEnv` constant asserts validity at boot for the
  // top-level reads in main.ts; this assembly point reflects the live env.
  const env = parseOrchestratorEnv();
  const resolvedPort = port ?? env.ORCHESTRATOR_PORT;
  const clientId = env.TANREN_GITHUB_OAUTH_CLIENT_ID;
  // The OAuth client SECRET is file-preferred (Codex r5): the prod compose mounts it
  // as `/run/secrets/tanren_github_oauth_client_secret` and sets
  // TANREN_GITHUB_OAUTH_CLIENT_SECRET_FILE, so the secret VALUE never lands in Docker
  // env / `docker inspect` / `/proc/<pid>/environ`. The plaintext
  // TANREN_GITHUB_OAUTH_CLIENT_SECRET env stays a dev convenience (file WINS).
  const clientSecret = optionalSecretFromFileOrEnv(
    process.env,
    "TANREN_GITHUB_OAUTH_CLIENT_SECRET",
    "GitHub OAuth client secret",
  );
  const publicBaseUrl = env.TANREN_PUBLIC_BASE_URL ?? `http://localhost:${resolvedPort}`;
  const providers = new Map<IdentityProviderId, IdentityProvider>();
  if (clientId !== undefined && clientId !== "" && clientSecret !== undefined && clientSecret !== "") {
    providers.set("github_oauth", new GitHubOAuthProvider({ clientId, clientSecret }));
  }
  // Authentik (or any OIDC IdP) as a second identity provider. Additive
  // and opt-in: registers only when issuer + client id/secret are all set, so
  // github_oauth/local_dev behavior is unchanged when the OIDC env is absent.
  const oidc = buildOidcProviderFromEnv();
  if (oidc !== undefined) {
    providers.set("oidc", oidc);
  }
  // DEV-ONLY escape hatch. Opt-in via TANREN_DEV_LOGIN=1 (set only in
  // compose.dev.yml — compose.prod.yml MUST never set it). When enabled it
  // registers a LocalDevProvider so `/auth/login?provider=local_dev` mints a
  // real session against the synthetic dev org, unblocking manual UI testing
  // without a registered GitHub OAuth app. Defaults off → byte-for-byte
  // unchanged behavior. Refused outside an EXPLICIT non-prod profile:
  //   - NODE_ENV=production or TANREN_ENV=prod|production → refuse
  //   - TANREN_COOKIE_SECURE=1 → refuse (defense-in-depth)
  // Cookie-secure-off alone never enables the hatch in a prod-like profile.
  if (env.TANREN_DEV_LOGIN === "1") {
    if (isExplicitDevProfile(env)) {
      providers.set("local_dev", createDevLoginProvider());
    } else {
      log.warn(
        "TANREN_DEV_LOGIN=1 ignored: refusing dev-login escape hatch outside explicit dev profile (NODE_ENV/TANREN_ENV production or TANREN_COOKIE_SECURE=1)",
        {
          NODE_ENV: env.NODE_ENV,
          TANREN_ENV: env.TANREN_ENV,
          TANREN_COOKIE_SECURE: env.TANREN_COOKIE_SECURE,
        },
      );
    }
  }
  if (providers.size === 0) {
    return undefined;
  }
  return {
    store: new IdentityStore(pool),
    providers,
    publicBaseUrl,
    cookieSecure: env.TANREN_COOKIE_SECURE === "1",
    ...(env.TANREN_GITHUB_APP_INSTALL_URL !== undefined && {
      githubAppInstallUrl: env.TANREN_GITHUB_APP_INSTALL_URL,
    }),
  };
}
