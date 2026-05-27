import type { IdentityProvider } from "./identityProvider.js";
import type { IdentityClaims, IdentityProviderId } from "./schemas.js";

export interface LocalDevProviderConfig {
  identity: IdentityClaims;
  authorizeRedirectPath?: string;
}

/**
 * Identity provider used in tests and explicit opt-in dev mode. Returns a fixed identity
 * for any state/code pair. Never enabled in production by default.
 */
export class LocalDevProvider implements IdentityProvider {
  readonly id: IdentityProviderId = "local_dev";

  constructor(private readonly config: LocalDevProviderConfig) {}

  buildAuthorizeUrl(state: string, redirectUri: string): string {
    const callback = new URL(redirectUri);
    callback.searchParams.set("state", state);
    callback.searchParams.set("code", "local-dev");
    return this.config.authorizeRedirectPath ?? callback.toString();
  }

  async exchangeCode(_code: string, _redirectUri: string): Promise<IdentityClaims> {
    return this.config.identity;
  }
}
