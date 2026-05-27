import { IdentityProviderError, type IdentityProvider } from "./identityProvider.js";
import type { IdentityClaims, IdentityProviderId } from "./schemas.js";

/**
 * OIDC provider stub. Phase 2A defines the extension contract for OIDC (Authentik first);
 * the production provider is wired in a later phase. This stub exists to exercise the
 * IdentityProvider interface from tests and to ensure callers handle the configured-but-not-wired
 * case explicitly.
 */
export interface OidcProviderConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export class OidcProvider implements IdentityProvider {
  readonly id: IdentityProviderId = "oidc";

  constructor(readonly config: OidcProviderConfig) {}

  buildAuthorizeUrl(_state: string, _redirectUri: string): string {
    throw new IdentityProviderError(this.id, "OIDC provider is not yet wired in this build", 501);
  }

  async exchangeCode(_code: string, _redirectUri: string): Promise<IdentityClaims> {
    throw new IdentityProviderError(this.id, "OIDC provider is not yet wired in this build", 501);
  }
}
