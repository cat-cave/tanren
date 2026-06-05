/**
 * mainAuth — assembles the orchestrator's identity providers from environment.
 * Extracted from main.ts to keep that file under the 500-line architecture cap.
 * Registers github_oauth / OIDC providers when their env is present, plus the
 * dev-only local_dev escape hatch (opt-in via TANREN_DEV_LOGIN=1, refused under
 * a prod-like cookie-secure context).
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

export interface BuildAppAuthOptions {
  store: IdentityStore;
  providers: Map<IdentityProviderId, IdentityProvider>;
  publicBaseUrl: string;
  cookieSecure?: boolean;
  platformAdminUserIds?: ReadonlySet<string>;
  /** When set, requests without a session/token resolve to this actor. Used in tests/dev. */
  localDevActor?: ActorContext;
}

export function buildAuthFromEnv(
  pool: pg.Pool,
  port: number = Number(process.env["ORCHESTRATOR_PORT"] ?? 3100),
): BuildAppAuthOptions | undefined {
  const clientId = process.env["TANREN_GITHUB_OAUTH_CLIENT_ID"];
  const clientSecret = process.env["TANREN_GITHUB_OAUTH_CLIENT_SECRET"];
  const publicBaseUrl = process.env["TANREN_PUBLIC_BASE_URL"] ?? `http://localhost:${port}`;
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
  // unchanged behavior. Refused (with a loud warning, flag ignored) under a
  // prod-like cookie-secure context as a defense-in-depth guard.
  if (process.env["TANREN_DEV_LOGIN"] === "1") {
    if (process.env["TANREN_COOKIE_SECURE"] === "1") {
      console.warn(
        "[auth] TANREN_DEV_LOGIN=1 ignored: refusing dev-login escape hatch under TANREN_COOKIE_SECURE=1 (prod-like context)",
      );
    } else {
      providers.set("local_dev", createDevLoginProvider());
    }
  }
  if (providers.size === 0) {
    return undefined;
  }
  return {
    store: new IdentityStore(pool),
    providers,
    publicBaseUrl,
    cookieSecure: process.env["TANREN_COOKIE_SECURE"] === "1",
  };
}
